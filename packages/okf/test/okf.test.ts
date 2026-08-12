import { describe, expect, it } from 'vitest';

import {
  deriveTrustTier,
  getReservedKind,
  parseOkfDocument,
  serializeNewOkfConcept,
  validateBundlePath,
} from '../src/index.js';

describe('OKF v0.2 parser', () => {
  it('accepts a minimal conforming concept without changing source or body', () => {
    const source = '---\r\ntype: Reference\r\n---\r\n# Kept\r\n\r\nBody  \r\n';
    const parsed = parseOkfDocument(source, 'concepts/minimal.md');

    expect(parsed.valid).toBe(true);
    expect(parsed.kind).toBe('concept');
    if (parsed.kind !== 'concept') throw new Error('Expected a concept document');
    expect(parsed.source).toBe(source);
    expect(parsed.body).toBe('# Kept\r\n\r\nBody  \r\n');
    expect(parsed.frontmatter?.type).toBe('Reference');
  });

  it('rejects a concept whose type is missing or empty', () => {
    const missing = parseOkfDocument('---\ntitle: No type\n---\nText', 'missing.md');
    const empty = parseOkfDocument('---\ntype: ""\n---\nText', 'empty.md');

    expect(missing.valid).toBe(false);
    expect(missing.issues.some((issue) => issue.path[0] === 'type')).toBe(true);
    expect(empty.valid).toBe(false);
  });

  it('preserves unknown types, fields, raw YAML, and the original source', () => {
    const source = '---\ntype: Future Widget\nvendor_field:\n  nested: 7\n---\nBody';
    const parsed = parseOkfDocument(source, 'future.md');

    expect(parsed.valid).toBe(true);
    if (parsed.kind !== 'concept') throw new Error('Expected a concept document');
    expect(parsed.source).toBe(source);
    expect(parsed.frontmatterSource).toBe('type: Future Widget\nvendor_field:\n  nested: 7\n');
    expect(parsed.rawFrontmatter?.vendor_field).toEqual({ nested: 7 });
    expect(parsed.frontmatter?.vendor_field).toEqual({ nested: 7 });
  });

  it('recognizes reserved files and permits version frontmatter only at root index', () => {
    const rootIndex = parseOkfDocument(
      '---\nokf_version: "0.2"\n---\n# Topics\n',
      'index.md',
    );
    const nestedIndex = parseOkfDocument('# Nested\n', 'topics/index.md');
    const log = parseOkfDocument('# Updates\n## 2026-08-12\n* **Creation**: Started.\n', 'log.md');

    expect(getReservedKind('topics/index.md')).toBe('index');
    expect(rootIndex).toMatchObject({ kind: 'index', valid: true });
    expect(nestedIndex).toMatchObject({ kind: 'index', valid: true, frontmatter: null });
    expect(log).toMatchObject({ kind: 'log', valid: true, frontmatter: null });
  });

  it('requires oldfolio.id for each Oldfolio profile type', () => {
    const missing = parseOkfDocument('---\ntype: Transcript\n---\nText', 'transcript.md');
    const present = parseOkfDocument(
      '---\ntype: Transcript\noldfolio:\n  id: transcript-01\n---\nText',
      'transcript.md',
    );

    expect(missing.valid).toBe(false);
    expect(missing.issues.some((issue) => issue.path.join('.') === 'oldfolio.id')).toBe(true);
    expect(present.valid).toBe(true);
    if (present.kind !== 'concept') throw new Error('Expected a concept document');
    expect(present.frontmatter?.oldfolio?.id).toBe('transcript-01');
  });

  it('validates sources and normalizes a bare verified mapping', () => {
    const parsed = parseOkfDocument(
      [
        '---',
        'type: Reference',
        'sources:',
        '  - id: spec',
        '    resource: https://example.test/spec',
        '    usage_count: 12',
        '    last_modified: 2026-08-01',
        'verified: { by: human:owner, at: 2026-08-12T10:00:00Z }',
        '---',
        'Verified.[^spec]',
      ].join('\n'),
      'verified.md',
    );

    expect(parsed.valid).toBe(true);
    if (parsed.kind !== 'concept') throw new Error('Expected a concept document');
    expect(parsed.frontmatter?.sources?.[0]?.resource).toBe('https://example.test/spec');
    expect(parsed.frontmatter?.verified).toHaveLength(1);
    if (parsed.kind === 'concept' && parsed.frontmatter !== null) {
      expect(deriveTrustTier(parsed.frontmatter)).toBe('human-reviewed');
    }
  });

  it('rejects malformed source and verification families', () => {
    const parsed = parseOkfDocument(
      [
        '---',
        'type: Reference',
        'sources:',
        '  - id: missing-resource',
        'verified: { by: human:owner, at: yesterday }',
        '---',
        'Text',
      ].join('\n'),
      'invalid-trust.md',
    );

    expect(parsed.valid).toBe(false);
    expect(parsed.issues.some((issue) => issue.path.join('.') === 'sources.0.resource')).toBe(true);
    expect(parsed.issues.some((issue) => issue.path[0] === 'verified')).toBe(true);
  });
});

describe('OKF bundle paths and new concept serialization', () => {
  it('rejects absolute, traversal, and backslash paths while allowing referenced assets', () => {
    expect(validateBundlePath('/absolute.md').valid).toBe(false);
    expect(validateBundlePath('../escape.md').valid).toBe(false);
    expect(validateBundlePath('folder\\note.md').valid).toBe(false);
    expect(validateBundlePath('references/data.json').valid).toBe(true);
    expect(parseOkfDocument('data', 'references/data.json').valid).toBe(false);
  });

  it('serializes a new profile concept and parses it back', () => {
    const serialized = serializeNewOkfConcept({
      frontmatter: {
        type: 'Concept',
        title: 'Local first',
        oldfolio: { id: 'concept-local-first' },
        extension: { kept: true },
      },
      body: '# Local first\n',
    });
    const parsed = parseOkfDocument(serialized, 'wiki/local-first.md');

    expect(serialized).toContain('oldfolio:\n  id: concept-local-first');
    expect(parsed.valid).toBe(true);
    if (parsed.kind !== 'concept') throw new Error('Expected a concept document');
    expect(parsed.frontmatter?.extension).toEqual({ kept: true });
    expect(parsed.body).toBe('# Local first\n');
  });
});
