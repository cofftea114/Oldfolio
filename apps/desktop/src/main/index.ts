import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, session, shell } from 'electron';
import { CreatorSourceResolver, IngestionPipeline, RssSourceConnector, YouTubeDataApiConnector } from '@oldfolio/ingest';
import {
  MediaDeviceConfigStore,
  MediaJobStore,
  importLocalModel,
  parseSynthesisTranscriptPath,
  parseTranscriptPlaybackManifest,
  probeMediaTools,
} from '@oldfolio/media';
import { extractMarkdownMetadata, VaultNotFoundError, VaultRepository } from '@oldfolio/vault';
import { SUMMARY_TEMPLATES } from '@oldfolio/ai';
import { AIDeviceConfigStore } from './ai-device-config.js';
import { AISummaryService, createLocalAIProviderResolver } from './ai-summary.js';
import { AIWikiChatService } from './ai-wiki-chat.js';
import { importCaptionFile } from './caption-import.js';
import { DocumentLifecycleService } from './document-lifecycle.js';
import { CloudTranscriptionConfigStore, CloudTranscriptionService } from './cloud-transcription.js';
import { CreatorTrackerService } from './creator-tracker.js';
import { DeviceSecretStore, type SecretEncryption } from './device-secret-store.js';
import { classifyDocumentPath } from './document-presentation.js';
import {
  matchLocalMediaFile,
  resolveLocalMediaAssociation,
  type CreatorHistoryCatalog,
  type LocalMediaAssociation,
  type LocalMediaCreatorMatch,
} from './local-media-batch.js';
import { queueMediaTranscription, resumeMediaTranscription, transcribeMediaFile } from './media-transcription.js';
import { handleVaultMediaRequest, mediaPlaybackUrl } from './media-protocol.js';
import { detectPlatformMediaUrl, downloadPlatformMedia, extractSharedMediaUrl } from './platform-media.js';
import { downloadRemoteMediaAsset } from './remote-media.js';
import {
  OnlineAIConfigStore,
  OnlineAIService,
} from './online-ai.js';
import type { OnlineSummaryPreset } from './online-ai.js';
import { YouTubeCreatorApiService } from './youtube-creator-api.js';
import {
  queueCloudMediaTranscription,
  resumeOnlineMediaTranscription,
  transcribeCloudMediaFile,
  transcribeOnlineMediaUrl,
} from './online-media-transcription.js';
import type {
  DocumentSummary,
  OldfolioDesktopApi,
  SearchHit,
  VaultDocument,
  VaultSummary,
} from '../shared/contracts';
import { isTencentASREngine } from '../shared/contracts';

let mainWindow: BrowserWindow | null = null;
let repository: VaultRepository | null = null;
let mediaJobs: MediaJobStore | null = null;
let mediaDeviceConfig: MediaDeviceConfigStore | null = null;
let aiDeviceConfig: AIDeviceConfigStore | null = null;
let aiSummary: AISummaryService | null = null;
let aiWikiChat: AIWikiChatService | null = null;
let documentLifecycle: DocumentLifecycleService | null = null;
let onlineAI: OnlineAIService | null = null;
let cloudTranscription: CloudTranscriptionService | null = null;
let creatorTracker: CreatorTrackerService | null = null;
let youtubeCreatorApi: YouTubeCreatorApiService | null = null;
let creatorRefreshTimer: ReturnType<typeof setInterval> | null = null;
interface PendingLocalMediaBatchItem {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly modifiedAtMs: number;
  readonly matches: readonly LocalMediaCreatorMatch[];
}
interface PendingLocalMediaBatch {
  readonly id: string;
  readonly vaultRoot: string;
  readonly createdAtMs: number;
  readonly items: readonly PendingLocalMediaBatchItem[];
  readonly catalogs: readonly CreatorHistoryCatalog[];
}
const pendingLocalMediaBatches = new Map<string, PendingLocalMediaBatch>();
let batchMediaQueueRunning = false;
const activeMediaTasks = new Set<AbortController>();
const activeBatchMediaControllers = new Map<string, AbortController>();
const activeBatchMediaPromises = new Map<string, Promise<void>>();
const activeAITasks = new Set<AbortController>();
const startupProbe = process.argv.includes('--oldfolio-startup-probe');
const rssConnector = new RssSourceConnector();
const creatorSourceResolver = new CreatorSourceResolver();
const youtubeDataApiConnector = new YouTubeDataApiConnector();
const ingestion = new IngestionPipeline([rssConnector]);
// LM Studio's non-streaming endpoint may not return response headers until a long
// generation completes. Chromium's network stack avoids Node fetch/Undici's
// five-minute response-header timeout while preserving the same narrow fetch API.
const chromiumNetworkFetch: typeof fetch = (input, init) => net.fetch(
  input instanceof URL ? input.href : input,
  init,
);
// Remote SSE completions use Node's HTTP stack. Chromium net.fetch remains dedicated to local
// model compatibility, where waiting for response headers can exceed Undici's default timeout.
const remoteNetworkFetch: typeof fetch = globalThis.fetch;
const localAIProvider = createLocalAIProviderResolver(chromiumNetworkFetch);
const osSecretEncryption: SecretEncryption = {
  isAvailable: async () => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
  },
  encrypt: (plainText) => safeStorage.encryptStringAsync(plainText),
  decrypt: (encrypted) => safeStorage.decryptStringAsync(encrypted),
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'oldfolio-media', privileges: { standard: true, secure: true, stream: true } },
]);

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Rejected IPC from an untrusted renderer');
  }
}

function requireRepository(): VaultRepository {
  if (!repository) throw new Error('请先打开一个 Vault');
  return repository;
}

function requireMediaJobs(): MediaJobStore {
  if (!mediaJobs) throw new Error('请先打开一个 Vault');
  return mediaJobs;
}

function requireMediaDeviceConfig(): MediaDeviceConfigStore {
  if (!mediaDeviceConfig) throw new Error('媒体设备配置尚未初始化');
  return mediaDeviceConfig;
}

