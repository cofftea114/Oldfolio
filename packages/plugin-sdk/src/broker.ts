import {
  isPathCapability,
  type NetworkCapabilityRequest,
  type PathCapabilityRequest,
  type PluginCapabilityRequest,
  type PluginCapabilityUse,
} from './capabilities.js';
import { validatePluginDomain, validatePluginPath, type PluginManifest } from './manifest.js';

export class PluginAuthorizationError extends Error {
  constructor(
    readonly pluginId: string,
    readonly capability: PluginCapabilityUse['kind'],
    message: string,
  ) {
    super(message);
    this.name = 'PluginAuthorizationError';
  }
}

const pathMatches = (scope: string, path: string): boolean => {
  const normalizedScope = validatePluginPath(scope);
  const normalizedPath = validatePluginPath(path);
  if (!normalizedScope.endsWith('/**')) return normalizedScope === normalizedPath;
  const directory = normalizedScope.slice(0, -3).replace(/\/$/u, '');
  return normalizedPath === directory || normalizedPath.startsWith(`${directory}/`);
};

const domainMatches = (scope: string, hostname: string): boolean => {
  const normalizedScope = validatePluginDomain(scope);
  const normalizedHost = hostname.toLowerCase();
  if (!normalizedScope.startsWith('*.')) return normalizedScope === normalizedHost;
  const base = normalizedScope.slice(2);
  return normalizedHost.endsWith(`.${base}`) && normalizedHost !== base;
};

const findCapability = (
  capabilities: readonly PluginCapabilityRequest[],
  kind: PluginCapabilityUse['kind'],
): PluginCapabilityRequest | undefined => capabilities.find((capability) => capability.kind === kind);

const assertGrantIsDeclared = (manifest: PluginManifest, grant: PluginCapabilityRequest): void => {
  const requested = findCapability(manifest.capabilities, grant.kind);
  if (!requested) throw new Error(`Cannot grant undeclared capability "${grant.kind}".`);
  if (isPathCapability(grant.kind) && 'paths' in grant) {
    const requestedPaths = (requested as PathCapabilityRequest).paths;
    for (const path of grant.paths) {
      if (!requestedPaths.some((scope) => pathMatches(scope, path) || scope === path)) {
        throw new Error(`Granted path "${path}" exceeds the plugin declaration.`);
      }
    }
  } else if (grant.kind === 'network.fetch') {
    const requestedDomains = (requested as NetworkCapabilityRequest).domains;
    for (const domain of grant.domains) {
      if (!requestedDomains.includes(domain)) {
        throw new Error(`Granted domain "${domain}" exceeds the plugin declaration.`);
      }
    }
  }
};

/** Host-side least-privilege authorization helper. */
export class PluginCapabilityBroker {
  readonly #manifest: PluginManifest;
  readonly #grants: readonly PluginCapabilityRequest[];

  constructor(manifest: PluginManifest, grants: readonly PluginCapabilityRequest[]) {
    for (const grant of grants) assertGrantIsDeclared(manifest, grant);
    this.#manifest = manifest;
    this.#grants = Object.freeze([...grants]);
  }

  isAuthorized(use: PluginCapabilityUse): boolean {
    const grant = findCapability(this.#grants, use.kind);
    if (!grant) return false;
    if (isPathCapability(use.kind) && 'path' in use) {
      return (grant as PathCapabilityRequest).paths.some((scope) => pathMatches(scope, use.path));
    }
    if (use.kind === 'network.fetch') {
      let url: URL;
      try {
        url = use.url instanceof URL ? use.url : new URL(use.url);
      } catch {
        return false;
      }
      if (url.protocol !== 'https:' || url.username || url.password) return false;
      return (grant as NetworkCapabilityRequest).domains.some((domain) => domainMatches(domain, url.hostname));
    }
    return true;
  }

  assertAuthorized(use: PluginCapabilityUse): void {
    if (!this.isAuthorized(use)) {
      throw new PluginAuthorizationError(
        this.#manifest.id,
        use.kind,
        `Plugin "${this.#manifest.id}" is not authorized to use "${use.kind}" for this resource.`,
      );
    }
  }
}
