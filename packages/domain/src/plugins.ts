import type { ISODateTime, VaultPath } from './common.js';

export type PluginCapability =
  | 'vault.read'
  | 'vault.write'
  | 'network.fetch'
  | 'assets.read'
  | 'assets.write'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'ai.invoke'
  | 'background.tasks';

export interface PluginCapabilityScope {
  readonly paths?: readonly VaultPath[];
  readonly domains?: readonly string[];
}

export interface PluginCapabilityRequest {
  readonly capability: PluginCapability;
  readonly reason: string;
  readonly scope?: PluginCapabilityScope;
}

export interface PluginCapabilityGrant {
  readonly pluginId: string;
  readonly capability: PluginCapability;
  readonly grantedAt: ISODateTime;
  readonly scope?: PluginCapabilityScope;
  readonly expiresAt?: ISODateTime;
}

export interface PluginManifest {
  readonly apiVersion: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly capabilities: readonly PluginCapabilityRequest[];
}

export interface PluginCapabilityBroker {
  request(plugin: PluginManifest, request: PluginCapabilityRequest): Promise<PluginCapabilityGrant | null>;
  isGranted(pluginId: string, capability: PluginCapability, scope?: PluginCapabilityScope): boolean;
  revoke(pluginId: string, capability?: PluginCapability): Promise<void>;
}
