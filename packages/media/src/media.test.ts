import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseOkfDocument } from '@oldfolio/okf';

import { CaptionParseError, parseCaptions } from './captions.js';
import { MediaJobStore } from './jobs.js';
import { ControlledProcessError, runControlledProcess } from './process.js';
import { compileTranscriptDocument } from './transcript-document.js';
import { verifyLocalModel } from './whisper.js';

const roots: string[] = [];
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('caption parsing and OKF compilation', () => {
  it('parses SRT and WebVTT timestamps, speakers, and markup as plain evidence', () => {
    const srt = parseCaptions('1\r\n00:00:01,250 --> 00:00:03,000\r\n<b>Hello</b> &amp; welcome\r\n');
    expect(srt.segments).toEqual([{ startMs: 1_250, endMs: 3_000, text: 'Hello & welcome' }]);

    const vtt = parseCaptions('WEBVTT\n\nvoice\n00:03.500 --> 00:05.000 align:start\n<v Alice>Use sources</v>');
    expect(vtt.segments).toEqual([{ startMs: 3_500, endMs: 5_000, text: 'Use sources', speaker: 'Alice' }]);
  });

  it('rejects malformed or backwards cues', () => {
    expect(() => parseCaptions('WEBVTT\n\n00:02.000 --> 00:01.000\nNope')).toThrow(CaptionParseError);
    expect(() => parseCaptions('not captions')).toThrow(CaptionParseError);
  });

  it('creates a strict timestamp-linked OKF Transcript', () => {
    const transcript = parseCaptions('WEBVTT\n\n00:01.250 --> 00:03.000\nA cited claim');
    const compiled = compileTranscriptDocument({
      sourceId: 'file-source-1',
      sourceHash: sha256('source'),
      sourceResource: 'assets/talk.mp4',
      sourceTitle: 'Talk',
      transcript,
      generatedAt: '2026-08-13T00:00:00.000Z',
      generator: 'caption-import:webvtt',
    });
    const parsed = parseOkfDocument(compiled.content, compiled.path.replace('bundles/personal/', ''));
    expect(parsed.valid).toBe(true);
    expect(parsed.frontmatter).toMatchObject({
      type: 'Transcript',
      oldfolio: { id: compiled.id, segment_count: 1 },
    });
    expect(compiled.content).toContain('[00:01](assets/talk.mp4#t=1.250)');
  });
});

describe('persistent media jobs', () => {
  it('persists checkpoints and requeues interrupted work after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-media-jobs-'));
    roots.push(root);
    const times = [
      new Date('2026-08-13T00:00:00.000Z'),
      new Date('2026-08-13T00:01:00.000Z'),
      new Date('2026-08-13T00:02:00.000Z'),
    ];
    const store = new MediaJobStore(root, () => times.shift() ?? new Date('2026-08-13T00:03:00.000Z'));
    await store.initialize();
    const job = await store.create({ sourceUri: 'C:/media/talk.mp4', sourceHash: sha256('media') });
    await store.checkpoint(job.id, 'transcribing', 0.4);

    const restarted = new MediaJobStore(root, () => new Date('2026-08-13T00:04:00.000Z'));
    await restarted.initialize();
    const recovered = await restarted.get(job.id);
    expect(recovered).toMatchObject({
      stage: 'queued',
      error: { code: 'interrupted', retryable: true },
    });
    expect(recovered.checkpoints.at(-1)).toMatchObject({ stage: 'transcribing', progress: 0.4 });
  });
});

describe('local media tool boundary', () => {
  it('executes argv directly and rejects non-zero exits', async () => {
    const result = await runControlledProcess({
      executablePath: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', 'literal;not-a-shell-command'],
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe('literal;not-a-shell-command');
    const failure = runControlledProcess({
      executablePath: process.execPath,
      args: ['-e', 'process.exit(7)'],
      timeoutMs: 5_000,
    });
    await expect(failure).rejects.toBeInstanceOf(ControlledProcessError);
    await expect(failure).rejects.toMatchObject({ code: 'nonzero_exit' });
  });

  it('verifies local model hash and provenance before use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-model-'));
    roots.push(root);
    const modelPath = join(root, 'model.bin');
    await writeFile(modelPath, 'model bytes');
    const descriptor = {
      id: 'whisper-test',
      filePath: modelPath,
      sha256: sha256('model bytes'),
      license: 'MIT',
      sourceUrl: 'https://example.com/model.bin',
    };
    await expect(verifyLocalModel(descriptor)).resolves.toBeUndefined();
    await expect(verifyLocalModel({ ...descriptor, sha256: sha256('wrong') })).rejects.toThrow(/hash mismatch/);
    expect(await readFile(modelPath, 'utf8')).toBe('model bytes');
  });
});
