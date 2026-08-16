import { describe, expect, it } from 'vitest';
import {
  PluginAuthorizationError,
  PluginCapabilityBroker,
  PluginManifestError,
  validatePluginManifest,
} from './index.js';

const manifestInput = {
  id: 'dev.oldfolio.reader',
  name: 'Reader',
  version: '1.0.0',
  apiVersion: 1,
  entry: 'dist/index.js',
  capabilities: [
    { kind: 'vault.read', paths: ['notes/**'] },
    { kind: 'vault.write', paths: ['notes/generated/**'] },
    { kind: 'network.fetch', domains: ['api.example.test', '*.feeds.example.test'] },
  ],
} as const;

describe('plugin manifest and capability broker', () => {
  it('validates a strict, scoped manifest', () => {
    const manifest = validatePluginManifest(manifestInput);
    expect(manifest.id).toBe('dev.oldfolio.reader');
    expect(() => validatePluginManifest({ ...manifestInput, unexpected: true })).toThrow(PluginManifestError);
    expect(() =>
      validatePluginManifest({ ...manifestInput, entry: '../../escape.js' }),
    ).toThrow(/Unsafe/);
  });

  it('rejects undeclared grants during broker construction', () => {
    const manifest = validatePluginManifest(manifestInput);
    expect(() => new PluginCapabilityBroker(manifest, [{ kind: 'vault.delete', paths: ['notes/**'] }])).toThrow(
      /undeclared/,
    );
  });

  it('rejects path, network, and capability escalation', () => {
    const manifest = validatePluginManifest(manifestInput);
    const broker = new PluginCapabilityBroker(manifest, [
      { kind: 'vault.read', paths: ['notes/**'] },
      { kind: 'network.fetch', domains: ['api.example.test'] },
    ]);
    expect(() => broker.assertAuthorized({ kind: 'vault.read', path: 'notes/topic.md' })).not.toThrow();
    expect(() => broker.assertAuthorized({ kind: 'vault.read', path: 'assets/private.png' })).toThrow(
      PluginAuthorizationError,
    );
    expect(() => broker.assertAuthorized({ kind: 'vault.write', path: 'notes/generated/a.md' })).toThrow(
      PluginAuthorizationError,
    );
    expect(() => broker.assertAuthorized({ kind: 'network.fetch', url: 'https://evil.example.test' })).toThrow(
      PluginAuthorizationError,
    );
    expect(() => broker.assertAuthorized({ kind: 'network.fetch', url: 'http://api.example.test' })).toThrow(
      PluginAuthorizationError,
    );
  });
});
