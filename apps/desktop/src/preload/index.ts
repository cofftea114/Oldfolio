import { contextBridge, ipcRenderer } from 'electron';
import type { OldfolioDesktopApi } from '../shared/contracts';

const api: OldfolioDesktopApi = {
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  createVault: () => ipcRenderer.invoke('vault:create'),
  listDocuments: () => ipcRenderer.invoke('vault:list'),
  createDocument: (title) => ipcRenderer.invoke('vault:create-document', title),
  readDocument: (path) => ipcRenderer.invoke('vault:read', path),
  saveDocument: (path, content, expectedRevision) =>
    ipcRenderer.invoke('vault:save', { path, content, expectedRevision }),
  deleteDocument: (path, expectedRevision) =>
    ipcRenderer.invoke('vault:delete-document', { path, expectedRevision }),
  undoDocumentDeletion: (historyId) => ipcRenderer.invoke('vault:undo-document-deletion', historyId),
  search: (query) => ipcRenderer.invoke('vault:search', query),
  backlinks: (path) => ipcRenderer.invoke('vault:backlinks', path),
  importFeed: (url) => ipcRenderer.invoke('source:import-feed', url),
  importCaptions: () => ipcRenderer.invoke('media:import-captions'),
  getMediaSettings: () => ipcRenderer.invoke('media:get-settings'),
  chooseMediaTool: (kind) => ipcRenderer.invoke('media:choose-tool', kind),
  importWhisperModel: (input) => ipcRenderer.invoke('media:import-model', input),
  transcribeMedia: (input) => ipcRenderer.invoke('media:transcribe', input),
  transcribeCloudMedia: (input) => ipcRenderer.invoke('media:transcribe-cloud-file', input),
  transcribeOnlineMedia: (input) => ipcRenderer.invoke('media:transcribe-online', input),
  retryMediaJob: (jobId) => ipcRenderer.invoke('media:retry-job', jobId),
  listMediaJobs: () => ipcRenderer.invoke('media:list-jobs'),
  getTranscriptPlayback: (path) => ipcRenderer.invoke('media:get-playback', path),
  getAISettings: () => ipcRenderer.invoke('ai:get-settings'),
  getOnlineAISettings: () => ipcRenderer.invoke('ai:get-online-settings'),
  getCloudTranscriptionSettings: () => ipcRenderer.invoke('ai:get-cloud-transcription-settings'),
  probeLocalAI: (input) => ipcRenderer.invoke('ai:probe-provider', input),
  probeOnlineAI: (input) => ipcRenderer.invoke('ai:probe-online-provider', input),
  saveAISettings: (input) => ipcRenderer.invoke('ai:save-settings', input),
  saveOnlineAISettings: (input) => ipcRenderer.invoke('ai:save-online-settings', input),
  saveCloudTranscriptionSettings: (input) => ipcRenderer.invoke('ai:save-cloud-transcription-settings', input),
  prepareAISummary: (path, executionTarget) => ipcRenderer.invoke('ai:prepare-summary', { path, executionTarget }),
  generateAISummary: (input) => ipcRenderer.invoke('ai:generate-summary', input),
  applyAIChangeSet: (changeSetId) => ipcRenderer.invoke('ai:apply-changeset', changeSetId),
  undoAIChangeSet: (historyId) => ipcRenderer.invoke('ai:undo-changeset', historyId),
};

contextBridge.exposeInMainWorld('oldfolio', api);
