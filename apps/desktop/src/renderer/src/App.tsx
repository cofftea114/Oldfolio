import {
  BookOpenText,
  Bot,
  ChevronRight,
  CircleDot,
  FilePlus2,
  FolderOpen,
  Network,
  PanelRightClose,
  Captions,
  Radio,
  Search,
  Settings2,
  Sparkles,
  Tags,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  DocumentSummary,
  MediaJobSummary,
  MediaSettingsSummary,
  SearchHit,
  TranscriptPlaybackSummary,
  VaultDocument,
  VaultSummary,
} from '../../shared/contracts';
import { MarkdownEditor } from './MarkdownEditor';
import { TranscriptPlayer } from './TranscriptPlayer';

const EMPTY_MESSAGE = '# 欢迎来到 Oldfolio\n\n选择或创建一个本地 Vault 开始记录。';

export function App() {
  const [vault, setVault] = useState<VaultSummary | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [active, setActive] = useState<VaultDocument | null>(null);
  const [draft, setDraft] = useState(EMPTY_MESSAGE);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [backlinks, setBacklinks] = useState<DocumentSummary[]>([]);
  const [status, setStatus] = useState('本地就绪');
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [feedUrl, setFeedUrl] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [mediaSettingsOpen, setMediaSettingsOpen] = useState(false);
  const [mediaSettings, setMediaSettings] = useState<MediaSettingsSummary | null>(null);
  const [mediaJobs, setMediaJobs] = useState<MediaJobSummary[]>([]);
  const [modelId, setModelId] = useState('base');
  const [modelLicense, setModelLicense] = useState('');
  const [modelSource, setModelSource] = useState('https://huggingface.co/ggerganov/whisper.cpp');
  const [modelSha256, setModelSha256] = useState('');
  const [modelAccepted, setModelAccepted] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [mediaLanguage, setMediaLanguage] = useState('auto');
  const [playback, setPlayback] = useState<TranscriptPlaybackSummary | null>(null);

  const loadDocuments = useCallback(async () => {
    const items = await window.oldfolio.listDocuments();
    setDocuments(items);
  }, []);

  const openVault = async (create = false) => {
    const next = create
      ? await window.oldfolio.createVault()
      : await window.oldfolio.chooseVault();
    if (!next) return;
    setVault(next);
    setActive(null);
    setPlayback(null);
    setDraft(EMPTY_MESSAGE);
    await loadDocuments();
  };

  const openDocument = async (path: string) => {
    const [document, nextBacklinks, nextPlayback] = await Promise.all([
      window.oldfolio.readDocument(path),
      window.oldfolio.backlinks(path),
      window.oldfolio.getTranscriptPlayback(path),
    ]);
    setActive(document);
    setDraft(document.content);
    setBacklinks(nextBacklinks);
    setPlayback(nextPlayback);
  };

  const importFeed = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!vault || !feedUrl.trim() || importing) return;
    setImporting(true);
    setImportError('');
    setStatus('正在导入订阅…');
    try {
      const result = await window.oldfolio.importFeed(feedUrl.trim());
      await loadDocuments();
      await openDocument(result.document.path);
      setStatus(result.created ? '来源快照已保存' : '来源快照已存在');
      setFeedUrl('');
      setImportOpen(false);
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : '无法导入该订阅');
      setStatus('导入失败');
    } finally {
      setImporting(false);
    }
  };

  const importCaptions = async () => {
    if (!vault || importing) return;
    setImporting(true);
    setImportError('');
    setStatus('正在解析字幕…');
    try {
      const result = await window.oldfolio.importCaptions();
      if (result.cancelled || !result.transcript) {
        setStatus('已取消导入');
        return;
      }
      await loadDocuments();
      await openDocument(result.transcript.path);
      setStatus(result.createdTranscript ? '时间戳转录笔记已生成' : '该转录笔记已存在');
      setImportOpen(false);
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : '无法导入字幕');
      setStatus('字幕导入失败');
    } finally {
      setImporting(false);
    }
  };

  const refreshMedia = useCallback(async () => {
    const [settings, jobs] = await Promise.all([
      window.oldfolio.getMediaSettings(),
      vault ? window.oldfolio.listMediaJobs() : Promise.resolve([]),
    ]);
    setMediaSettings(settings);
    setMediaJobs(jobs);
    setSelectedModel((current) => current || settings.models[0]?.id || '');
  }, [vault]);

  const toggleMediaSettings = async () => {
    const next = !mediaSettingsOpen;
    setMediaSettingsOpen(next);
    if (next) {
      try {
        await refreshMedia();
      } catch (error: unknown) {
        setImportError(error instanceof Error ? error.message : '无法读取媒体配置');
      }
    }
  };

  const chooseMediaTool = async (kind: 'ffmpeg' | 'whisper') => {
    setImportError('');
    try {
      setMediaSettings(await window.oldfolio.chooseMediaTool(kind));
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : '工具验证失败');
    }
  };

  const importModel = async () => {
    if (!modelAccepted) return;
    setImporting(true);
    setImportError('');
    try {
      const settings = await window.oldfolio.importWhisperModel({
        id: modelId,
        license: modelLicense,
        sourceUrl: modelSource,
        licenseAccepted: modelAccepted,
        ...(modelSha256.trim() ? { expectedSha256: modelSha256.trim() } : {}),
      });
      setMediaSettings(settings);
      setSelectedModel(settings.models.at(-1)?.id ?? '');
      setStatus('本地模型已校验并导入');
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : '模型导入失败');
    } finally {
      setImporting(false);
    }
  };

  const transcribeMedia = async () => {
    if (!vault || !selectedModel || importing) return;
    setImporting(true);
    setImportError('');
    setStatus('正在本地转录，关闭应用后可在下次启动恢复状态…');
    const poll = window.setInterval(() => void window.oldfolio.listMediaJobs().then(setMediaJobs), 1_000);
    try {
      const result = await window.oldfolio.transcribeMedia({
        modelId: selectedModel,
        ...(mediaLanguage.trim() ? { language: mediaLanguage.trim() } : {}),
      });
      if (result.cancelled || !result.transcript) {
        setStatus('已取消转录');
        return;
      }
      await loadDocuments();
      await openDocument(result.transcript.path);
      setStatus(result.transcriptSource === 'embedded_subtitle' ? '已提取内嵌字幕并生成笔记' : '本地语音转录笔记已生成');
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : '本地转录失败');
      setStatus('本地转录失败，任务状态已保留');
    } finally {
      window.clearInterval(poll);
      await refreshMedia();
      setImporting(false);
    }
  };

  const retryMediaJob = async (jobId: string) => {
    if (!vault || importing) return;
    setImporting(true);
    setImportError('');
    setStatus('正在从已校验的媒体分块继续转录…');
    const poll = window.setInterval(() => void window.oldfolio.listMediaJobs().then(setMediaJobs), 1_000);
    try {
      const result = await window.oldfolio.retryMediaJob(jobId);
      if (result.transcript) {
        await loadDocuments();
        await openDocument(result.transcript.path);
      }
      setStatus(result.transcriptSource === 'embedded_subtitle' ? '已从内嵌字幕恢复生成笔记' : '媒体语音转录已恢复并完成');
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : '恢复媒体任务失败');
      setStatus('恢复失败，已完成分块仍会保留');
    } finally {
      window.clearInterval(poll);
      await refreshMedia();
      setImporting(false);
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      if (!active || draft === active.content) return;
      setStatus('正在保存…');
      try {
        const saved = await window.oldfolio.saveDocument(active.path, draft, active.revision);
        setActive(saved);
        setStatus('已保存到本地');
        await loadDocuments();
      } catch {
        setStatus('文件已在其他位置更改，请重新打开');
      }
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [active, draft, loadDocuments]);

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      setHits(query.trim() ? await window.oldfolio.search(query.trim()) : []);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const visibleDocuments = useMemo<Array<DocumentSummary & { excerpt?: string }>>(
    () =>
      query.trim()
        ? hits.map((hit) => ({ ...hit, revision: '', updatedAt: '', tags: [] }))
        : documents,
    [documents, hits, query],
  );

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand-mark"><CircleDot size={17} /> oldfolio</div>
        <div className="vault-crumb">
          <span>{vault?.name ?? '未打开 Vault'}</span>
          {active && <><ChevronRight size={14} /><span>{active.title}</span></>}
        </div>
        <div className="local-state"><span className="state-dot" />{status}</div>
      </header>

      <aside className="rail" aria-label="主导航">
        <button className="rail-button active" title="笔记"><BookOpenText /></button>
        <button className="rail-button" title="知识图谱"><Network /></button>
        <button className="rail-button" title="AI 工作台"><Sparkles /></button>
        <button
          className={importOpen ? 'rail-button active' : 'rail-button'}
          title="导入 RSS / Podcast"
          onClick={() => setImportOpen((value) => !value)}
        ><Radio /></button>
        <button
          className={mediaSettingsOpen ? 'rail-button active' : 'rail-button'}
          title="本地媒体设置"
          onClick={() => void toggleMediaSettings()}
        ><Settings2 /></button>
        <div className="rail-spacer" />
        <button className="rail-button" title="打开 Vault" onClick={() => void openVault(false)}><FolderOpen /></button>
      </aside>

      <aside className="sidebar">
        <div className="sidebar-heading">
          <div><span className="eyebrow">知识库</span><h1>{vault?.name ?? 'Oldfolio'}</h1></div>
          <button className="icon-button" title="创建 Vault" onClick={() => void openVault(true)}><FilePlus2 /></button>
        </div>
        <label className="search-box">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记与知识…" />
        </label>
        {importOpen && (
          <form className="source-import" onSubmit={(event) => void importFeed(event)}>
            <div className="section-label"><Radio size={14} /> 导入 RSS / Podcast</div>
            <input
              aria-label="订阅地址"
              disabled={!vault || importing}
              onChange={(event) => setFeedUrl(event.target.value)}
              placeholder={vault ? 'https://example.com/feed.xml' : '请先打开 Vault'}
              type="url"
              value={feedUrl}
            />
            {importError && <p role="alert">{importError}</p>}
            <button disabled={!vault || !feedUrl.trim() || importing} type="submit">
              {importing ? '正在获取…' : '保存来源快照'}
            </button>
            <div className="import-divider"><span>或</span></div>
            <button className="secondary" disabled={!vault || importing} onClick={() => void importCaptions()} type="button">
              <Captions size={14} /> 导入 SRT / VTT 字幕
            </button>
          </form>
        )}
        {mediaSettingsOpen && (
          <section className="media-settings">
            <div className="section-label"><Settings2 size={14} /> 本地转录</div>
            <div className="tool-row">
              <span><strong>FFmpeg</strong><small>{mediaSettings?.ffmpeg.version ?? '未配置'}</small></span>
              <button onClick={() => void chooseMediaTool('ffmpeg')}>{mediaSettings?.ffmpeg.available ? '更换' : '选择'}</button>
            </div>
            <div className="tool-row">
              <span><strong>whisper-cli</strong><small>{mediaSettings?.whisper.version ?? '未配置'}</small></span>
              <button onClick={() => void chooseMediaTool('whisper')}>{mediaSettings?.whisper.available ? '更换' : '选择'}</button>
            </div>
            <details>
              <summary>导入 GGML 模型</summary>
              <p className="model-help">先从 whisper.cpp 官方模型页下载 <code>ggml-*.bin</code>。多语言内容建议从 <code>base</code> 开始；<code>*.en</code> 仅适合英语。填写来源和实际许可证，确认后选择本地 .bin 文件。</p>
              <input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="模型 ID，例如 base" />
              <input value={modelLicense} onChange={(event) => setModelLicense(event.target.value)} placeholder="许可证标识" />
              <input value={modelSource} onChange={(event) => setModelSource(event.target.value)} placeholder="HTTPS 来源地址" type="url" />
              <input value={modelSha256} onChange={(event) => setModelSha256(event.target.value)} placeholder="可信 SHA-256（可选）" />
              <label className="accept-license"><input checked={modelAccepted} onChange={(event) => setModelAccepted(event.target.checked)} type="checkbox" /> 我已审阅并接受该模型许可证</label>
              <button disabled={!modelAccepted || !modelId.trim() || !modelLicense.trim() || !modelSource.trim() || importing} onClick={() => void importModel()}>选择模型文件并导入</button>
              <small className="model-help-note">SHA-256 可留空；只有你从可信渠道取得 64 位 SHA-256 时才填写。官方模型表目前列出的是 40 位 SHA-1，不能填入此框。</small>
            </details>
            <label className="field-label">模型
              <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                <option value="">未安装模型</option>
                {mediaSettings?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
              </select>
            </label>
            <label className="field-label">语言
              <input value={mediaLanguage} onChange={(event) => setMediaLanguage(event.target.value)} placeholder="auto / zh / en" />
            </label>
            <button className="transcribe-button" disabled={!vault || !selectedModel || !mediaSettings?.ffmpeg.available || !mediaSettings.whisper.available || importing} onClick={() => void transcribeMedia()}>
              {importing ? '处理中…' : '选择音视频并转录'}
            </button>
            <small className="model-help-note">视频包含 ASS、SRT、mov_text 或 WebVTT 文本字幕时会优先提取；没有可用文本字幕时才运行 Whisper。</small>
            {mediaJobs.slice(0, 3).map((job) => (
              <div className="job-row" key={job.id}>
                <span>{job.stage}</span><progress max="1" value={job.progress} />
                <small>{job.chunkCount ? `${job.completedChunks}/${job.chunkCount} 分块` : `第 ${job.attempts} 次运行`}</small>
                {job.error && <small>{job.error}</small>}
                {job.canRetry && <button disabled={importing} onClick={() => void retryMediaJob(job.id)}>继续</button>}
              </div>
            ))}
            {importError && <p className="media-error" role="alert">{importError}</p>}
          </section>
        )}
        <div className="file-section">
          <div className="section-label">笔记 <span>{documents.length}</span></div>
          <nav className="file-list">
            {visibleDocuments.map((document) => (
              <button
                className={active?.path === document.path ? 'file-item active' : 'file-item'}
                key={document.path}
                onClick={() => void openDocument(document.path)}
              >
                <BookOpenText size={15} />
                <span><strong>{document.title}</strong><small>{document.excerpt ?? document.path}</small></span>
              </button>
            ))}
          </nav>
        </div>
        {!vault && (
          <div className="empty-card">
            <Bot size={22} />
            <strong>从本地开始</strong>
            <p>无需账号。打开已有 Markdown 文件夹，或创建标准 Oldfolio Vault。</p>
            <button onClick={() => void openVault(false)}>打开文件夹</button>
          </div>
        )}
      </aside>

      <section className={playback ? 'workspace has-player' : 'workspace'}>
        <div className="workspace-toolbar">
          <div className="document-type"><span>MD</span>{active?.path ?? '起始页'}</div>
          <button className="icon-button" title="切换详情" onClick={() => setDetailsOpen((value) => !value)}><PanelRightClose /></button>
        </div>
        {playback && <TranscriptPlayer key={`${active?.path ?? ''}-${playback.resource}`} playback={playback} />}
        <MarkdownEditor key={active?.path ?? 'welcome'} value={draft} onChange={setDraft} />
      </section>

      {detailsOpen && (
        <aside className="details">
          <section>
            <div className="section-label"><Tags size={14} /> 属性</div>
            <dl className="property-list">
              <div><dt>格式</dt><dd>{active?.path.startsWith('bundles/') ? 'OKF v0.2' : 'Markdown'}</dd></div>
              <div><dt>同步</dt><dd>未启用</dd></div>
              <div><dt>修改</dt><dd>{active?.updatedAt ? new Date(active.updatedAt).toLocaleString('zh-CN') : '—'}</dd></div>
            </dl>
          </section>
          <section>
            <div className="section-label"><Network size={14} /> 反向链接 <span>{backlinks.length}</span></div>
            {backlinks.length ? backlinks.map((item) => (
              <button className="backlink" key={item.path} onClick={() => void openDocument(item.path)}>{item.title}</button>
            )) : <p className="muted">当前笔记还没有反向链接。</p>}
          </section>
          <section className="ai-panel">
            <div className="section-label"><Sparkles size={14} /> AI 变更集</div>
            <p>AI 建议将以可审阅 diff 出现，不会静默覆盖你的笔记。</p>
            <button disabled={!active}>分析当前笔记</button>
          </section>
        </aside>
      )}
    </main>
  );
}
