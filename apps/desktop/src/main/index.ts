import { join, parse } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { IngestionPipeline, RssSourceConnector } from '@oldfolio/ingest';
import { MediaJobStore } from '@oldfolio/media';
import { extractMarkdownMetadata, VaultNotFoundError, VaultRepository } from '@oldfolio/vault';
import { importCaptionFile } from './caption-import.js';
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
const startupProbe = process.argv.includes('--oldfolio-startup-probe');
const rssConnector = new RssSourceConnector();
const ingestion = new IngestionPipeline([rssConnector]);

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
      preload: join(import.meta.dirname, '../preload/index.mjs'),
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
      console.log('Oldfolio desktop startup probe passed.');
      app.quit();
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
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => repository?.close());

const _apiShape: OldfolioDesktopApi | undefined = undefined;
void _apiShape;