async function drainBatchMediaQueue(): Promise<void> {
  if (batchMediaQueueRunning || !repository || !mediaJobs || !mediaDeviceConfig || !cloudTranscription) return;
  batchMediaQueueRunning = true;
  const targetRepository = repository;
  const targetJobs = mediaJobs;
  const targetDeviceConfig = mediaDeviceConfig;
  const targetCloudTranscription = cloudTranscription;
  try {
    while (repository === targetRepository) {
      const queued = (await targetJobs.list())
        .filter((job) => job.stage === 'queued' && Boolean(job.request?.batchId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!queued) break;
      const controller = new AbortController();
      activeMediaTasks.add(controller);
      activeBatchMediaControllers.set(queued.id, controller);
      const processing = (async () => {
        if (queued.request?.kind === 'online_transcription') {
          await resumeOnlineMediaTranscription(
            targetRepository,
            targetJobs,
            targetDeviceConfig,
            targetCloudTranscription,
            queued.id,
            { signal: controller.signal },
          );
        } else {
          await resumeMediaTranscription(
            targetRepository,
            targetJobs,
            targetDeviceConfig,
            queued.id,
            { signal: controller.signal },
          );
        }
      })();
      activeBatchMediaPromises.set(queued.id, processing.then(() => undefined, () => undefined));
      try {
        await processing;
      } catch {
        // Resume functions persist a per-item failure. Continue so one bad file cannot block the batch.
      } finally {
        activeMediaTasks.delete(controller);
        activeBatchMediaControllers.delete(queued.id);
        activeBatchMediaPromises.delete(queued.id);
      }
    }
  } finally {
    batchMediaQueueRunning = false;
  }
}

function scheduleBatchMediaQueue(): void {
  queueMicrotask(() => void drainBatchMediaQueue());
}

function requireAIDeviceConfig(): AIDeviceConfigStore {
  if (!aiDeviceConfig) throw new Error('AI 设备配置尚未初始化');
  return aiDeviceConfig;
}

function requireAISummary(): AISummaryService {
  if (!aiSummary) throw new Error('请先打开一个 Vault');
  return aiSummary;
}

function requireAIWikiChat(): AIWikiChatService {
  if (!aiWikiChat) throw new Error('请先打开一个 Vault');
  return aiWikiChat;
}

function requireDocumentLifecycle(): DocumentLifecycleService {
  if (!documentLifecycle) throw new Error('请先打开一个 Vault');
  return documentLifecycle;
}

function requireCreatorTracker(): CreatorTrackerService {
  if (!creatorTracker) throw new Error('请先打开一个 Vault');
  return creatorTracker;
}

function requireYouTubeCreatorApi(): YouTubeCreatorApiService {
  if (!youtubeCreatorApi) throw new Error('YouTube Data API 服务尚未初始化');
  return youtubeCreatorApi;
}

async function resolveCreatorSource(url: string) {
  const resolution = await creatorSourceResolver.resolve(url);
  if (resolution.status === 'ready' || resolution.platform !== 'youtube') return resolution;
  const service = requireYouTubeCreatorApi();
  if (!service.settings().keyAvailable) return resolution;
  try {
    const channel = await service.resolveChannel(url);
    return {
      inputUrl: resolution.inputUrl,
      canonicalUrl: channel.canonicalUrl,
      platform: 'youtube' as const,
      status: 'ready' as const,
      method: 'official_api' as const,
      authorization: 'api_key_or_oauth' as const,
      feedUrl: channel.feedUrl,
      title: channel.title,
      message: '已通过用户配置的 YouTube Data API Key 解析频道；关注使用公开 Feed，更早的公开历史可在关注后按需分页导入（当前最多 2000 条）。',
    };
  } catch (error) {
    return {
      ...resolution,
      message: `${resolution.message} API 检测失败：${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
}

async function resolveCreatorMediaTarget(
  sourceUrl: string,
  creatorId: unknown,
  creatorEntryId: unknown,
): Promise<{
  readonly sourceTitle: string;
  readonly targetBundleRoot: string;
  readonly creatorId: string;
  readonly creatorTitle: string;
  readonly creatorEntryId: string;
} | undefined> {
  if (creatorId === undefined && creatorEntryId === undefined) return undefined;
  if (
    typeof creatorId !== 'string' || !/^creator-[a-f0-9]{16}$/u.test(creatorId)
    || typeof creatorEntryId !== 'string' || !creatorEntryId.trim() || creatorEntryId.length > 4_096
  ) throw new TypeError('Invalid creator media context');
  const creator = (await requireCreatorTracker().list()).find((item) => item.id === creatorId);
  if (!creator) throw new Error('未找到该博主关注。');
  const entry = (await requireCreatorTracker().history(creatorId)).find((item) => item.id === creatorEntryId);
  if (!entry) throw new Error('未找到该博主的历史内容。');
  const normalizedSource = new URL(sourceUrl).toString();
  const allowed = [entry.link, entry.mediaUrl].filter((value): value is string => Boolean(value)).map((value) => new URL(value).toString());
  if (!allowed.includes(normalizedSource)) throw new Error('媒体地址与所选博主历史条目不一致。');
  return {
    sourceTitle: entry.title,
    targetBundleRoot: `bundles/creators/${creator.id}`,
    creatorId: creator.id,
    creatorTitle: creator.title,
    creatorEntryId: entry.id,
  };
}

function stopCreatorRefreshSchedule(): void {
  if (creatorRefreshTimer) clearInterval(creatorRefreshTimer);
  creatorRefreshTimer = null;
}

function startCreatorRefreshSchedule(): void {
  stopCreatorRefreshSchedule();
  const tracker = requireCreatorTracker();
  const target = requireRepository();
  const refresh = async () => {
    try {
      const refreshed = await tracker.refreshDue();
      if (refreshed.length > 0 && repository === target) await target.rebuildIndex();
    } catch {
      // Per-feed failures are persisted for the UI; malformed configuration must not crash the app timer.
    }
  };
  void refresh();
  creatorRefreshTimer = setInterval(() => void refresh(), 15 * 60 * 1_000);
  creatorRefreshTimer.unref();
}

function requireOnlineAI(): OnlineAIService {
  if (!onlineAI) throw new Error('在线 AI 服务尚未初始化');
  return onlineAI;
}

function requireCloudTranscription(): CloudTranscriptionService {
  if (!cloudTranscription) throw new Error('云转录服务尚未初始化');
  return cloudTranscription;
}

async function readControlledOnlineAudio(uri: string): Promise<{
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}> {
  const target = resolve(uri);
  const root = resolve(requireRepository().root, '.oldfolio', 'cache', 'media-work');
  const child = relative(root, target);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('在线 AI 只能读取 Oldfolio 生成的音频分块。');
  const status = await lstat(target);
  if (!status.isFile() || status.isSymbolicLink() || status.size <= 0 || status.size > 24 * 1024 * 1024) {
    throw new Error('在线转录音频分块必须是小于 24 MB 的普通文件。');
  }
  const extension = extname(target).toLowerCase();
  const mimeType = extension === '.m4a' ? 'audio/mp4' : extension === '.mp3' ? 'audio/mpeg' : '';
  if (!mimeType) throw new Error('在线转录音频分块格式不受支持。');
  return { bytes: await readFile(target), fileName: basename(target), mimeType };
}

async function mediaSettingsSummary() {
  const config = await requireMediaDeviceConfig().load();
  const tools = await probeMediaTools(config);
  return {
    ...tools,
    models: config.models.map((model) => ({
      id: model.id,
      sha256: model.sha256,
      license: model.license,
      sourceUrl: model.sourceUrl,
      byteLength: model.byteLength,
      importedAt: model.importedAt,
    })),
  };
}

async function summarizeDocument(path: string): Promise<DocumentSummary> {
  const snapshot = await requireRepository().read(path);
  const metadata = extractMarkdownMetadata(snapshot.text);
  return {
    path: snapshot.path,
    title: metadata.title ?? parse(snapshot.path).name,
    category: classifyDocumentPath(snapshot.path),
    revision: snapshot.revision,
    updatedAt: snapshot.modifiedAt.toISOString(),
    tags: metadata.tags,
  };
}

async function readDocument(path: string): Promise<VaultDocument> {
  const snapshot = await requireRepository().read(path);
  const metadata = extractMarkdownMetadata(snapshot.text);
  return {
    path: snapshot.path,
    title: metadata.title ?? parse(snapshot.path).name,
    category: classifyDocumentPath(snapshot.path),
    revision: snapshot.revision,
    updatedAt: snapshot.modifiedAt.toISOString(),
    tags: metadata.tags,
    content: snapshot.text,
    links: metadata.links.map((link) => link.target),
  };
}

async function openRepository(root: string, initialize: boolean): Promise<VaultSummary> {
  stopCreatorRefreshSchedule();
  pendingLocalMediaBatches.clear();
  repository?.close();
  repository = await VaultRepository.open(root);
  if (initialize) await repository.initialize();
  mediaJobs = new MediaJobStore(join(root, '.oldfolio/cache/media-jobs'));
  aiSummary = new AISummaryService(
    repository,
    requireAIDeviceConfig(),
    localAIProvider,
    () => new Date(),
    requireOnlineAI(),
  );
  aiWikiChat = new AIWikiChatService(
    repository,
    requireAIDeviceConfig(),
    localAIProvider,
    () => new Date(),
    requireOnlineAI(),
  );
  documentLifecycle = new DocumentLifecycleService(repository);
  creatorTracker = new CreatorTrackerService(repository, rssConnector);
  await mediaJobs.initialize();
  await repository.rebuildIndex();
  startCreatorRefreshSchedule();
  scheduleBatchMediaQueue();
  const documents = await repository.scanDocuments();
  return { root, name: parse(root).name, documentCount: documents.length };
}

async function chooseVault(create: boolean): Promise<VaultSummary | null> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: create ? '选择用于创建 Oldfolio Vault 的文件夹' : '打开 Markdown Vault',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: create ? '创建 Vault' : '打开 Vault',
  });
  const root = result.filePaths[0];
  if (result.canceled || !root) return null;
  const summary = await openRepository(root, true);
  if (create && summary.documentCount <= 4) {
    await repository!.write(
      'notes/欢迎使用 Oldfolio.md',
      '# 欢迎使用 Oldfolio\n\n这是你的本地优先知识库。内容保存在普通 Markdown 文件中。\n\n- 用 `[[双链]]` 连接想法\n- 从 Inbox 导入音视频和链接\n- AI 的写入会先生成可审阅变更集\n',
      null,
    );
    await repository!.rebuildIndex();
    return { ...summary, documentCount: summary.documentCount + 1 };
  }
  return summary;
}

function registerIpc(): void {
  ipcMain.handle('vault:choose', async (event) => {
    assertTrustedSender(event);
    return chooseVault(false);
  });
  ipcMain.handle('vault:create', async (event) => {
    assertTrustedSender(event);
    return chooseVault(true);
  });
  ipcMain.handle('vault:list', async (event) => {
    assertTrustedSender(event);
    const documents = await requireRepository().scanDocuments();
    const summaries = await Promise.all(documents.map((document) => summarizeDocument(document.path)));
    return summaries.filter((document) => document.category !== 'internal');
  });
  ipcMain.handle('vault:create-document', async (event, title: unknown) => {
    assertTrustedSender(event);
    if (typeof title !== 'string' || title.length > 200) throw new TypeError('Invalid document title');
    const created = await requireDocumentLifecycle().create(title);
    await requireRepository().rebuildIndex();
    return readDocument(created.path);
  });
  ipcMain.handle('vault:read', async (event, path: unknown) => {
    assertTrustedSender(event);
    if (typeof path !== 'string') throw new TypeError('Invalid document path');
    return readDocument(path);
  });
  ipcMain.handle(
    'vault:save',
    async (event, input: { path?: unknown; content?: unknown; expectedRevision?: unknown }) => {
      assertTrustedSender(event);
      if (
        typeof input?.path !== 'string' ||
        typeof input.content !== 'string' ||
        typeof input.expectedRevision !== 'string'
      ) {
        throw new TypeError('Invalid save request');
      }
      await requireRepository().write(input.path, input.content, input.expectedRevision);
      await requireRepository().rebuildIndex();
      return readDocument(input.path);
    },
  );
  ipcMain.handle(
    'vault:delete-document',
    async (event, input: { path?: unknown; expectedRevision?: unknown }) => {
      assertTrustedSender(event);
      if (typeof input?.path !== 'string' || typeof input.expectedRevision !== 'string') {
        throw new TypeError('Invalid document deletion request');
      }
      const document = await readDocument(input.path);
      if (document.category === 'internal') throw new Error('Oldfolio 内部文档不能从笔记界面删除。');
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: '删除笔记',
        message: `确定删除“${document.title}”吗？`,
        detail: document.category === 'transcript'
          ? '只删除这份转录笔记，不会删除原始音视频、来源快照或已经生成的摘要。删除后可立即撤销。'
          : '只删除当前笔记，不会连带删除它引用的附件或其他笔记。删除后可立即撤销。',
        buttons: ['取消', '删除笔记'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { cancelled: true };
      const applied = await requireDocumentLifecycle().delete(input.path, input.expectedRevision);
      await requireRepository().rebuildIndex();
      return { cancelled: false, historyId: applied.historyId, path: input.path };
    },
  );
  ipcMain.handle('vault:undo-document-deletion', async (event, historyId: unknown) => {
    assertTrustedSender(event);
    if (typeof historyId !== 'string') throw new TypeError('Invalid deletion history id');
    const restored = await requireDocumentLifecycle().undoDelete(historyId);
    await requireRepository().rebuildIndex();
    return readDocument(restored.path);
  });
  ipcMain.handle('vault:search', async (event, query: unknown): Promise<SearchHit[]> => {
    assertTrustedSender(event);
    if (typeof query !== 'string') throw new TypeError('Invalid search query');
    const presented: SearchHit[] = [];
    for (const result of await requireRepository().search(query)) {
      const category = classifyDocumentPath(result.path);
      if (category === 'internal') continue;
      presented.push({ path: result.path, title: result.title, excerpt: result.excerpt, score: result.score, category });
    }
    return presented;
  });
  ipcMain.handle('vault:backlinks', async (event, path: unknown) => {
    assertTrustedSender(event);
    if (typeof path !== 'string') throw new TypeError('Invalid document path');
    const links = await requireRepository().backlinks(path);
    const summaries = await Promise.all(links.map((link) => summarizeDocument(link.sourcePath)));
    return summaries.filter((document) => document.category !== 'internal');
  });
  ipcMain.handle('source:import-feed', async (event, url: unknown) => {
    assertTrustedSender(event);
    if (typeof url !== 'string' || url.length > 4_096) throw new TypeError('Invalid feed URL');
    const target = requireRepository();
    const result = await ingestion.ingest(rssConnector.id, {
      input: { kind: 'feed', url: url.trim() },
      capabilities: ['metadata', 'content', 'subscription'],
    });
    let created = false;
    try {
      const existing = await target.read(result.document.path);
      if (existing.text !== result.document.content) {
        throw new Error('A source snapshot path exists with different content.');
      }
    } catch (error: unknown) {
      if (!(error instanceof VaultNotFoundError)) throw error;
      await target.write(result.document.path, result.document.content, null);
      created = true;
    }
    await target.rebuildIndex();
    return {
      created,
      snapshotId: result.snapshot.id,
      document: await readDocument(result.document.path),
    };
  });
  ipcMain.handle('creator:list', async (event) => {
    assertTrustedSender(event);
    return requireCreatorTracker().list();
  });
  ipcMain.handle('creator:probe-source', async (event, url: unknown) => {
    assertTrustedSender(event);
    if (typeof url !== 'string' || !url.trim() || url.length > 4_096) throw new TypeError('Invalid creator source URL');
    return resolveCreatorSource(url);
  });
  ipcMain.handle('creator:follow', async (event, url: unknown) => {
    assertTrustedSender(event);
    if (typeof url !== 'string' || !url.trim() || url.length > 4_096) throw new TypeError('Invalid creator feed URL');
    const resolution = await resolveCreatorSource(url);
    if (resolution.status !== 'ready' || !resolution.feedUrl) throw new Error(resolution.message);
    const followed = await requireCreatorTracker().follow(resolution.feedUrl);
    await requireRepository().rebuildIndex();
    return followed;
  });
  ipcMain.handle('creator:refresh', async (event, id: unknown) => {
    assertTrustedSender(event);
    if (typeof id !== 'string' || !/^creator-[a-f0-9]{16}$/u.test(id)) throw new TypeError('Invalid creator id');
    const refreshed = await requireCreatorTracker().refresh(id);
    await requireRepository().rebuildIndex();
    return refreshed;
  });
  ipcMain.handle('creator:refresh-all', async (event) => {
    assertTrustedSender(event);
    const refreshed = await requireCreatorTracker().refreshAll();
    await requireRepository().rebuildIndex();
    return refreshed;
  });
  ipcMain.handle('creator:history', async (event, id: unknown) => {
    assertTrustedSender(event);
    if (typeof id !== 'string' || !/^creator-[a-f0-9]{16}$/u.test(id)) throw new TypeError('Invalid creator id');
    return requireCreatorTracker().history(id);
  });
  ipcMain.handle('creator:generate-title-graph', async (event, id: unknown) => {
    assertTrustedSender(event);
    if (typeof id !== 'string' || !/^creator-[a-f0-9]{16}$/u.test(id)) throw new TypeError('Invalid creator id');
    const graph = await requireCreatorTracker().generateTitleGraph(id);
    await requireRepository().rebuildIndex();
    return graph;
  });
  ipcMain.handle('creator:get-youtube-api-settings', (event) => {
    assertTrustedSender(event);
    return requireYouTubeCreatorApi().settings();
  });
  ipcMain.handle('creator:save-youtube-api-settings', async (event, apiKey: unknown) => {
    assertTrustedSender(event);
    if (typeof apiKey !== 'string' || apiKey.length > 4_096) throw new TypeError('Invalid YouTube Data API Key');
    return requireYouTubeCreatorApi().configure(apiKey);
  });
  ipcMain.handle('creator:clear-youtube-api-key', async (event) => {
    assertTrustedSender(event);
    return requireYouTubeCreatorApi().clear();
  });
  ipcMain.handle('creator:sync-youtube-history', async (event, id: unknown) => {
    assertTrustedSender(event);
    if (typeof id !== 'string' || !/^creator-[a-f0-9]{16}$/u.test(id)) throw new TypeError('Invalid creator id');
    const creator = (await requireCreatorTracker().list()).find((item) => item.id === id);
    if (!creator) throw new Error('未找到该关注。');
    const snapshot = await requireYouTubeCreatorApi().fetchHistory(creator.feedUrl);
    const updated = await requireCreatorTracker().importOfficialHistory(id, snapshot);
    await requireRepository().rebuildIndex();
    return updated;
  });
  ipcMain.handle('creator:open-entry-url', async (event, url: unknown) => {
    assertTrustedSender(event);
    if (typeof url !== 'string' || !url || url.length > 4_096) throw new TypeError('Invalid creator entry URL');
    const target = new URL(url);
    if ((target.protocol !== 'https:' && target.protocol !== 'http:') || target.username || target.password) {
      throw new TypeError('Invalid creator entry URL');
    }
    await shell.openExternal(target.toString(), { activate: true });
  });
  ipcMain.handle('creator:remove', async (event, id: unknown) => {
    assertTrustedSender(event);
    if (typeof id !== 'string' || !/^creator-[a-f0-9]{16}$/u.test(id)) throw new TypeError('Invalid creator id');
    return requireCreatorTracker().remove(id);
  });
  ipcMain.handle('media:import-captions', async (event) => {
    assertTrustedSender(event);
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '导入字幕并生成时间戳笔记',
      properties: ['openFile'],
      filters: [{ name: '字幕文件', extensions: ['srt', 'vtt'] }],
      buttonLabel: '生成转录笔记',
    });
    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) return { cancelled: true };
    const result = await importCaptionFile(requireRepository(), requireMediaJobs(), filePath);
    return {
      cancelled: false,
      createdSource: result.createdSource,
      createdTranscript: result.createdTranscript,
      jobId: result.jobId,
      transcript: await readDocument(result.transcriptPath),
    };
  });
  ipcMain.handle('media:get-settings', async (event) => {
    assertTrustedSender(event);
    return mediaSettingsSummary();
  });
  ipcMain.handle('media:choose-tool', async (event, kind: unknown) => {
    assertTrustedSender(event);
    if (kind !== 'ffmpeg' && kind !== 'whisper' && kind !== 'yt-dlp') throw new TypeError('Invalid media tool kind');
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: kind === 'ffmpeg' ? '选择 FFmpeg 可执行文件' : kind === 'whisper' ? '选择 whisper-cli 可执行文件' : '选择 yt-dlp 可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '可执行文件', extensions: ['exe'] }] : [],
      buttonLabel: '验证并使用',
    });
    const executablePath = selection.filePaths[0];
    if (selection.canceled || !executablePath) return mediaSettingsSummary();
    const current = await requireMediaDeviceConfig().load();
    const candidate = {
      ...current,
      ...(kind === 'ffmpeg' ? { ffmpegPath: executablePath } : kind === 'whisper' ? { whisperPath: executablePath } : { ytDlpPath: executablePath }),
    };
    const status = await probeMediaTools(candidate);
    const selectedStatus = kind === 'ffmpeg' ? status.ffmpeg : kind === 'whisper' ? status.whisper : status.ytDlp;
    if (!selectedStatus.available) {
      throw new Error(selectedStatus.error);
    }
    await requireMediaDeviceConfig().setTool(kind, executablePath);
    return mediaSettingsSummary();
  });
  ipcMain.handle('media:import-model', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid model import request');
    const value = input as Record<string, unknown>;
    if (
      typeof value.id !== 'string' || typeof value.license !== 'string' ||
      typeof value.sourceUrl !== 'string' || value.licenseAccepted !== true ||
      (value.expectedSha256 !== undefined && typeof value.expectedSha256 !== 'string')
    ) {
      throw new TypeError('Model id, source, license, and explicit acceptance are required');
    }
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '导入 whisper.cpp GGML 模型',
      properties: ['openFile'],
      filters: [{ name: 'GGML 模型', extensions: ['bin'] }],
      buttonLabel: '校验并导入',
    });
    const sourcePath = selection.filePaths[0];
    if (selection.canceled || !sourcePath) return mediaSettingsSummary();
    const model = await importLocalModel({
      sourcePath,
      modelDirectory: join(app.getPath('userData'), 'models', 'whisper.cpp'),
      id: value.id,
      license: value.license,
      sourceUrl: value.sourceUrl,
      licenseAccepted: true,
      ...(typeof value.expectedSha256 === 'string' && value.expectedSha256 ? { expectedSha256: value.expectedSha256 } : {}),
    });
    await requireMediaDeviceConfig().addModel(model);
    return mediaSettingsSummary();
  });
  ipcMain.handle('media:prepare-local-batch', async (event) => {
    assertTrustedSender(event);
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '批量选择已经下载好的音视频',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音视频', extensions: ['aac', 'flac', 'm4a', 'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'ogg', 'opus', 'wav', 'webm'] }],
      buttonLabel: '检查关联关系',
    });
    if (selection.canceled || selection.filePaths.length === 0) return { cancelled: true, creators: [], items: [] };
    if (selection.filePaths.length > 100) throw new Error('单次最多批量导入 100 个音视频文件。');
    const now = Date.now();
    for (const [id, batch] of pendingLocalMediaBatches) {
      if (now - batch.createdAtMs > 30 * 60_000) pendingLocalMediaBatches.delete(id);
    }
    const catalogs = await requireCreatorTracker().historyCatalog();
    const items: PendingLocalMediaBatchItem[] = [];
    for (const path of selection.filePaths) {
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink() || status.size <= 0) {
        throw new Error(`批量选择中包含无效文件：${basename(path)}`);
      }
      const fileName = basename(path);
      items.push({
        id: randomUUID(),
        path,
        fileName,
        byteLength: status.size,
        modifiedAtMs: status.mtimeMs,
        matches: matchLocalMediaFile(fileName, catalogs),
      });
    }
    const batch: PendingLocalMediaBatch = {
      id: randomUUID(),
      vaultRoot: requireRepository().root,
      createdAtMs: now,
      items,
      catalogs,
    };
    pendingLocalMediaBatches.set(batch.id, batch);
    return {
      cancelled: false,
      id: batch.id,
      creators: batch.catalogs
        .map((catalog) => ({ id: catalog.creatorId, title: catalog.creatorTitle }))
        .sort((left, right) => left.title.localeCompare(right.title)),
      items: batch.items.map((item) => ({
        id: item.id,
        fileName: item.fileName,
        byteLength: item.byteLength,
        matches: item.matches.map((match) => ({
          creatorId: match.creatorId,
          creatorTitle: match.creatorTitle,
          creatorEntryId: match.creatorEntryId,
          entryTitle: match.entryTitle,
          matchKind: match.matchKind,
          ...(match.mediaId ? { mediaId: match.mediaId } : {}),
        })),
      })),
    };
  });
  ipcMain.handle('media:start-local-batch', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('Invalid local media batch request');
    const value = input as Record<string, unknown>;
    if (
      typeof value.preparationId !== 'string'
      || (value.executionTarget !== 'local' && value.executionTarget !== 'online')
      || (value.modelId !== undefined && typeof value.modelId !== 'string')
      || (value.language !== undefined && typeof value.language !== 'string')
      || !Array.isArray(value.associations)
    ) throw new TypeError('Invalid local media batch request');
    const batch = pendingLocalMediaBatches.get(value.preparationId);
    if (!batch || batch.vaultRoot !== requireRepository().root || Date.now() - batch.createdAtMs > 30 * 60_000) {
      pendingLocalMediaBatches.delete(value.preparationId);
      throw new Error('批量导入预览已过期，请重新选择文件。');
    }
    if (value.associations.length > batch.items.length) throw new TypeError('Invalid local media batch associations');
    const currentCatalogs = await requireCreatorTracker().historyCatalog();
    const associations = new Map<string, LocalMediaAssociation>();
    for (const association of value.associations) {
      if (typeof association !== 'object' || association === null || Array.isArray(association)) {
        throw new TypeError('Invalid local media batch association');
      }
      const candidate = association as Record<string, unknown>;
      if (
        typeof candidate.itemId !== 'string'
        || typeof candidate.creatorId !== 'string'
        || (candidate.creatorEntryId !== undefined && typeof candidate.creatorEntryId !== 'string')
        || associations.has(candidate.itemId)
      ) throw new TypeError('Invalid local media batch association');
      const item = batch.items.find((entry) => entry.id === candidate.itemId);
      if (!item) throw new Error('批量媒体条目不在当前预览中。');
      associations.set(candidate.itemId, resolveLocalMediaAssociation(
        item.matches,
        currentCatalogs,
        candidate.creatorId,
        typeof candidate.creatorEntryId === 'string' ? candidate.creatorEntryId : undefined,
      ));
    }
    const language = typeof value.language === 'string' && value.language.trim() && value.language.trim() !== 'auto'
      ? value.language.trim().slice(0, 64)
      : undefined;
    if (value.executionTarget === 'local') {
      if (typeof value.modelId !== 'string' || !value.modelId.trim()) throw new Error('本地批量转录需要选择 Whisper 模型。');
      const config = await requireMediaDeviceConfig().load();
      if (!config.ffmpegPath || !config.whisperPath) throw new Error('请先配置 FFmpeg 与 whisper-cli。');
      if (!config.models.some((model) => model.id === value.modelId)) throw new Error(`本机未安装模型：${value.modelId}`);
    } else {
      const config = await requireMediaDeviceConfig().load();
      if (!config.ffmpegPath) throw new Error('在线批量转录仍需要本机 FFmpeg。');
      await requireCloudTranscription().runtime();
    }
    const results: Array<{ itemId: string; fileName: string; jobId?: string; error?: string }> = [];
    for (const item of batch.items) {
      try {
        const status = await lstat(item.path);
        if (!status.isFile() || status.isSymbolicLink() || status.size !== item.byteLength || status.mtimeMs !== item.modifiedAtMs) {
          throw new Error('文件在关联确认后发生了变化，请重新选择。');
        }
        const match = associations.get(item.id);
        const creatorTarget = match ? {
          sourceTitle: match.entryTitle ?? item.fileName,
          targetBundleRoot: `bundles/creators/${match.creatorId}`,
          creatorId: match.creatorId,
          creatorTitle: match.creatorTitle,
          ...(match.creatorEntryId ? { creatorEntryId: match.creatorEntryId } : {}),
          ...(match.sourceUrl ? { importedFrom: match.sourceUrl } : {}),
        } : {};
        const queued = value.executionTarget === 'local'
          ? await queueMediaTranscription(
              requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(),
              {
                mediaPath: item.path,
                vaultRoot: requireRepository().root,
                modelId: value.modelId as string,
                ...creatorTarget,
                ...(language ? { language } : {}),
              },
              { id: batch.id, itemId: item.id },
            )
          : await queueCloudMediaTranscription(
              requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(), requireCloudTranscription(),
              {
                mediaPath: item.path,
                ...creatorTarget,
                ...(language ? { language } : {}),
              },
              { id: batch.id, itemId: item.id },
            );
        results.push({ itemId: item.id, fileName: item.fileName, jobId: queued.jobId });
      } catch (error) {
        results.push({
          itemId: item.id,
          fileName: item.fileName,
          error: error instanceof Error ? error.message : '无法加入批量转录队列',
        });
      }
    }
    pendingLocalMediaBatches.delete(batch.id);
    scheduleBatchMediaQueue();
    return {
      queuedCount: results.filter((item) => item.jobId).length,
      failedCount: results.filter((item) => item.error).length,
      jobs: results,
    };
  });
  ipcMain.handle('media:transcribe', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid transcription request');
    const value = input as Record<string, unknown>;
    if (typeof value.modelId !== 'string' || (value.language !== undefined && typeof value.language !== 'string')) {
      throw new TypeError('A local model id is required');
    }
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择本地音视频进行转录',
      properties: ['openFile'],
      filters: [{ name: '音视频', extensions: ['aac', 'flac', 'm4a', 'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'ogg', 'opus', 'wav', 'webm'] }],
      buttonLabel: '开始本地转录',
    });
    const mediaPath = selection.filePaths[0];
    if (selection.canceled || !mediaPath) return { cancelled: true };
    const controller = new AbortController();
    activeMediaTasks.add(controller);
    try {
      const result = await transcribeMediaFile(requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(), {
        mediaPath,
        vaultRoot: requireRepository().root,
        modelId: value.modelId,
        ...(typeof value.language === 'string' && value.language.trim() ? { language: value.language.trim() } : {}),
      }, { signal: controller.signal });
      return {
        cancelled: false,
        jobId: result.jobId,
        transcriptSource: result.transcriptSource,
        transcript: await readDocument(result.transcriptPath),
      };
    } finally {
      activeMediaTasks.delete(controller);
    }
  });
  ipcMain.handle('media:transcribe-online', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid online transcription request');
    const value = input as Record<string, unknown>;
    if (
      typeof value.url !== 'string' || value.url.length > 4_096
      || (value.language !== undefined && typeof value.language !== 'string')
      || (value.platformAccessConfirmed !== undefined && typeof value.platformAccessConfirmed !== 'boolean')
    ) throw new TypeError('A direct HTTPS media URL is required');
    const controller = new AbortController();
    activeMediaTasks.add(controller);
    try {
      const sourceUrl = extractSharedMediaUrl(value.url);
      const creatorTarget = await resolveCreatorMediaTarget(sourceUrl, value.creatorId, value.creatorEntryId);
      const platform = detectPlatformMediaUrl(sourceUrl);
      let temporaryDirectory: string | undefined;
      let result: Awaited<ReturnType<typeof transcribeOnlineMediaUrl>>;
      try {
        if (platform) {
          const mediaConfig = await requireMediaDeviceConfig().load();
          if (!mediaConfig.ytDlpPath || !mediaConfig.ffmpegPath) throw new Error('请先配置 yt-dlp 和 FFmpeg。');
          const downloaded = await downloadPlatformMedia(sourceUrl, {
            ytDlpPath: mediaConfig.ytDlpPath,
            ffmpegPath: mediaConfig.ffmpegPath,
            cacheRoot: join(requireRepository().root, '.oldfolio', 'cache', 'platform-media'),
            authorizationConfirmed: value.platformAccessConfirmed === true,
          }, { signal: controller.signal });
          temporaryDirectory = downloaded.temporaryDirectory;
          result = await transcribeCloudMediaFile(
            requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(), requireCloudTranscription(),
            {
              mediaPath: downloaded.mediaPath,
              importedFrom: downloaded.sourceUrl,
              ...(creatorTarget ?? {}),
              ...(typeof value.language === 'string' && value.language.trim() ? { language: value.language.trim() } : {}),
            },
            { signal: controller.signal },
          );
        } else {
          result = await transcribeOnlineMediaUrl(
            requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(), requireCloudTranscription(),
            {
              url: sourceUrl,
              ...(creatorTarget ?? {}),
              ...(typeof value.language === 'string' && value.language.trim() ? { language: value.language.trim() } : {}),
            },
            { fetcher: chromiumNetworkFetch, signal: controller.signal },
          );
        }
      } finally {
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      }
      return {
        cancelled: false,
        jobId: result.jobId,
        transcriptSource: result.transcriptSource,
        transcript: await readDocument(result.transcriptPath),
      };
    } finally {
      activeMediaTasks.delete(controller);
    }
  });
  ipcMain.handle('media:transcribe-online-locally', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid local online-media request');
    const value = input as Record<string, unknown>;
    if (
      typeof value.url !== 'string' || value.url.length > 4_096 || typeof value.modelId !== 'string'
      || typeof value.platformAccessConfirmed !== 'boolean'
      || (value.language !== undefined && typeof value.language !== 'string')
    ) throw new TypeError('A media URL and local Whisper model are required');
    const controller = new AbortController();
    activeMediaTasks.add(controller);
    let temporaryDirectory: string | undefined;
    try {
      const sourceUrl = extractSharedMediaUrl(value.url);
      const creatorTarget = await resolveCreatorMediaTarget(sourceUrl, value.creatorId, value.creatorEntryId);
      const platform = detectPlatformMediaUrl(sourceUrl);
      let mediaPath: string;
      if (platform) {
        const mediaConfig = await requireMediaDeviceConfig().load();
        if (!mediaConfig.ytDlpPath || !mediaConfig.ffmpegPath) throw new Error('请先配置 yt-dlp 和 FFmpeg。');
        const downloaded = await downloadPlatformMedia(sourceUrl, {
          ytDlpPath: mediaConfig.ytDlpPath,
          ffmpegPath: mediaConfig.ffmpegPath,
          cacheRoot: join(requireRepository().root, '.oldfolio', 'cache', 'platform-media'),
          authorizationConfirmed: value.platformAccessConfirmed,
        }, { signal: controller.signal });
        mediaPath = downloaded.mediaPath;
        temporaryDirectory = downloaded.temporaryDirectory;
      } else {
        mediaPath = (await downloadRemoteMediaAsset(sourceUrl, requireRepository().root, {
          fetcher: chromiumNetworkFetch, signal: controller.signal,
        })).absolutePath;
      }
      const result = await transcribeMediaFile(requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(), {
        mediaPath,
        vaultRoot: requireRepository().root,
        modelId: value.modelId,
        importedFrom: sourceUrl,
        ...(creatorTarget ?? {}),
        ...(typeof value.language === 'string' && value.language.trim() ? { language: value.language.trim() } : {}),
      }, { signal: controller.signal });
      return {
        cancelled: false,
        jobId: result.jobId,
        transcriptSource: result.transcriptSource,
        transcript: await readDocument(result.transcriptPath),
      };
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      activeMediaTasks.delete(controller);
    }
  });
  ipcMain.handle('media:transcribe-cloud-file', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid cloud transcription request');
    const value = input as Record<string, unknown>;
    if (value.language !== undefined && typeof value.language !== 'string') throw new TypeError('Invalid transcription language');
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择本地音视频发送到在线转录服务',
      properties: ['openFile'],
      filters: [{ name: '音视频', extensions: ['aac', 'flac', 'm4a', 'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'ogg', 'opus', 'wav', 'webm'] }],
      buttonLabel: '开始在线转录',
    });
    const mediaPath = selection.filePaths[0];
    if (selection.canceled || !mediaPath) return { cancelled: true };
    const controller = new AbortController();
    activeMediaTasks.add(controller);
    try {
      const result = await transcribeCloudMediaFile(
        requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(), requireCloudTranscription(),
        {
          mediaPath,
          ...(typeof value.language === 'string' && value.language.trim() ? { language: value.language.trim() } : {}),
        },
        { signal: controller.signal },
      );
      return {
        cancelled: false,
        jobId: result.jobId,
        transcriptSource: result.transcriptSource,
        transcript: await readDocument(result.transcriptPath),
      };
    } finally {
      activeMediaTasks.delete(controller);
    }
  });
  ipcMain.handle('media:list-jobs', async (event) => {
    assertTrustedSender(event);
    return (await requireMediaJobs().list()).map((job) => {
      const completedChunks = new Set(job.checkpoints.flatMap((checkpoint) => (
        checkpoint.artifactHash && checkpoint.chunkIndex !== undefined ? [checkpoint.chunkIndex] : []
      ))).size;
      const chunkCount = job.checkpoints.findLast((checkpoint) => checkpoint.chunkCount !== undefined)?.chunkCount;
      return {
      id: job.id,
      sourceUri: job.sourceUri,
      title: job.request?.sourceTitle ?? basename(job.sourceUri),
      executionTarget: job.request?.kind === 'online_transcription' ? 'online' : 'local',
      ...(job.request?.batchId ? { batchId: job.request.batchId } : {}),
      ...(job.request?.creatorTitle ? { creatorTitle: job.request.creatorTitle } : {}),
      stage: job.stage,
      progress: job.checkpoints.at(-1)?.progress ?? 0,
      updatedAt: job.updatedAt,
      attempts: job.attempts,
      completedChunks,
      ...(chunkCount !== undefined ? { chunkCount } : {}),
      canRetry: Boolean(job.request) && (
        (job.stage === 'queued' && !job.request?.batchId)
        || (job.stage === 'failed' && job.error?.retryable)
      ),
      canCancel: Boolean(job.request?.batchId) && !['completed', 'failed', 'cancelled'].includes(job.stage),
      canDelete: job.stage === 'failed' || job.stage === 'cancelled',
      ...(job.error ? { error: job.error.message } : {}),
      };
    });
  });
  ipcMain.handle('media:cancel-job', async (event, jobId: unknown) => {
    assertTrustedSender(event);
    if (typeof jobId !== 'string') throw new TypeError('Invalid media job id');
    const jobs = requireMediaJobs();
    const job = await jobs.get(jobId);
    if (!job.request?.batchId || ['completed', 'failed', 'cancelled'].includes(job.stage)) {
      throw new Error('该任务当前不能停止。');
    }
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: '停止转录任务',
      message: `确定停止“${job.request.sourceTitle}”吗？`,
      detail: '只停止这一项；同一批次中的其他任务不受影响。停止后可以删除任务记录，Vault 中已经导入的原始媒体不会被删除。',
      buttons: ['停止此任务', '继续转录'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) return { cancelled: true };
    activeBatchMediaControllers.get(jobId)?.abort(new Error('用户停止了此转录任务。'));
    await activeBatchMediaPromises.get(jobId);
    const current = await jobs.get(jobId);
    if (current.stage !== 'completed' && current.stage !== 'cancelled') await jobs.cancel(jobId);
    return { cancelled: false };
  });
  ipcMain.handle('media:delete-job', async (event, jobId: unknown) => {
    assertTrustedSender(event);
    if (typeof jobId !== 'string') throw new TypeError('Invalid media job id');
    const jobs = requireMediaJobs();
    const job = await jobs.get(jobId);
    if (job.stage !== 'failed' && job.stage !== 'cancelled') throw new Error('只能删除失败或已停止的转录任务。');
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: '删除转录任务记录',
      message: '确定删除这条任务记录吗？',
      detail: '将删除任务记录和中间缓存，但不会删除原始音视频、来源笔记或转录笔记。',
      buttons: ['删除任务', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) return { cancelled: true };
    const cacheRoot = resolve(requireRepository().root, '.oldfolio', 'cache', 'media-work');
    const cachePath = resolve(cacheRoot, job.id);
    const cacheChild = relative(cacheRoot, cachePath);
    if (!cacheChild || cacheChild.startsWith('..') || isAbsolute(cacheChild)) throw new Error('任务缓存路径越出了 Vault。');
    await rm(cachePath, { recursive: true, force: true });
    await jobs.deleteTerminal(job.id);
    return { cancelled: false };
  });
  ipcMain.handle('media:retry-job', async (event, jobId: unknown) => {
    assertTrustedSender(event);
    if (typeof jobId !== 'string') throw new TypeError('Invalid media job id');
    const controller = new AbortController();
    activeMediaTasks.add(controller);
    try {
      const job = await requireMediaJobs().get(jobId);
      const result = job.request?.kind === 'online_transcription'
        ? await resumeOnlineMediaTranscription(
            requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(), requireCloudTranscription(), jobId,
            { signal: controller.signal },
          )
        : await resumeMediaTranscription(
            requireRepository(), requireMediaJobs(), requireMediaDeviceConfig(), jobId,
            { signal: controller.signal },
          );
      return {
        cancelled: false,
        jobId: result.jobId,
        transcriptSource: result.transcriptSource,
        transcript: await readDocument(result.transcriptPath),
      };
    } finally {
      activeMediaTasks.delete(controller);
    }
  });
  ipcMain.handle('media:get-playback', async (event, path: unknown) => {
    assertTrustedSender(event);
    if (typeof path !== 'string') throw new TypeError('Invalid transcript path');
    const target = requireRepository();
    const document = await target.read(path);
    let manifest = parseTranscriptPlaybackManifest(document.text, document.path);
    const linkedTranscriptPath = manifest ? null : parseSynthesisTranscriptPath(document.text, document.path);
    if (linkedTranscriptPath) {
      try {
        const transcript = await target.read(linkedTranscriptPath);
        manifest = parseTranscriptPlaybackManifest(transcript.text, transcript.path);
      } catch (error: unknown) {
        if (!(error instanceof VaultNotFoundError)) throw error;
      }
    }
    if (!manifest) return null;
    const extension = manifest.resource.slice(manifest.resource.lastIndexOf('.') + 1).toLowerCase();
    try {
      return {
        ...manifest,
        mediaUrl: mediaPlaybackUrl(manifest.resource),
        mediaKind: ['mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm'].includes(extension) ? 'video' : 'audio',
      };
    } catch {
      // Caption-only imports may refer to an external file that Oldfolio is not authorized to stream.
      return null;
    }
  });
  ipcMain.handle('ai:get-settings', async (event) => {
    assertTrustedSender(event);
    return requireAISummary().settings();
  });
  ipcMain.handle('ai:get-online-settings', async (event) => {
    assertTrustedSender(event);
    return requireOnlineAI().settings();
  });
  ipcMain.handle('ai:get-cloud-transcription-settings', async (event) => {
    assertTrustedSender(event);
    return requireCloudTranscription().settings();
  });
  ipcMain.handle('ai:probe-provider', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid local AI probe');
    const value = input as Record<string, unknown>;
    if (
      (value.providerId !== 'ollama' && value.providerId !== 'openai-compatible') ||
      typeof value.endpoint !== 'string'
    ) throw new TypeError('Invalid local AI probe');
    return requireAISummary().probe(value.providerId, value.endpoint);
  });
  ipcMain.handle('ai:save-settings', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid AI settings');
    const value = input as Record<string, unknown>;
    if (
      (value.providerId !== 'ollama' && value.providerId !== 'openai-compatible') ||
      typeof value.endpoint !== 'string' ||
      typeof value.model !== 'string' ||
      typeof value.contextWindow !== 'number'
    ) throw new TypeError('Invalid AI settings');
    return requireAISummary().configure(value.providerId, value.endpoint, value.model, value.contextWindow);
  });
  ipcMain.handle('ai:probe-online-provider', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid online AI probe');
    const value = input as Record<string, unknown>;
    if (
      typeof value.endpoint !== 'string' || typeof value.apiKey !== 'string'
      || typeof value.hostConfirmed !== 'boolean'
    ) throw new TypeError('Invalid online AI probe');
    return requireOnlineAI().probe(value.endpoint, value.apiKey, value.hostConfirmed);
  });
  ipcMain.handle('ai:save-online-settings', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid online AI settings');
    const value = input as Record<string, unknown>;
    if (
      typeof value.endpoint !== 'string' || typeof value.apiKey !== 'string'
      || typeof value.chatModel !== 'string'
      || (value.transcriptionModel !== undefined && typeof value.transcriptionModel !== 'string')
      || typeof value.contextWindow !== 'number'
      || typeof value.hostConfirmed !== 'boolean'
    ) throw new TypeError('Invalid online AI settings');
    const presets = ['custom', 'openai', 'deepseek', 'kimi', 'glm', 'minimax', 'grok', 'qwen', 'gemini', 'openrouter'] as const;
    if (value.preset !== undefined && !presets.includes(value.preset as typeof presets[number])) {
      throw new TypeError('Invalid online AI preset');
    }
    return requireOnlineAI().configure({
      ...(typeof value.preset === 'string' ? { preset: value.preset as OnlineSummaryPreset } : {}),
      endpoint: value.endpoint,
      apiKey: value.apiKey,
      chatModel: value.chatModel,
      contextWindow: value.contextWindow,
      ...(typeof value.transcriptionModel === 'string' ? { transcriptionModel: value.transcriptionModel } : {}),
      hostConfirmed: value.hostConfirmed,
    });
  });
  ipcMain.handle('ai:clear-online-key', async (event, preset: unknown) => {
    assertTrustedSender(event);
    const presets = ['custom', 'openai', 'deepseek', 'kimi', 'glm', 'minimax', 'grok', 'qwen', 'gemini', 'openrouter'] as const;
    if (typeof preset !== 'string' || !presets.includes(preset as typeof presets[number])) {
      throw new TypeError('Invalid online AI preset');
    }
    return requireOnlineAI().clearSavedKey(preset as OnlineSummaryPreset);
  });
  ipcMain.handle('ai:save-cloud-transcription-settings', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid cloud transcription settings');
    const value = input as Record<string, unknown>;
    if (value.providerId === 'openai-compatible' && typeof value.model === 'string') {
      return requireCloudTranscription().configure({ providerId: value.providerId, model: value.model });
    }
    if (
      value.providerId === 'tencent-asr' && typeof value.region === 'string'
      && typeof value.engineModelType === 'string' && isTencentASREngine(value.engineModelType)
      && typeof value.secretId === 'string' && typeof value.secretKey === 'string'
    ) return requireCloudTranscription().configure({
      providerId: value.providerId, region: value.region, engineModelType: value.engineModelType,
      secretId: value.secretId, secretKey: value.secretKey,
    });
    throw new TypeError('Invalid cloud transcription settings');
  });
  ipcMain.handle('ai:clear-cloud-transcription-credentials', async (event) => {
    assertTrustedSender(event);
    return requireCloudTranscription().clearSavedCredentials();
  });
  ipcMain.handle('ai:prepare-summary', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid transcript summary preparation');
    const value = input as Record<string, unknown>;
    if (
      typeof value.path !== 'string'
      || (value.executionTarget !== 'local' && value.executionTarget !== 'online')
      || (value.mode !== 'fast' && value.mode !== 'deep')
      || (value.outputLanguage !== 'auto' && value.outputLanguage !== 'zh-CN' && value.outputLanguage !== 'en')
    ) throw new TypeError('Invalid transcript summary preparation');
    return requireAISummary().prepare(value.path, value.executionTarget, value.mode, value.outputLanguage);
  });
  ipcMain.handle('ai:generate-summary', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid AI summary request');
    const value = input as Record<string, unknown>;
    if (
      typeof value.path !== 'string' ||
      typeof value.sourceRevision !== 'string' ||
      typeof value.template !== 'string' ||
      (value.executionTarget !== 'local' && value.executionTarget !== 'online') ||
      (value.mode !== 'fast' && value.mode !== 'deep') ||
      (value.outputLanguage !== 'auto' && value.outputLanguage !== 'zh-CN' && value.outputLanguage !== 'en') ||
      !(SUMMARY_TEMPLATES as readonly string[]).includes(value.template)
    ) {
      throw new TypeError('Invalid AI summary request');
    }
    const controller = new AbortController();
    activeAITasks.add(controller);
    try {
      return await requireAISummary().generate(
        value.path,
        value.sourceRevision,
        value.template as (typeof SUMMARY_TEMPLATES)[number],
        controller.signal,
        value.executionTarget,
        value.mode,
        value.outputLanguage,
      );
    } finally {
      activeAITasks.delete(controller);
    }
  });
  ipcMain.handle('ai:prepare-concepts', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid concept preparation');
    const value = input as Record<string, unknown>;
    if (
      typeof value.path !== 'string'
      || (value.executionTarget !== 'local' && value.executionTarget !== 'online')
    ) throw new TypeError('Invalid concept preparation');
    return requireAISummary().prepareConcepts(value.path, value.executionTarget);
  });
  ipcMain.handle('ai:generate-concepts', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid concept extraction request');
    const value = input as Record<string, unknown>;
    if (
      typeof value.path !== 'string'
      || typeof value.sourceRevision !== 'string'
      || (value.executionTarget !== 'local' && value.executionTarget !== 'online')
    ) throw new TypeError('Invalid concept extraction request');
    const controller = new AbortController();
    activeAITasks.add(controller);
    try {
      return await requireAISummary().generateConcepts(
        value.path,
        value.sourceRevision,
        controller.signal,
        value.executionTarget,
      );
    } finally {
      activeAITasks.delete(controller);
    }
  });
  ipcMain.handle('ai:apply-changeset', async (event, changeSetId: unknown) => {
    assertTrustedSender(event);
    if (typeof changeSetId !== 'string') throw new TypeError('Invalid AI change-set id');
    const applied = await requireAISummary().apply(changeSetId);
    return { ...applied, document: await readDocument(applied.targetPath) };
  });
  ipcMain.handle('ai:undo-changeset', async (event, historyId: unknown) => {
    assertTrustedSender(event);
    if (typeof historyId !== 'string') throw new TypeError('Invalid AI history id');
    return requireAISummary().undo(historyId);
  });
  ipcMain.handle('ai:prepare-wiki-question', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid wiki question preparation');
    const value = input as Record<string, unknown>;
    if (
      typeof value.question !== 'string'
      || (value.executionTarget !== 'local' && value.executionTarget !== 'online')
    ) throw new TypeError('Invalid wiki question preparation');
    return requireAIWikiChat().prepare(value.question, value.executionTarget);
  });
  ipcMain.handle('ai:answer-wiki-question', async (event, preparationId: unknown) => {
    assertTrustedSender(event);
    if (typeof preparationId !== 'string') throw new TypeError('Invalid wiki question preparation id');
    const controller = new AbortController();
    activeAITasks.add(controller);
    try {
      return await requireAIWikiChat().answer(preparationId, controller.signal);
    } finally {
      activeAITasks.delete(controller);
    }
  });
  ipcMain.handle('ai:prepare-save-wiki-answer', async (event, answerId: unknown) => {
    assertTrustedSender(event);
    if (typeof answerId !== 'string') throw new TypeError('Invalid wiki answer id');
    return requireAIWikiChat().prepareSave(answerId);
  });
  ipcMain.handle('ai:apply-wiki-answer', async (event, changeSetId: unknown) => {
    assertTrustedSender(event);
    if (typeof changeSetId !== 'string') throw new TypeError('Invalid wiki answer change-set id');
    const applied = await requireAIWikiChat().apply(changeSetId);
    return { ...applied, document: await readDocument(applied.targetPath) };
  });
  ipcMain.handle('ai:undo-wiki-answer', async (event, historyId: unknown) => {
    assertTrustedSender(event);
    if (typeof historyId !== 'string') throw new TypeError('Invalid wiki answer history id');
    return requireAIWikiChat().undo(historyId);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f8f7f2',
    show: !startupProbe,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  if (startupProbe) {
    mainWindow.webContents.once('did-finish-load', () => {
      void mainWindow?.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const api = window.oldfolio;
          const required = ['createVault', 'chooseVault', 'chooseMediaTool', 'importWhisperModel', 'prepareLocalMediaBatch', 'startLocalMediaBatch', 'cancelMediaJob', 'transcribeOnlineMedia', 'transcribeOnlineMediaLocally', 'listCreatorSubscriptions', 'probeCreatorSource', 'followCreatorFeed', 'getCreatorHistory', 'generateCreatorTitleGraph', 'openCreatorEntryUrl', 'getAISettings', 'getOnlineAISettings', 'getCloudTranscriptionSettings', 'prepareAISummary', 'prepareAIConcepts', 'prepareWikiQuestion', 'applyAIChangeSet'];
          const reader = document.querySelector('.markdown-reader');
          if (reader) reader.innerHTML = Array.from({ length: 180 }, (_, index) => '<p>Scroll probe paragraph ' + index + '</p>').join('');
          const clientHeight = reader?.clientHeight ?? 0;
          const scrollHeight = reader?.scrollHeight ?? 0;
          if (reader) reader.scrollTop = scrollHeight;
          const plainScrollable = Boolean(reader) && scrollHeight > clientHeight && (reader?.scrollTop ?? 0) > 0;
          const workspace = document.querySelector('.workspace');
          const fakePlayer = document.createElement('section');
          fakePlayer.className = 'transcript-player';
          if (workspace && reader) {
            workspace.classList.add('has-player');
            workspace.insertBefore(fakePlayer, reader);
            reader.scrollTop = reader.scrollHeight;
          }
          const playerClientHeight = reader?.clientHeight ?? 0;
          const playerScrollHeight = reader?.scrollHeight ?? 0;
          const playerScrollable = Boolean(reader) && playerScrollHeight > playerClientHeight && (reader?.scrollTop ?? 0) > 0;
          resolve({
            bridgeReady: Boolean(api) && required.every((name) => typeof api[name] === 'function'),
            scrollable: plainScrollable && playerScrollable,
            clientHeight,
            scrollHeight,
            playerClientHeight,
            playerScrollHeight,
          });
        }));
      })`).then((probe: {
        bridgeReady: boolean;
        scrollable: boolean;
        clientHeight: number;
        scrollHeight: number;
        playerClientHeight: number;
        playerScrollHeight: number;
      }) => {
        if (!probe.bridgeReady || !probe.scrollable) {
          console.error(`Oldfolio desktop startup probe failed: bridge=${String(probe.bridgeReady)} scrollable=${String(probe.scrollable)} plain=${probe.clientHeight}/${probe.scrollHeight} player=${probe.playerClientHeight}/${probe.playerScrollHeight}.`);
          app.exit(1);
          return;
        }
        console.log(`Oldfolio desktop startup probe passed. plain=${probe.clientHeight}/${probe.scrollHeight} player=${probe.playerClientHeight}/${probe.playerScrollHeight}`);
        app.quit();
      }).catch((error: unknown) => {
        console.error(`Oldfolio desktop startup probe failed: ${error instanceof Error ? error.message : String(error)}`);
        app.exit(1);
      });
    });
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`Oldfolio desktop startup probe failed: ${code} ${description}`);
      app.exit(1);
    });
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(async () => {
  mediaDeviceConfig = new MediaDeviceConfigStore(join(app.getPath('userData'), 'device', 'media.json'));
  aiDeviceConfig = new AIDeviceConfigStore(join(app.getPath('userData'), 'device', 'ai.json'));
  const sessionSecrets = new DeviceSecretStore(
    join(app.getPath('userData'), 'device', 'credentials.json'),
    osSecretEncryption,
  );
  await sessionSecrets.initialize();
  youtubeCreatorApi = new YouTubeCreatorApiService(youtubeDataApiConnector, sessionSecrets);
  onlineAI = new OnlineAIService(
    new OnlineAIConfigStore(join(app.getPath('userData'), 'device', 'online-ai.json')),
    sessionSecrets,
    remoteNetworkFetch,
    readControlledOnlineAudio,
  );
  cloudTranscription = new CloudTranscriptionService(
    new CloudTranscriptionConfigStore(join(app.getPath('userData'), 'device', 'cloud-transcription.json')),
    sessionSecrets,
    onlineAI,
    chromiumNetworkFetch,
    readControlledOnlineAudio,
  );
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  void protocol.handle('oldfolio-media', (request) => handleVaultMediaRequest(request, repository?.root ?? null));
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopCreatorRefreshSchedule();
  for (const controller of activeMediaTasks) controller.abort(new Error('Oldfolio is closing.'));
  for (const controller of activeAITasks) controller.abort(new Error('Oldfolio is closing.'));
  onlineAI?.clearSessionKey();
  repository?.close();
});

const _apiShape: OldfolioDesktopApi | undefined = undefined;
void _apiShape;
