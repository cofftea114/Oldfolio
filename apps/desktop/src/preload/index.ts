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
};

contextBridge.exposeInMainWorld('oldfolio', api);
