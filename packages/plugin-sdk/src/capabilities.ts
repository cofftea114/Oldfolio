export const PLUGIN_CAPABILITY_KINDS = [
  'vault.read',
  'vault.write',
  'vault.delete',
  'assets.read',
  'assets.write',
  'network.fetch',
  'clipboard.read',
  'clipboard.write',
  'ai.invoke',
  'background.tasks',
] as const;

export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number];

export type PathCapabilityKind =
  | 'vault.read'
  | 'vault.write'
  | 'vault.delete'
  | 'assets.read'
  | 'assets.write';

export interface PathCapabilityRequest {
  readonly kind: PathCapabilityKind;
  /** Relative vault paths. A trailing /** grants descendants. */
  readonly paths: readonly string[];
}

export interface NetworkCapabilityRequest {
  readonly kind: 'network.fetch';
  /** Exact hosts or wildcard subdomains such as *.example.com. */
  readonly domains: readonly string[];
}

export interface SimpleCapabilityRequest {
  readonly kind: 'clipboard.read' | 'clipboard.write' | 'ai.invoke' | 'background.tasks';
}

export type PluginCapabilityRequest =
  | PathCapabilityRequest
  | NetworkCapabilityRequest
  | SimpleCapabilityRequest;

export type PluginCapabilityUse =
  | { readonly kind: PathCapabilityKind; readonly path: string }
  | { readonly kind: 'network.fetch'; readonly url: string | URL }
  | SimpleCapabilityRequest;

export const isPathCapability = (kind: PluginCapabilityKind): kind is PathCapabilityKind =>
  kind.startsWith('vault.') || kind.startsWith('assets.');
