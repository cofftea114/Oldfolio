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
  Sparkles,
  Tags,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  DocumentSummary,
  SearchHit,
  VaultDocument,
  VaultSummary,
} from '../../shared/contracts';
import { MarkdownEditor } from './MarkdownEditor';

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
    setDraft(EMPTY_MESSAGE);
    await loadDocuments();
  };

  const openDocument = async (path: string) => {
    const document = await window.oldfolio.readDocument(path);
    setActive(document);
    setDraft(document.content);
    setBacklinks(await window.oldfolio.backlinks(path));
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

      <section className="workspace">
        <div className="workspace-toolbar">
          <div className="document-type"><span>MD</span>{active?.path ?? '起始页'}</div>
          <button className="icon-button" title="切换详情" onClick={() => setDetailsOpen((value) => !value)}><PanelRightClose /></button>
        </div>
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
