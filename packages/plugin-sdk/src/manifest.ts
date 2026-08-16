import {
  PLUGIN_CAPABILITY_KINDS,
  isPathCapability,
  type NetworkCapabilityRequest,
  type PathCapabilityRequest,
  type PluginCapabilityKind,
  type PluginCapabilityRequest,
  type SimpleCapabilityRequest,
} from './capabilities.js';

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly entry: string;
  readonly description?: string;
  readonly capabilities: readonly PluginCapabilityRequest[];
}

export class PluginManifestError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

const CAPABILITY_SET = new Set<string>(PLUGIN_CAPABILITY_KINDS);
const isRecord = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input);

const requiredString = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new PluginManifestError(`${key} is required.`, key);
  return value;
};

export const validatePluginPath = (path: string, field = 'path'): string => {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  const withoutGlob = normalized.endsWith('/**') ? normalized.slice(0, -3) : normalized;
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.split('/').includes('..') ||
    /[*?[\]]/u.test(withoutGlob)
  ) {
    throw new PluginManifestError(`Unsafe or unsupported relative path scope: ${path}`, field);
  }
  return normalized;
};

export const validatePluginDomain = (domain: string): string => {
  const normalized = domain.toLowerCase();
  const hostname = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
  if (
    !hostname.includes('.') ||
    hostname === 'localhost' ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname) ||
    hostname.includes('..')
  ) {
    throw new PluginManifestError(`Invalid network domain scope: ${domain}`, 'capabilities');
  }
  return normalized;
};

const parseCapability = (input: unknown): PluginCapabilityRequest => {
  if (!isRecord(input) || typeof input.kind !== 'string' || !CAPABILITY_SET.has(input.kind)) {
    throw new PluginManifestError('Unknown plugin capability.', 'capabilities');
  }
  const kind = input.kind as PluginCapabilityKind;
  if (isPathCapability(kind)) {
    if (!Array.isArray(input.paths) || input.paths.length === 0 || !input.paths.every((path) => typeof path === 'string')) {
      throw new PluginManifestError(`Capability ${kind} requires at least one path scope.`, 'capabilities');
    }
    const request: PathCapabilityRequest = {
      kind,
      paths: Object.freeze([...new Set(input.paths.map((path) => validatePluginPath(path)))]),
    };
    return Object.freeze(request);
  }
  if (kind === 'network.fetch') {
    if (!Array.isArray(input.domains) || input.domains.length === 0 || !input.domains.every((domain) => typeof domain === 'string')) {
      throw new PluginManifestError('network.fetch requires at least one domain scope.', 'capabilities');
    }
    const request: NetworkCapabilityRequest = {
      kind,
      domains: Object.freeze([...new Set(input.domains.map(validatePluginDomain))]),
    };
    return Object.freeze(request);
  }
  const request: SimpleCapabilityRequest = { kind };
  return Object.freeze(request);
};

/** Strict runtime parser for untrusted plugin.json files. */
export function validatePluginManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) throw new PluginManifestError('Plugin manifest must be an object.');
  const allowed = new Set(['id', 'name', 'version', 'apiVersion', 'entry', 'description', 'capabilities']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new PluginManifestError(`Unknown manifest fields: ${unknown.join(', ')}.`);

  const id = requiredString(input, 'id');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(id)) {
    throw new PluginManifestError('Plugin id must be a lowercase reverse-domain identifier.', 'id');
  }
  const version = requiredString(input, 'version');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new PluginManifestError('Plugin version must use semantic versioning.', 'version');
  }
  if (input.apiVersion !== 1) throw new PluginManifestError('Unsupported plugin API version.', 'apiVersion');
  const entry = validatePluginPath(requiredString(input, 'entry'), 'entry');
  if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) {
    throw new PluginManifestError('Plugin entry must be a JavaScript module.', 'entry');
  }
  if (!Array.isArray(input.capabilities)) {
    throw new PluginManifestError('Plugin capabilities must be an array.', 'capabilities');
  }
  const capabilities = input.capabilities.map(parseCapability);
  const duplicateKinds = capabilities
    .map((capability) => capability.kind)
    .filter((kind, index, all) => all.indexOf(kind) !== index);
  if (duplicateKinds.length > 0) {
    throw new PluginManifestError(`Duplicate capabilities: ${[...new Set(duplicateKinds)].join(', ')}.`);
  }
  const description = input.description;
  if (description !== undefined && typeof description !== 'string') {
    throw new PluginManifestError('Plugin description must be a string.', 'description');
  }
  return Object.freeze({
    id,
    name: requiredString(input, 'name'),
    version,
    apiVersion: 1,
    entry,
    capabilities: Object.freeze(capabilities),
    ...(description === undefined ? {} : { description }),
  });
}
