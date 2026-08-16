import { join, parse } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { IngestionPipeline, RssSourceConnector } from '@oldfolio/ingest';
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
import { AISummaryService } from './ai-summary.js';
import { importCaptionFile } from './caption-import.js';
import { resumeMediaTranscription, transcribeMediaFile } from './media-transcription.js';
import { handleVaultMediaRequest, mediaPlaybackUrl } from './media-protocol.js';
import type {
  DocumentSummary,
  OldfolioDesktopApi,
  SearchHit,
  VaultDocument,
  VaultSummary,
} from '../shared/contracts';

let mainWindow: BrowserWindow | null = null;
let repository: VaultRepository | null = null;
let mediaJobs: MediaJobStore | null = null;
let mediaDeviceConfig: MediaDeviceConfigStore | null = null;
let aiDeviceConfig: AIDeviceConfigStore | null = null;
let aiSummary: AISummaryService | null = null;
const activeMediaTasks = new Set<AbortController>();
const activeAITasks = new Set<AbortController>();
const startupProbe = process.argv.includes('--oldfolio-startup-probe');
const rssConnector = new RssSourceConnector();
const ingestion = new IngestionPipeline([rssConnector]);

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

function requireAIDeviceConfig(): AIDeviceConfigStore {
  if (!aiDeviceConfig) throw new Error('AI 设备配置尚未初始化');
  return aiDeviceConfig;
}

function requireAISummary(): AISummaryService {
  if (!aiSummary) throw new Error('请先打开一个 Vault');
  return aiSummary;
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
    revision: snapshot.revision,
    updatedAt: snapshot.modifiedAt.toISOString(),
    tags: metadata.tags,
    content: snapshot.text,
    links: metadata.links.map((link) => link.target),
  };
}

async function openRepository(root: string, initialize: boolean): Promise<VaultSummary> {
  repository?.close();
  repository = await VaultRepository.open(root);
  if (initialize) await repository.initialize();
  mediaJobs = new MediaJobStore(join(root, '.oldfolio/cache/media-jobs'));
  aiSummary = new AISummaryService(repository, requireAIDeviceConfig());
  await mediaJobs.initialize();
  await repository.rebuildIndex();
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
    return Promise.all(documents.map((document) => summarizeDocument(document.path)));
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
  ipcMain.handle('vault:search', async (event, query: unknown): Promise<SearchHit[]> => {
    assertTrustedSender(event);
    if (typeof query !== 'string') throw new TypeError('Invalid search query');
    return requireRepository().search(query);
  });
  ipcMain.handle('vault:backlinks', async (event, path: unknown) => {
    assertTrustedSender(event);
    if (typeof path !== 'string') throw new TypeError('Invalid document path');
    const links = await requireRepository().backlinks(path);
    return Promise.all(links.map((link) => summarizeDocument(link.sourcePath)));
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
    if (kind !== 'ffmpeg' && kind !== 'whisper') throw new TypeError('Invalid media tool kind');
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: kind === 'ffmpeg' ? '选择 FFmpeg 可执行文件' : '选择 whisper-cli 可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '可执行文件', extensions: ['exe'] }] : [],
      buttonLabel: '验证并使用',
    });
    const executablePath = selection.filePaths[0];
    if (selection.canceled || !executablePath) return mediaSettingsSummary();
    const current = await requireMediaDeviceConfig().load();
    const candidate = {
      ...current,
      ...(kind === 'ffmpeg' ? { ffmpegPath: executablePath } : { whisperPath: executablePath }),
    };
    const status = await probeMediaTools(candidate);
    if (!(kind === 'ffmpeg' ? status.ffmpeg.available : status.whisper.available)) {
      throw new Error(kind === 'ffmpeg' ? status.ffmpeg.error : status.whisper.error);
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
      stage: job.stage,
      progress: job.checkpoints.at(-1)?.progress ?? 0,
      updatedAt: job.updatedAt,
      attempts: job.attempts,
      completedChunks,
      ...(chunkCount !== undefined ? { chunkCount } : {}),
      canRetry: Boolean(job.request) && (job.stage === 'queued' || (job.stage === 'failed' && job.error?.retryable)),
      ...(job.error ? { error: job.error.message } : {}),
      };
    });
  });
  ipcMain.handle('media:retry-job', async (event, jobId: unknown) => {
    assertTrustedSender(event);
    if (typeof jobId !== 'string') throw new TypeError('Invalid media job id');
    const controller = new AbortController();
    activeMediaTasks.add(controller);
    try {
      const result = await resumeMediaTranscription(
        requireRepository(),
        requireMediaJobs(),
        requireMediaDeviceConfig(),
        jobId,
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
      typeof value.model !== 'string'
    ) throw new TypeError('Invalid AI settings');
    return requireAISummary().configure(value.providerId, value.endpoint, value.model);
  });
  ipcMain.handle('ai:prepare-summary', async (event, path: unknown) => {
    assertTrustedSender(event);
    if (typeof path !== 'string') throw new TypeError('Invalid transcript path');
    return requireAISummary().prepare(path);
  });
  ipcMain.handle('ai:generate-summary', async (event, input: unknown) => {
    assertTrustedSender(event);
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid AI summary request');
    const value = input as Record<string, unknown>;
    if (
      typeof value.path !== 'string' ||
      typeof value.sourceRevision !== 'string' ||
      typeof value.template !== 'string' ||
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
          const required = ['createVault', 'chooseVault', 'chooseMediaTool', 'importWhisperModel', 'getAISettings', 'prepareAISummary', 'applyAIChangeSet'];
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

void app.whenReady().then(() => {
  mediaDeviceConfig = new MediaDeviceConfigStore(join(app.getPath('userData'), 'device', 'media.json'));
  aiDeviceConfig = new AIDeviceConfigStore(join(app.getPath('userData'), 'device', 'ai.json'));
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
  for (const controller of activeMediaTasks) controller.abort(new Error('Oldfolio is closing.'));
  for (const controller of activeAITasks) controller.abort(new Error('Oldfolio is closing.'));
  repository?.close();
});

const _apiShape: OldfolioDesktopApi | undefined = undefined;
void _apiShape;
