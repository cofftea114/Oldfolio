import type { OldfolioDesktopApi } from '../../shared/contracts';

declare global {
  interface Window {
    oldfolio: OldfolioDesktopApi;
  }
}

export {};
