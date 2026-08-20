import {
  BookOpenText,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FilePlus2,
  FolderOpen,
  Network,
  PanelRightClose,
  PencilLine,
  Plus,
  Captions,
  Radio,
  RotateCcw,
  Search,
  Sparkles,
  Tags,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  AIAppliedChange,
  AILocalProviderId,
  AIModelSummary,
  AIPendingSummaryChange,
  AISettingsSummary,
  AISummaryExecutionTarget,
  AISummaryLanguage,
  AISummaryMode,
  AISummaryPreparation,
  AISummaryTemplate,
  CloudTranscriptionProviderId,
  CloudTranscriptionSettingsSummary,
  DocumentSummary,
  MediaJobSummary,
  MediaSettingsSummary,
  OnlineAISettingsSummary,
  OnlineSummaryPreset,
  SearchHit,
  TranscriptPlaybackSummary,
  TencentASREngineModel,
  VaultDocument,
  VaultSummary,
} from '../../shared/contracts';
import { DEFAULT_TENCENT_ASR_ENGINE, TENCENT_ASR_ENGINES, isTencentASREngine } from '../../shared/contracts';
import { MarkdownEditor } from './MarkdownEditor';
import { MarkdownReader } from './MarkdownReader';
import { TranscriptPlayer } from './TranscriptPlayer';

const EMPTY_MESSAGE = '# 欢迎来到 Oldfolio\n\n选择或创建一个本地 Vault 开始记录。';

const SUMMARY_TEMPLATE_LABELS: Readonly<Record<AISummaryTemplate, string>> = {
  course: '课程',
  interview: '访谈',
  podcast: '播客',
  tutorial: '教程',
  meeting: '会议',
  'news-commentary': '观点 / 时事评论',
  debate: '辩论',
  review: '评测',
};

const SUMMARY_LANGUAGE_LABELS: Readonly<Record<AISummaryLanguage, string>> = {
  auto: '自动跟随转录',
  'zh-CN': '简体中文',
  en: 'English',
};

const LOCAL_AI_PROVIDER_LABELS: Readonly<Record<AILocalProviderId, string>> = {
  ollama: 'Ollama',
  'openai-compatible': 'LM Studio',
};

const LOCAL_AI_DEFAULT_ENDPOINTS: Readonly<Record<AILocalProviderId, string>> = {
  ollama: 'http://127.0.0.1:11434/api/',
  'openai-compatible': 'http://127.0.0.1:1234/api/v1/',
};

