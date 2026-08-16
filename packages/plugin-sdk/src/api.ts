import type { PluginCapabilityKind } from './capabilities.js';
import type { PluginManifest } from './manifest.js';

export interface PluginCommand {
  readonly id: string;
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly grantedCapabilities: readonly PluginCapabilityKind[];
  registerCommand(command: PluginCommand): () => void;
}

export interface OldfolioPlugin {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
