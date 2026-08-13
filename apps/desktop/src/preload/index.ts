import { contextBridge, ipcRenderer } from 'electron';
import type { OldfolioDesktopApi } from '../shared/contracts';

const api: OldfolioDesktopApi = {
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  createVault: () => ipcRenderer.invoke('vault:create'),
  listDocuments: () => ipcRenderer.invoke('vault:list'),
  readDocument: (path) => ipcRenderer.invoke('vault:read', path),
  saveDocument: (path, content, expectedRevision) =>
    ipcRenderer.invoke('vault:save', { path, content, expectedRevision }),
  search: (query) => ipcRenderer.invoke('vault:search', query),
  backlinks: (path) => ipcRenderer.invoke('vault:backlinks', path),
  importFeed: (url) => ipcRenderer.invoke('source:import-feed', url),
  importCaptions: () => ipcRenderer.invoke('media:import-captions'),
  getMediaSettings: () => ipcRenderer.invoke('media:get-settings'),
  chooseMediaTool: (kind) => ipcRenderer.invoke('media:choose-tool', kind),
  importWhisperModel: (input) => ipcRenderer.invoke('media:import-model', input),
  transcribeMedia: (input) => ipcRenderer.invoke('media:transcribe', input),
  retryMediaJob: (jobId) => ipcRenderer.invoke('media:retry-job', jobId),
  listMediaJobs: () => ipcRenderer.invoke('media:list-jobs'),
  getTranscriptPlayback: (path) => ipcRenderer.invoke('media:get-playback', path),
};

contextBridge.exposeInMainWorld('oldfolio', api);