const ONLINE_SUMMARY_PRESETS: Readonly<Record<OnlineSummaryPreset, { label: string; endpoint: string; model: string }>> = {
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/', model: 'gpt-5-mini' },
  deepseek: { label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/', model: 'deepseek-chat' },
  kimi: { label: 'Kimi', endpoint: 'https://api.moonshot.ai/v1/', model: 'kimi-k2.6' },
  glm: { label: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-5.2' },
  minimax: { label: 'MiniMax', endpoint: 'https://api.minimaxi.com/v1/', model: 'MiniMax-M2.7' },
  grok: { label: 'Grok', endpoint: 'https://api.x.ai/v1/', model: 'grok-4.5' },
  qwen: { label: 'Qwen / 通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/', model: 'qwen3.7-plus' },
  gemini: { label: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.6-flash' },
  custom: { label: '自定义 OpenAI-compatible', endpoint: '', model: '' },
};

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function isPlatformShareUrl(value: string): boolean {
  try {
    const candidate = /https:\/\/[^\s<>"']+/iu.exec(value.trim())?.[0] ?? value;
    const host = new URL(candidate).hostname.toLowerCase();
    return host === 'youtu.be' || host === 'b23.tv'
      || host === 'youtube.com' || host.endsWith('.youtube.com')
      || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')
      || host === 'bilibili.com' || host.endsWith('.bilibili.com')
      || host === 'douyin.com' || host.endsWith('.douyin.com');
  } catch {
    return false;
  }
}

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
  const [aiSettingsOpen, setAISettingsOpen] = useState(false);
  const [aiSettings, setAISettings] = useState<AISettingsSummary | null>(null);
  const [aiProvider, setAIProvider] = useState<AILocalProviderId>('ollama');
  const [aiEndpoint, setAIEndpoint] = useState('http://127.0.0.1:11434/api/');
  const [aiModels, setAIModels] = useState<AIModelSummary[]>([]);
  const [aiModel, setAIModel] = useState('');
  const [aiContextWindow, setAIContextWindow] = useState('8192');
  const [aiExecutionTarget, setAIExecutionTarget] = useState<AISummaryExecutionTarget>('local');
  const [transcriptionExecutionTarget, setTranscriptionExecutionTarget] = useState<AISummaryExecutionTarget>('local');
  const [onlineAISettings, setOnlineAISettings] = useState<OnlineAISettingsSummary | null>(null);
  const [onlineSummaryPreset, setOnlineSummaryPreset] = useState<OnlineSummaryPreset>('openai');
  const [onlineAIEndpoint, setOnlineAIEndpoint] = useState('https://api.openai.com/v1/');
  const [onlineAPIKey, setOnlineAPIKey] = useState('');
  const [onlineHostConfirmed, setOnlineHostConfirmed] = useState(false);
  const [onlineModels, setOnlineModels] = useState<AIModelSummary[]>([]);
  const [onlineChatModel, setOnlineChatModel] = useState('');
  const [onlineContextWindow, setOnlineContextWindow] = useState('128000');
  const [onlineTranscriptionModel, setOnlineTranscriptionModel] = useState('gpt-4o-mini-transcribe');
  const [cloudTranscriptionSettings, setCloudTranscriptionSettings] = useState<CloudTranscriptionSettingsSummary | null>(null);
  const [cloudTranscriptionProvider, setCloudTranscriptionProvider] = useState<CloudTranscriptionProviderId>('openai-compatible');
  const [tencentRegion, setTencentRegion] = useState('ap-guangzhou');
  const [tencentEngine, setTencentEngine] = useState<TencentASREngineModel>(DEFAULT_TENCENT_ASR_ENGINE);
  const [tencentSecretId, setTencentSecretId] = useState('');
  const [tencentSecretKey, setTencentSecretKey] = useState('');
  const [onlineMediaUrl, setOnlineMediaUrl] = useState('');
  const [platformAccessConfirmed, setPlatformAccessConfirmed] = useState(false);
  const [aiBusy, setAIBusy] = useState(false);
  const [aiError, setAIError] = useState('');
  const [summaryPreparation, setSummaryPreparation] = useState<AISummaryPreparation | null>(null);
  const [summaryTemplate, setSummaryTemplate] = useState<AISummaryTemplate>('course');
  const [summaryMode, setSummaryMode] = useState<AISummaryMode>('fast');
  const [summaryLanguage, setSummaryLanguage] = useState<AISummaryLanguage>('auto');
  const [pendingSummary, setPendingSummary] = useState<AIPendingSummaryChange | null>(null);
  const [appliedChange, setAppliedChange] = useState<AIAppliedChange | null>(null);
  const [viewMode, setViewMode] = useState<'read' | 'edit'>('read');
  const [seekRequest, setSeekRequest] = useState<{ startMs: number; requestId: number } | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [deletedDocuments, setDeletedDocuments] = useState<{
    historyId: string;
    path: string;
    title: string;
  }[]>([]);
  const deletedDocument = deletedDocuments.at(-1) ?? null;

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
    setSeekRequest(null);
    setDraft(EMPTY_MESSAGE);
    setNewNoteOpen(false);
    setNewNoteTitle('');
    setDocumentError('');
    setDeletedDocuments([]);
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
    setSeekRequest(null);
    setViewMode(document.path.startsWith('bundles/') ? 'read' : 'edit');
    setSummaryPreparation(null);
    setPendingSummary(null);
    setAppliedChange(null);
    setAIError('');
  };

  const createDocument = async (event: FormEvent) => {
    event.preventDefault();
    if (!vault || !newNoteTitle.trim() || documentBusy) return;
    setDocumentBusy(true);
    setDocumentError('');
    try {
      const created = await window.oldfolio.createDocument(newNoteTitle);
      setNewNoteTitle('');
      setNewNoteOpen(false);
      await loadDocuments();
      await openDocument(created.path);
      setViewMode('edit');
      setStatus(`已新建“${created.title}”`);
    } catch (error: unknown) {
      setDocumentError(error instanceof Error ? error.message : '新建笔记失败');
    } finally {
      setDocumentBusy(false);
    }
  };

  const deleteActiveDocument = async () => {
    if (!active || documentBusy || draft !== active.content) return;
    setDocumentBusy(true);
    setDocumentError('');
    try {
      const deleted = await window.oldfolio.deleteDocument(active.path, active.revision);
      if (deleted.cancelled || !deleted.historyId || !deleted.path) return;
      setDeletedDocuments((items) => [...items, {
        historyId: deleted.historyId!,
        path: deleted.path!,
        title: active.title,
      }]);
      setActive(null);
      setPlayback(null);
      setBacklinks([]);
      setSeekRequest(null);
      setDraft(EMPTY_MESSAGE);
      setSummaryPreparation(null);
      setPendingSummary(null);
      setAppliedChange(null);
      await loadDocuments();
      if (query.trim()) setHits(await window.oldfolio.search(query.trim()));
      setStatus(`已删除“${active.title}”，可撤销`);
    } catch (error: unknown) {
      setDocumentError(error instanceof Error ? error.message : '删除笔记失败');
    } finally {
      setDocumentBusy(false);
    }
  };

  const undoDocumentDeletion = async () => {
    if (!deletedDocument || documentBusy) return;
    setDocumentBusy(true);
    setDocumentError('');
    try {
      const restored = await window.oldfolio.undoDocumentDeletion(deletedDocument.historyId);
      setDeletedDocuments((items) => items.filter((item) => item.historyId !== deletedDocument.historyId));
      await loadDocuments();
      await openDocument(restored.path);
      setStatus(`已恢复“${restored.title}”`);
    } catch (error: unknown) {
      setDocumentError(error instanceof Error ? error.message : '撤销删除失败');
    } finally {
      setDocumentBusy(false);
    }
  };

  const toggleAISettings = async () => {
    const next = !aiSettingsOpen;
    setAISettingsOpen(next);
    if (!next || !vault) return;
    setAIError('');
    try {
      const [settings, onlineSettings, cloudSettings, currentMediaSettings] = await Promise.all([
        window.oldfolio.getAISettings(),
        window.oldfolio.getOnlineAISettings(),
        window.oldfolio.getCloudTranscriptionSettings(),
        window.oldfolio.getMediaSettings(),
      ]);
      setAISettings(settings);
      setAIProvider(settings.providerId);
      setAIEndpoint(settings.endpoint);
      setAIModel(settings.model);
      setAIContextWindow(String(settings.contextWindow));
      setOnlineAISettings(onlineSettings);
      setOnlineSummaryPreset(onlineSettings.preset);
      setOnlineAIEndpoint(onlineSettings.endpoint);
      setOnlineChatModel(onlineSettings.chatModel);
      setOnlineContextWindow(String(onlineSettings.contextWindow));
      setOnlineTranscriptionModel(onlineSettings.transcriptionModel || 'gpt-4o-mini-transcribe');
      setCloudTranscriptionSettings(cloudSettings);
      setCloudTranscriptionProvider(cloudSettings.providerId);
      if (cloudSettings.providerId === 'openai-compatible') setOnlineTranscriptionModel(cloudSettings.model);
      if (cloudSettings.providerId === 'tencent-asr') {
        setTencentRegion(cloudSettings.region || 'ap-guangzhou');
        setTencentEngine(isTencentASREngine(cloudSettings.model) ? cloudSettings.model : DEFAULT_TENCENT_ASR_ENGINE);
      }
      setOnlineHostConfirmed(false);
      setMediaSettings(currentMediaSettings);
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : '无法读取 AI 配置');
    }
  };

  const probeLocalAI = async () => {
    setAIBusy(true);
    setAIError('');
    setStatus(`正在连接本机 ${LOCAL_AI_PROVIDER_LABELS[aiProvider]}…`);
    try {
      const models = await window.oldfolio.probeLocalAI({ providerId: aiProvider, endpoint: aiEndpoint });
      setAIModels(models);
      setAIModel((current) => {
        const selected = models.find((model) => model.id === current) ?? models[0];
        if (selected?.contextWindow) setAIContextWindow(String(selected.contextWindow));
        return selected?.id ?? '';
      });
      setStatus(models.length ? `已发现 ${models.length} 个本地模型` : `${LOCAL_AI_PROVIDER_LABELS[aiProvider]} 可连接，但没有可用模型`);
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : `无法连接 ${LOCAL_AI_PROVIDER_LABELS[aiProvider]}`);
      setStatus('本地 AI 连接失败');
    } finally {
      setAIBusy(false);
    }
  };

  const saveAISettings = async () => {
    if (!aiModel) return;
    setAIBusy(true);
    setAIError('');
    try {
      const settings = await window.oldfolio.saveAISettings({
        providerId: aiProvider,
        endpoint: aiEndpoint,
        model: aiModel,
        contextWindow: Number(aiContextWindow),
      });
      setAISettings(settings);
      setAIEndpoint(settings.endpoint);
      setStatus('本地 AI 配置已保存到当前设备');
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : '无法保存 AI 配置');
      setStatus('AI 配置保存失败');
    } finally {
      setAIBusy(false);
    }
  };

  const probeOnlineAI = async () => {
    if (!onlineAPIKey.trim()) return;
    setAIBusy(true);
    setAIError('');
    setStatus('正在连接在线 OpenAI-compatible 服务…');
    try {
      const models = await window.oldfolio.probeOnlineAI({
        endpoint: onlineAIEndpoint,
        apiKey: onlineAPIKey,
        hostConfirmed: onlineHostConfirmed,
      });
      setOnlineModels(models);
      setOnlineChatModel((current) => {
        const selected = models.find((model) => model.id === current) ?? models[0];
        if (selected?.contextWindow) setOnlineContextWindow(String(selected.contextWindow));
        return selected?.id ?? '';
      });
      setStatus(models.length ? `已发现 ${models.length} 个在线模型` : '在线服务可连接，但没有返回模型');
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : '无法连接在线 AI 服务');
      setStatus('在线 AI 连接失败');
    } finally {
      setAIBusy(false);
    }
  };

  const saveOnlineAISettings = async () => {
    if (!onlineChatModel.trim() || !onlineAPIKey.trim()) return;
    setAIBusy(true);
    setAIError('');
    try {
      const settings = await window.oldfolio.saveOnlineAISettings({
        preset: onlineSummaryPreset,
        endpoint: onlineAIEndpoint,
        chatModel: onlineChatModel,
        contextWindow: Number(onlineContextWindow),
        apiKey: onlineAPIKey,
        hostConfirmed: onlineHostConfirmed,
      });
      setOnlineAISettings(settings);
      setOnlineAIEndpoint(settings.endpoint);
      setOnlineAPIKey('');
      setOnlineHostConfirmed(false);
      setStatus('在线 AI 已连接；API Key 仅保留在当前运行会话');
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : '无法保存在线 AI 配置');
      setStatus('在线 AI 配置失败');
    } finally {
      setAIBusy(false);
    }
  };

  const saveCloudTranscriptionSettings = async () => {
    setAIBusy(true);
    setAIError('');
    try {
      const settings = cloudTranscriptionProvider === 'openai-compatible'
        ? await window.oldfolio.saveCloudTranscriptionSettings({
            providerId: cloudTranscriptionProvider,
            model: onlineTranscriptionModel,
          })
        : await window.oldfolio.saveCloudTranscriptionSettings({
            providerId: cloudTranscriptionProvider,
            region: tencentRegion,
            engineModelType: tencentEngine,
            secretId: tencentSecretId,
            secretKey: tencentSecretKey,
          });
      setCloudTranscriptionSettings(settings);
      setTencentSecretId('');
      setTencentSecretKey('');
      setStatus('在线转录配置已保存；凭据仅保留在当前运行会话');
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : '无法保存在线转录配置');
    } finally {
      setAIBusy(false);
    }
  };

  const prepareAISummary = async () => {
    if (!active || !playback || draft !== active.content) return;
    setAIBusy(true);
    setAIError('');
    setPendingSummary(null);
    setAppliedChange(null);
    setStatus('正在准备摘要数据披露…');
    try {
      const preparation = await window.oldfolio.prepareAISummary(
        active.path,
        aiExecutionTarget,
        summaryMode,
        summaryLanguage,
      );
      setSummaryPreparation(preparation);
      setSummaryTemplate(preparation.suggestedTemplate);
      setStatus('请确认发送内容和摘要模板');
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : '无法准备 AI 摘要');
      setStatus('摘要准备失败');
    } finally {
      setAIBusy(false);
    }
  };

  const generateAISummary = async () => {
    if (!summaryPreparation) return;
    setAIBusy(true);
    setAIError('');
    setStatus(summaryPreparation.executionTarget === 'online'
      ? '正在由在线大模型生成摘要…'
      : `正在由本机 ${LOCAL_AI_PROVIDER_LABELS[summaryPreparation.providerId]} 生成摘要…`);
    try {
      const pending = await window.oldfolio.generateAISummary({
        path: summaryPreparation.sourcePath,
        sourceRevision: summaryPreparation.sourceRevision,
        template: summaryTemplate,
        executionTarget: summaryPreparation.executionTarget,
        mode: summaryPreparation.mode,
        outputLanguage: summaryPreparation.requestedOutputLanguage,
      });
      setPendingSummary(pending);
      setStatus('AI 摘要变更集已生成，等待批准');
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : 'AI 摘要生成失败');
      setStatus('AI 摘要生成失败');
    } finally {
      setAIBusy(false);
    }
  };

  const applyAIChangeSet = async () => {
    if (!pendingSummary) return;
    setAIBusy(true);
    setAIError('');
    setStatus('正在原子应用 AI 变更集…');
    try {
      const applied = await window.oldfolio.applyAIChangeSet(pendingSummary.id);
      await loadDocuments();
      await openDocument(applied.document.path);
      setAppliedChange(applied);
      setStatus('AI 摘要已写入，可立即撤销');
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : '无法应用 AI 变更集');
      setStatus('AI 变更集未写入');
    } finally {
      setAIBusy(false);
    }
  };

  const undoAIChangeSet = async () => {
    if (!appliedChange) return;
    setAIBusy(true);
    setAIError('');
    try {
      const undone = await window.oldfolio.undoAIChangeSet(appliedChange.historyId);
      await loadDocuments();
      if (undone.sourcePath) await openDocument(undone.sourcePath);
      setAppliedChange(null);
      setStatus('AI 变更集已撤销');
    } catch (error: unknown) {
      setAIError(error instanceof Error ? error.message : '无法撤销 AI 变更集');
      setStatus('撤销失败：目标文件可能已经变化');
    } finally {
      setAIBusy(false);
    }
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

  const chooseMediaTool = async (kind: 'ffmpeg' | 'whisper' | 'yt-dlp') => {
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

  const transcribeOnlineMedia = async () => {
    if (!vault || !onlineMediaUrl.trim() || importing) return;
    setImporting(true);
    setImportError('');
    setAIError('');
    setStatus('正在下载在线媒体并准备在线转录；已完成分块可用于续跑…');
    const poll = window.setInterval(() => void window.oldfolio.listMediaJobs().then(setMediaJobs), 1_000);
    try {
      const language = mediaLanguage.trim();
      const result = await window.oldfolio.transcribeOnlineMedia({
        url: onlineMediaUrl.trim(),
        platformAccessConfirmed,
        ...(language && language !== 'auto' ? { language } : {}),
      });
      if (result.cancelled || !result.transcript) {
        setStatus('已取消在线媒体分析');
        return;
      }
      await loadDocuments();
      await openDocument(result.transcript.path);
      setStatus(result.transcriptSource === 'embedded_subtitle'
        ? '已优先提取在线媒体的内嵌字幕并生成笔记'
        : '在线模型转录笔记已生成，可继续准备摘要');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '在线媒体转录失败';
      setAIError(message);
      setStatus('在线媒体转录失败，已完成分块仍会保留');
    } finally {
      window.clearInterval(poll);
      await refreshMedia();
      setImporting(false);
    }
  };

  const transcribeOnlineMediaLocally = async () => {
    if (!vault || !selectedModel || !onlineMediaUrl.trim() || importing) return;
    setImporting(true);
    setImportError('');
    setAIError('');
    setStatus('正在解析在线媒体，随后将使用本地 Whisper 转录…');
    const poll = window.setInterval(() => void window.oldfolio.listMediaJobs().then(setMediaJobs), 1_000);
    try {
      const language = mediaLanguage.trim();
      const result = await window.oldfolio.transcribeOnlineMediaLocally({
        url: onlineMediaUrl.trim(),
        modelId: selectedModel,
        platformAccessConfirmed,
        ...(language && language !== 'auto' ? { language } : {}),
      });
      if (result.cancelled || !result.transcript) {
        setStatus('已取消在线媒体解析');
        return;
      }
      await loadDocuments();
      await openDocument(result.transcript.path);
      setStatus(result.transcriptSource === 'embedded_subtitle'
        ? '已提取在线视频字幕并生成笔记'
        : '已使用本地 Whisper 转录在线视频');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '本地 Whisper 解析在线视频失败';
      setImportError(message);
      setStatus('在线视频本地转录失败');
    } finally {
      window.clearInterval(poll);
      await refreshMedia();
      setImporting(false);
    }
  };

  const transcribeCloudMedia = async () => {
    if (!vault || importing) return;
    setImporting(true);
    setImportError('');
    setAIError('');
    setStatus('正在准备本地媒体并发送受控音频分块…');
    const poll = window.setInterval(() => void window.oldfolio.listMediaJobs().then(setMediaJobs), 1_000);
    try {
      const language = mediaLanguage.trim();
      const result = await window.oldfolio.transcribeCloudMedia({
        ...(language && language !== 'auto' ? { language } : {}),
      });
      if (result.cancelled || !result.transcript) {
        setStatus('已取消在线转录');
        return;
      }
      await loadDocuments();
      await openDocument(result.transcript.path);
      setStatus(result.transcriptSource === 'embedded_subtitle'
        ? '已优先提取本地媒体的内嵌字幕'
        : '本地媒体已由在线转录服务生成笔记');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '本地媒体在线转录失败';
      setAIError(message);
      setStatus('本地媒体在线转录失败');
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

  const deleteMediaJob = async (jobId: string) => {
    if (!vault || importing) return;
    setImporting(true);
    setImportError('');
    try {
      const result = await window.oldfolio.deleteMediaJob(jobId);
      if (result.cancelled) {
        setStatus('已取消删除任务');
        return;
      }
      await refreshMedia();
      setStatus('失败的转录任务及其中间缓存已删除');
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : '删除转录任务失败');
      setStatus('删除转录任务失败');
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
  const visibleKnowledgeDocuments = useMemo(
    () => visibleDocuments.filter((document) => document.category === 'knowledge'),
    [visibleDocuments],
  );
  const visibleTranscripts = useMemo(
    () => visibleDocuments.filter((document) => document.category === 'transcript'),
    [visibleDocuments],
  );
  const savedCloudCredentialsAvailable = cloudTranscriptionSettings?.providerId === cloudTranscriptionProvider
    && cloudTranscriptionSettings.credentialAvailable;
  const tencentCredentialCount = [tencentSecretId, tencentSecretKey].filter((value) => value.trim()).length;
  const selectedTencentEngine = TENCENT_ASR_ENGINES.find((engine) => engine.id === tencentEngine);
  const onlineMediaIsPlatform = isPlatformShareUrl(onlineMediaUrl);

  const openWikiLink = (target: string) => {
    const pathTarget = target.split('#', 1)[0]?.replaceAll('\\', '/') ?? '';
    const withExtension = pathTarget.endsWith('.md') ? pathTarget : `${pathTarget}.md`;
    const candidate = documents.find((document) => document.path === pathTarget || document.path === withExtension)
      ?? documents.find((document) => document.title === pathTarget || document.title === pathTarget.replace(/\.md$/iu, ''));
    if (candidate) {
      void openDocument(candidate.path);
    } else {
      setStatus(`找不到链接笔记：${pathTarget}`);
    }
  };

  const seekFromNote = (startMs: number) => {
    if (!playback) {
      setStatus('当前笔记没有可播放的来源媒体');
      return;
    }
    setSeekRequest((current) => ({ startMs, requestId: (current?.requestId ?? 0) + 1 }));
  };

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
        <button
          className={aiSettingsOpen ? 'rail-button active' : 'rail-button'}
          title="AI 工作台"
          onClick={() => void toggleAISettings()}
        ><Sparkles /></button>
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
        {deletedDocument && (
          <div className="deletion-notice" role="status">
            <span>{deletedDocuments.length > 1 ? `已删除 ${deletedDocuments.length} 份笔记，最近一份` : '已删除'}<strong>{deletedDocument.title}</strong></span>
            <button disabled={documentBusy} onClick={() => void undoDocumentDeletion()} type="button">
              <RotateCcw size={13} />撤销
            </button>
          </div>
        )}
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
        {aiSettingsOpen && (
          <section className="media-settings">
            <div className="section-label"><Captions size={14} /> 转录模块</div>
            <label className="field-label">执行方式
              <select
                disabled={aiBusy || importing || !vault}
                value={transcriptionExecutionTarget}
                onChange={(event) => setTranscriptionExecutionTarget(event.target.value as AISummaryExecutionTarget)}
              >
                <option value="local">本地 Whisper</option>
                <option value="online">在线语音转写</option>
              </select>
            </label>
            <div className="tool-row">
              <span><strong>yt-dlp</strong><small>{mediaSettings?.ytDlp.version ?? '未配置（平台分享链接需要）'}</small></span>
              <button onClick={() => void chooseMediaTool('yt-dlp')}>{mediaSettings?.ytDlp.available ? '更换' : '选择'}</button>
            </div>
            <small className="model-help-note">YouTube、哔哩哔哩和抖音分享链接由你自行安装的 yt-dlp 解析。Oldfolio 不捆绑该工具，不读取浏览器 Cookie，也不处理播放列表。</small>
            {transcriptionExecutionTarget === 'local' ? <>
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
            <div className="import-divider"><span>在线视频</span></div>
            <label className="field-label">媒体直链或平台分享链接
              <input disabled={importing || !vault} onChange={(event) => { setOnlineMediaUrl(event.target.value); setPlatformAccessConfirmed(false); }} placeholder="YouTube / bilibili / 抖音 / HTTPS 媒体直链" type="text" value={onlineMediaUrl} />
            </label>
            {onlineMediaIsPlatform && <label className="accept-license">
              <input checked={platformAccessConfirmed} disabled={importing || !vault} onChange={(event) => setPlatformAccessConfirmed(event.target.checked)} type="checkbox" />
              我确认有权下载并分析该视频，并遵守来源平台条款与所在地法律
            </label>}
            <button className="transcribe-button" disabled={!vault || !selectedModel || !onlineMediaUrl.trim() || !mediaSettings?.ffmpeg.available || !mediaSettings.whisper.available || (onlineMediaIsPlatform && (!mediaSettings.ytDlp.available || !platformAccessConfirmed)) || importing} onClick={() => void transcribeOnlineMediaLocally()}>
              {importing ? '处理中…' : '使用本地 Whisper 分析在线视频'}
            </button>
            </> : <>
              <p className="model-help">转录和摘要互不绑定。可单独选择 OpenAI-compatible 或腾讯云录音文件识别。</p>
              <label className="field-label">转录服务
                <select disabled={aiBusy || importing} value={cloudTranscriptionProvider} onChange={(event) => setCloudTranscriptionProvider(event.target.value as CloudTranscriptionProviderId)}>
                  <option value="openai-compatible">OpenAI-compatible 转录</option>
                  <option value="tencent-asr">腾讯云·录音文件识别</option>
                </select>
              </label>
              {cloudTranscriptionProvider === 'openai-compatible' && <>
                <label className="field-label">转录模型
                  <input value={onlineTranscriptionModel} onChange={(event) => setOnlineTranscriptionModel(event.target.value)} placeholder="gpt-4o-mini-transcribe" />
                </label>
                <small className="model-help-note">使用“摘要模块”在线服务中配置的 endpoint 和会话 API Key，转录模型在此独立选择。</small>
              </>}
              {cloudTranscriptionProvider === 'tencent-asr' && <>
                <label className="field-label">地域<input value={tencentRegion} onChange={(event) => setTencentRegion(event.target.value)} placeholder="ap-guangzhou" /></label>
                <label className="field-label">引擎模型
                  <select value={tencentEngine} onChange={(event) => setTencentEngine(event.target.value as TencentASREngineModel)}>
                    <optgroup label="基础版 · 免费资源包适用">
                      {TENCENT_ASR_ENGINES.filter((engine) => engine.billing === 'free-package').map((engine) => (
                        <option key={engine.id} value={engine.id}>{engine.label} · {engine.id}</option>
                      ))}
                    </optgroup>
                    <optgroup label="大模型版 · 需要付费资源包或后付费">
                      {TENCENT_ASR_ENGINES.filter((engine) => engine.billing === 'paid').map((engine) => (
                        <option key={engine.id} value={engine.id}>{engine.label} · {engine.id}</option>
                      ))}
                    </optgroup>
                  </select>
                </label>
                <small className="model-help-note">
                  {selectedTencentEngine?.billing === 'paid'
                    ? '当前选择大模型付费引擎，不消耗基础版每月 10 小时免费包。'
                    : '当前选择基础版引擎，可使用录音文件识别每月 10 小时免费包。'}
                </small>
                <label className="field-label">SecretId<input autoComplete="off" placeholder={savedCloudCredentialsAvailable ? '已安全保存；留空保持不变' : '请输入 SecretId'} value={tencentSecretId} onChange={(event) => setTencentSecretId(event.target.value)} /></label>
                <label className="field-label">SecretKey<input autoComplete="off" placeholder={savedCloudCredentialsAvailable ? '已安全保存；留空保持不变' : '请输入 SecretKey'} type="password" value={tencentSecretKey} onChange={(event) => setTencentSecretKey(event.target.value)} /></label>
                {savedCloudCredentialsAvailable && <small className="model-help-note">凭据已安全保留在当前会话，留空再保存不会清除。</small>}
              </>}
              <button className="transcribe-button" disabled={aiBusy || (
                cloudTranscriptionProvider === 'openai-compatible' ? !onlineTranscriptionModel.trim() :
                !tencentRegion.trim() || !tencentEngine.trim() || (tencentCredentialCount !== 0 && tencentCredentialCount !== 2) || (!savedCloudCredentialsAvailable && tencentCredentialCount !== 2)
              )} onClick={() => void saveCloudTranscriptionSettings()}>保存在线转录配置</button>
              {cloudTranscriptionSettings?.configured && <small className="model-help-note">已选：{cloudTranscriptionSettings.endpointHost} · {cloudTranscriptionSettings.model} · 凭据 {cloudTranscriptionSettings.credentialAvailable ? '本次会话可用' : '需重新输入'}</small>}
              <div className="import-divider"><span>本地媒体</span></div>
              <button className="transcribe-button" disabled={aiBusy || importing || !vault || !savedCloudCredentialsAvailable || !mediaSettings?.ffmpeg.available} onClick={() => void transcribeCloudMedia()}>
                {importing ? '处理中…' : '选择本地音视频并在线转录'}
              </button>
              <div className="import-divider"><span>在线媒体</span></div>
              <label className="field-label">媒体直链或平台分享链接
                <input disabled={aiBusy || importing || !vault} onChange={(event) => { setOnlineMediaUrl(event.target.value); setPlatformAccessConfirmed(false); }} placeholder="YouTube / bilibili / 抖音 / HTTPS 媒体直链" type="text" value={onlineMediaUrl} />
              </label>
              {onlineMediaIsPlatform && <label className="accept-license">
                <input checked={platformAccessConfirmed} disabled={aiBusy || importing || !vault} onChange={(event) => setPlatformAccessConfirmed(event.target.checked)} type="checkbox" />
                我确认有权下载并分析该视频，并遵守来源平台条款与所在地法律
              </label>}
              <button className="transcribe-button" disabled={aiBusy || importing || !vault || !onlineMediaUrl.trim() || !cloudTranscriptionSettings?.configured || !cloudTranscriptionSettings.credentialAvailable || !mediaSettings?.ffmpeg.available || (onlineMediaIsPlatform && (!mediaSettings.ytDlp.available || !platformAccessConfirmed))} onClick={() => void transcribeOnlineMedia()}>
                {importing ? '处理中…' : '分析在线音视频'}
              </button>
              {!mediaSettings?.ffmpeg.available && <small className="model-help-note">请先切回本地转录配置 FFmpeg，用于字幕检测和受控音频分块。</small>}
            </>}
            {mediaJobs.slice(0, 3).map((job) => (
              <div className="job-row" key={job.id}>
                <span>{job.stage}</span><progress max="1" value={job.progress} />
                <small>{job.chunkCount ? `${job.completedChunks}/${job.chunkCount} 分块` : `第 ${job.attempts} 次运行`}</small>
                {job.error && <small>{job.error}</small>}
                {job.canRetry && <button disabled={importing} onClick={() => void retryMediaJob(job.id)}>继续</button>}
                {job.canDelete && <button disabled={importing} onClick={() => void deleteMediaJob(job.id)}>删除任务</button>}
              </div>
            ))}
            {importError && <p className="media-error" role="alert">{importError}</p>}
          </section>
        )}
        {aiSettingsOpen && (
          <section className="media-settings ai-settings">
            <div className="section-label"><Sparkles size={14} /> 摘要模块</div>
            <label className="field-label">配置类型
              <select
                disabled={aiBusy || !vault}
                value={aiExecutionTarget}
                onChange={(event) => setAIExecutionTarget(event.target.value as AISummaryExecutionTarget)}
              >
                <option value="local">本机模型</option>
                <option value="online">在线 OpenAI-compatible</option>
              </select>
            </label>
            {aiExecutionTarget === 'local' ? (
              <>
                <p className="model-help">连接本机 Ollama 或 LM Studio。摘要数据只发送到下方回环地址，不会经过 Oldfolio 服务。</p>
                {aiSettings?.configured && <small className="model-help-note">当前设备：{LOCAL_AI_PROVIDER_LABELS[aiSettings.providerId]} · {aiSettings.model}</small>}
                <label className="field-label">服务类型
                  <select
                    disabled={aiBusy || !vault}
                    value={aiProvider}
                    onChange={(event) => {
                      const providerId = event.target.value as AILocalProviderId;
                      setAIProvider(providerId);
                      setAIEndpoint(LOCAL_AI_DEFAULT_ENDPOINTS[providerId]);
                      setAIModels([]);
                      setAIModel('');
                    }}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="openai-compatible">LM Studio（原生 API）</option>
                  </select>
                </label>
                <label className="field-label">服务地址
                  <input
                    disabled={aiBusy || !vault}
                    value={aiEndpoint}
                    onChange={(event) => setAIEndpoint(event.target.value)}
                    placeholder={LOCAL_AI_DEFAULT_ENDPOINTS[aiProvider]}
                  />
                </label>
                <button disabled={aiBusy || !vault || !aiEndpoint.trim()} onClick={() => void probeLocalAI()}>
                  {aiBusy ? '检测中…' : '检测本机模型'}
                </button>
                <label className="field-label">摘要模型
                  <select disabled={aiBusy || aiModels.length === 0} value={aiModel} onChange={(event) => {
                    const model = aiModels.find((candidate) => candidate.id === event.target.value);
                    setAIModel(event.target.value);
                    if (model?.contextWindow) setAIContextWindow(String(model.contextWindow));
                  }}>
                    {!aiModel && <option value="">尚未检测模型</option>}
                    {aiModel && !aiModels.some((model) => model.id === aiModel) && <option value={aiModel}>{aiModel}（已保存）</option>}
                    {aiModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                  </select>
                </label>
                <label className="field-label">上下文窗口（Token）
                  <input disabled={aiBusy || !vault} min="8192" max="10000000" step="1024" type="number" value={aiContextWindow} onChange={(event) => setAIContextWindow(event.target.value)} />
                </label>
                <small className="model-help-note">按当前加载模型的实际上下文填写；LM Studio 能返回该值时会自动带入。</small>
                <button className="transcribe-button" disabled={aiBusy || !aiModel || !Number.isSafeInteger(Number(aiContextWindow))} onClick={() => void saveAISettings()}>
                  保存当前设备配置
                </button>
                <small className="model-help-note">这里只保存服务类型、endpoint 和模型名，不保存任何 API Key，也不会写入 Vault。</small>
              </>
            ) : (
              <>
                <p className="model-help">摘要可独立选择在线大模型。完整摘要工作文档由你的设备直接发给服务商，Oldfolio 不代理请求。</p>
                {onlineAISettings?.configured && (
                  <small className="model-help-note">
                    已配置：{onlineAISettings.confirmedHost} · {onlineAISettings.chatModel} · API Key {onlineAISettings.keyAvailable ? '本次会话可用' : '需重新输入'}
                  </small>
                )}
                <label className="field-label">服务商预设
                  <select disabled={aiBusy || !vault} value={onlineSummaryPreset} onChange={(event) => {
                    const preset = event.target.value as OnlineSummaryPreset;
                    const defaults = ONLINE_SUMMARY_PRESETS[preset];
                    setOnlineSummaryPreset(preset);
                    if (preset !== 'custom') {
                      setOnlineAIEndpoint(defaults.endpoint);
                      setOnlineChatModel(defaults.model);
                      setOnlineContextWindow('128000');
                    }
                    setOnlineHostConfirmed(false);
                    setOnlineModels([]);
                  }}>
                    {(Object.entries(ONLINE_SUMMARY_PRESETS) as Array<[OnlineSummaryPreset, { label: string }]>).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
                  </select>
                </label>
                <label className="field-label">OpenAI-compatible 地址
                  <input
                    disabled={aiBusy || !vault}
                    onChange={(event) => {
                      setOnlineAIEndpoint(event.target.value);
                      setOnlineSummaryPreset('custom');
                      setOnlineHostConfirmed(false);
                      setOnlineModels([]);
                    }}
                    placeholder="https://api.openai.com/v1/"
                    type="url"
                    value={onlineAIEndpoint}
                  />
                </label>
                <label className="field-label">API Key（仅本次运行）
                  <input
                    autoComplete="off"
                    disabled={aiBusy || !vault}
                    onChange={(event) => setOnlineAPIKey(event.target.value)}
                    placeholder={onlineAISettings?.keyAvailable ? '当前会话已有 Key；重新配置时输入' : 'sk-…'}
                    type="password"
                    value={onlineAPIKey}
                  />
                </label>
                <label className="accept-license">
                  <input checked={onlineHostConfirmed} disabled={aiBusy || !vault} onChange={(event) => setOnlineHostConfirmed(event.target.checked)} type="checkbox" />
                  我确认将内容直接发送到 {endpointHost(onlineAIEndpoint) || '上述域名'}，并由该服务商计费
                </label>
                <button disabled={aiBusy || !vault || !onlineAPIKey.trim() || !onlineHostConfirmed || !onlineAIEndpoint.trim()} onClick={() => void probeOnlineAI()}>
                  {aiBusy ? '检测中…' : '检测在线模型'}
                </button>
                <label className="field-label">摘要模型
                  <input disabled={aiBusy || !vault} list="online-summary-models" value={onlineChatModel} onChange={(event) => setOnlineChatModel(event.target.value)} placeholder="输入或选择模型 ID" />
                  <datalist id="online-summary-models">{onlineModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</datalist>
                </label>
                <label className="field-label">上下文窗口（Token）
                  <input disabled={aiBusy || !vault} min="8192" max="10000000" step="1024" type="number" value={onlineContextWindow} onChange={(event) => setOnlineContextWindow(event.target.value)} />
                </label>
                <small className="model-help-note">请按所选模型的实际规格填写，例如一百万上下文填写 1000000；摘要会据此决定全文直传或动态分窗。</small>
                <button className="transcribe-button" disabled={aiBusy || !onlineAPIKey.trim() || !onlineHostConfirmed || !onlineChatModel.trim() || !Number.isSafeInteger(Number(onlineContextWindow))} onClick={() => void saveOnlineAISettings()}>
                  保存配置并保留本次会话 Key
                </button>
                <small className="model-help-note">endpoint、模型名和密钥引用保存在当前设备；API Key 只在主进程内存中保留，退出 Oldfolio 后清除，不写入 Vault、索引或日志。</small>
              </>
            )}
            {aiError && <p className="media-error" role="alert">{aiError}</p>}
          </section>
        )}
        <div className="file-section">
          <div className="file-section-heading">
            <div className="section-label">笔记 <span>{visibleKnowledgeDocuments.length}</span></div>
            <button
              aria-label="新建笔记"
              className="mini-icon-button"
              disabled={!vault || documentBusy}
              onClick={() => {
                setNewNoteOpen((value) => !value);
                setDocumentError('');
              }}
              title="新建笔记"
              type="button"
            ><Plus size={14} /></button>
          </div>
          {newNoteOpen && (
            <form className="new-note-form" onSubmit={(event) => void createDocument(event)}>
              <input
                aria-label="新笔记标题"
                autoFocus
                maxLength={200}
                onChange={(event) => setNewNoteTitle(event.target.value)}
                placeholder="输入笔记标题"
                value={newNoteTitle}
              />
              <button disabled={!newNoteTitle.trim() || documentBusy} type="submit">创建</button>
            </form>
          )}
          {documentError && <p className="document-error" role="alert">{documentError}</p>}
          <nav className="file-list" aria-label="知识笔记">
            {visibleKnowledgeDocuments.map((document) => (
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
        {visibleTranscripts.length > 0 && (
          <details className="file-section transcript-section">
            <summary className="section-label"><Captions size={14} /> 媒体转录 <span>{visibleTranscripts.length}</span></summary>
            <nav className="file-list" aria-label="媒体转录">
              {visibleTranscripts.map((document) => (
                <button
                  className={active?.path === document.path ? 'file-item active' : 'file-item'}
                  key={document.path}
                  onClick={() => void openDocument(document.path)}
                >
                  <Captions size={15} />
                  <span><strong>{document.title}</strong><small>{document.excerpt ?? '转录与时间轴'}</small></span>
                </button>
              ))}
            </nav>
          </details>
        )}
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
          <div className="workspace-actions">
            <div className="view-switch" role="group" aria-label="笔记显示模式">
              <button
                aria-pressed={viewMode === 'read'}
                className={viewMode === 'read' ? 'active' : ''}
                onClick={() => setViewMode('read')}
                type="button"
              ><BookOpen size={14} />阅读</button>
              <button
                aria-pressed={viewMode === 'edit'}
                className={viewMode === 'edit' ? 'active' : ''}
                onClick={() => setViewMode('edit')}
                type="button"
              ><PencilLine size={14} />编辑</button>
            </div>
            <button
              aria-label="删除当前笔记"
              className="icon-button danger-button"
              disabled={!active || documentBusy || draft !== active.content}
              onClick={() => void deleteActiveDocument()}
              title={active && draft !== active.content ? '等待当前修改保存后再删除' : '删除当前笔记'}
              type="button"
            ><Trash2 /></button>
            <button
              aria-label={detailsOpen ? '收起详情' : '展开详情'}
              aria-pressed={detailsOpen}
              className="icon-button"
              title={detailsOpen ? '收起详情' : '展开详情'}
              onClick={() => setDetailsOpen((value) => !value)}
              type="button"
            ><PanelRightClose /></button>
          </div>
        </div>
        {playback && (
          <TranscriptPlayer
            key={`${active?.path ?? ''}-${playback.resource}`}
            playback={playback}
            seekRequest={seekRequest}
          />
        )}
        {viewMode === 'read'
          ? <MarkdownReader value={draft} onOpenDocument={openWikiLink} onSeek={seekFromNote} />
          : <MarkdownEditor key={active?.path ?? 'welcome'} value={draft} onChange={setDraft} />}
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
            {!summaryPreparation && !pendingSummary && !appliedChange && (
              <>
                <p>从 Transcript 归纳视频的核心观点和论证结构。AI 只创建待审阅变更集，不会静默覆盖笔记。</p>
                <label className="field-label">摘要运行位置
                  <select disabled={aiBusy} value={aiExecutionTarget} onChange={(event) => {
                    const target = event.target.value as AISummaryExecutionTarget;
                    setAIExecutionTarget(target);
                    setSummaryMode(target === 'online' ? 'deep' : 'fast');
                  }}>
                    <option value="local">本机模型</option>
                    <option value="online">在线 OpenAI-compatible</option>
                  </select>
                </label>
                <label className="field-label">摘要模式
                  <select disabled={aiBusy} value={summaryMode} onChange={(event) => setSummaryMode(event.target.value as AISummaryMode)}>
                    <option value="fast">快速摘要 · 关闭思考 · 1 次调用</option>
                    <option disabled={aiExecutionTarget !== 'online'} value="deep">深度摘要 · 思考分析后整理 · 2 次调用</option>
                  </select>
                </label>
                <label className="field-label">输出语言
                  <select
                    disabled={aiBusy}
                    value={summaryLanguage}
                    onChange={(event) => setSummaryLanguage(event.target.value as AISummaryLanguage)}
                  >
                    <option value="auto">自动跟随转录</option>
                    <option value="zh-CN">简体中文</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <small className="ai-hint">指定语言会创建独立版本，不会覆盖“自动”摘要或另一种语言的摘要。</small>
                <small className="ai-hint">深度摘要第一阶段使用自然语言理解全文，第二阶段关闭思考并编辑润色；会增加一次模型调用和相应费用。</small>
                <button disabled={!active || !playback || aiBusy || draft !== active.content} onClick={() => void prepareAISummary()}>
                  {aiBusy ? '准备中…' : '准备摘要'}
                </button>
                {active && !playback && <small className="ai-hint">请选择由 Oldfolio 生成的 Transcript 笔记。</small>}
                {active && draft !== active.content && <small className="ai-hint">等待当前修改保存后再分析。</small>}
              </>
            )}
            {summaryPreparation && !pendingSummary && (
              <div className="ai-review">
                <dl>
                  <div><dt>目标</dt><dd>{summaryPreparation.executionTarget === 'online'
                    ? `在线 ${endpointHost(summaryPreparation.endpoint)}`
                    : `本机 ${LOCAL_AI_PROVIDER_LABELS[summaryPreparation.providerId]}`}</dd></div>
                  <div><dt>模型</dt><dd>{summaryPreparation.model}</dd></div>
                  <div><dt>模式</dt><dd>{summaryPreparation.mode === 'deep' ? '深度摘要（两阶段）' : '快速摘要'}</dd></div>
                  <div><dt>输出语言</dt><dd>{SUMMARY_LANGUAGE_LABELS[summaryPreparation.requestedOutputLanguage]}
                    {summaryPreparation.requestedOutputLanguage === 'auto'
                      ? `（识别为 ${SUMMARY_LANGUAGE_LABELS[summaryPreparation.outputLanguage]}）`
                      : ''}</dd></div>
                  <div><dt>片段</dt><dd>{summaryPreparation.segmentCount}</dd></div>
                  <div><dt>预计输入</dt><dd>约 {summaryPreparation.estimatedInputTokens.toLocaleString()} tokens</dd></div>
                  <div><dt>上下文</dt><dd>{summaryPreparation.contextWindow.toLocaleString()} tokens</dd></div>
                  <div><dt>输出预留</dt><dd>{summaryPreparation.mode === 'deep'
                    ? `分析 ${summaryPreparation.analysisOutputTokens.toLocaleString()} + 整理 ${summaryPreparation.reservedOutputTokens.toLocaleString()} tokens`
                    : `${summaryPreparation.reservedOutputTokens.toLocaleString()} tokens`}</dd></div>
                  <div><dt>工作文件</dt><dd>{summaryPreparation.workingDocumentPath}</dd></div>
                  <div><dt>处理方式</dt><dd>{summaryPreparation.processingMode === 'document-reader'
                    ? `动态分窗（每窗最多约 ${summaryPreparation.windowTokenBudget.toLocaleString()} tokens，预计 ${summaryPreparation.estimatedModelCalls} 次调用）`
                    : summaryPreparation.mode === 'deep'
                      ? `全文两阶段（预计 ${summaryPreparation.estimatedModelCalls} 次调用，输入预算 ${summaryPreparation.inputTokenBudget.toLocaleString()} tokens）`
                      : `全文单次摘要（输入预算 ${summaryPreparation.inputTokenBudget.toLocaleString()} tokens）`}</dd></div>
                  <div><dt>预计费用</dt><dd>{summaryPreparation.estimatedCost === 0 ? '¥0（本地）' : '由在线服务商计费'}</dd></div>
                </dl>
                {summaryPreparation.executionTarget === 'online' && (
                  <p className="ai-hint">确认后，下面展示的完整工作文档会由你的设备直接发送到 {endpointHost(summaryPreparation.endpoint)}。Oldfolio 不代理请求；费用和数据保留规则以该服务商为准。</p>
                )}
                <label className="field-label">摘要模板
                  <select value={summaryTemplate} onChange={(event) => setSummaryTemplate(event.target.value as AISummaryTemplate)}>
                    {summaryPreparation.availableTemplates.map((template) => (
                      <option key={template} value={template}>{SUMMARY_TEMPLATE_LABELS[template]}</option>
                    ))}
                  </select>
                </label>
                <details>
                  <summary>查看模型将读取的完整工作文档</summary>
                  <pre>{summaryPreparation.sourcePreview}</pre>
                </details>
                <button disabled={aiBusy} onClick={() => void generateAISummary()}>
                  {aiBusy ? '生成中…' : summaryPreparation.executionTarget === 'online'
                    ? '确认并发送到在线模型'
                    : '确认并发送到本机模型'}
                </button>
              </div>
            )}
            {pendingSummary && (
              <div className="ai-review">
                <div className="ai-risk"><span>{pendingSummary.riskLevel}</span> {pendingSummary.riskLevel === 'L1' ? '新建 AI 文件' : '更新 AI Wiki'}</div>
                <p><strong>{pendingSummary.targetPath}</strong><br />Markdown 摘要 · {SUMMARY_LANGUAGE_LABELS[pendingSummary.outputLanguage]} · {pendingSummary.model}</p>
                <details>
                  <summary>审阅生成内容</summary>
                  <pre>{pendingSummary.content}</pre>
                </details>
                <details>
                  <summary>审阅逐行 diff</summary>
                  <pre>{pendingSummary.diff}</pre>
                </details>
                <button disabled={aiBusy} onClick={() => void applyAIChangeSet()}>
                  {aiBusy ? '应用中…' : '批准并写入 Vault'}
                </button>
              </div>
            )}
            {appliedChange && (
              <div className="ai-applied">
                <CheckCircle2 size={16} />
                <p>摘要已写入 <strong>{appliedChange.targetPath}</strong></p>
                <button disabled={aiBusy} onClick={() => void undoAIChangeSet()}><RotateCcw size={13} /> 撤销本次写入</button>
              </div>
            )}
            {aiError && <p className="ai-error" role="alert">{aiError}</p>}
          </section>
        </aside>
      )}
    </main>
  );
}
