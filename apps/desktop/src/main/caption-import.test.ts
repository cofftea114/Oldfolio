import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaJobStore } from '@oldfolio/media';
import { parseOkfDocument } from '@oldfolio/okf';
import { VaultRepository } from '@oldfolio/vault';

import { importCaptionFile } from './caption-import.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop caption import', () => {
  it('creates immutable Source and Transcript concepts and remains idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-caption-import-'));
    roots.push(root);
    const captionPath = join(root, 'talk.vtt');
    await writeFile(captionPath, 'WEBVTT\n\n00:00.000 --> 00:02.000\nLocal knowledge survives.');
    const vault = await VaultRepository.open(join(root, 'vault'));
    await vault.initialize();
    const jobs = new MediaJobStore(join(root, 'vault/.oldfolio/cache/media-jobs'));
    await jobs.initialize();
    const now = () => new Date('2026-08-13T00:00:00.000Z');

    const first = await importCaptionFile(vault, jobs, captionPath, now);
    expect(first).toMatchObject({ createdSource: true, createdTranscript: true });
    const transcript = await vault.read(first.transcriptPath);
    expect(parseOkfDocument(transcript.text, first.transcriptPath.replace('bundles/personal/', '')).valid).toBe(true);
    expect(transcript.text).toContain('Local knowledge survives.');

    const second = await importCaptionFile(vault, jobs, captionPath, now);
    expect(second).toMatchObject({ createdSource: false, createdTranscript: false });
    expect((await jobs.list()).filter((job) => job.stage === 'completed')).toHaveLength(2);
    vault.close();
  });
});
