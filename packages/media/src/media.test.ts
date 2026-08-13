import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseOkfDocument } from '@oldfolio/okf';

import { importMediaAsset } from './asset-import.js';
import { CaptionParseError, parseCaptions } from './captions.js';
import { MediaDeviceConfigStore, probeMediaTools } from './device-config.js';
import { MediaJobStore } from './jobs.js';
import {
  InsufficientDiskSpaceError,
  deriveFfprobePath,
  ensureAvailableDiskSpace,
  estimateTranscriptionWorkingBytes,
  planMediaChunks,
  probeMediaDuration,
} from './media-analysis.js';
import { importLocalModel } from './model-store.js';
import { ControlledProcessError, runControlledProcess } from './process.js';
import { compileTranscriptDocument } from './transcript-document.js';
import { WhisperCppTranscriber, verifyLocalModel } from './whisper.js';

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
    const job = await store.create({
      sourceUri: 'assets/media/talk.mp4',
      sourceHash: sha256('media'),
      request: {
        kind: 'local_transcription',
        sourceTitle: 'talk.mp4',
        importedFrom: 'C:/media/talk.mp4',
        modelId: 'tiny',
        modelHash: sha256('model'),
        language: 'zh',
        chunkDurationMs: 900_000,
      },
    });
    await store.checkpoint(job.id, 'transcribing', 0.4, {
      artifactPath: '.oldfolio/cache/media-work/chunk-0001.vtt',
      artifactHash: sha256('chunk'),
      chunkIndex: 1,
      chunkCount: 4,
    });

    const restarted = new MediaJobStore(root, () => new Date('2026-08-13T00:04:00.000Z'));
    await restarted.initialize();
    const recovered = await restarted.get(job.id);
    expect(recovered).toMatchObject({
      stage: 'queued',
      error: { code: 'interrupted', retryable: true },
    });
    expect(recovered.checkpoints.at(-1)).toMatchObject({ stage: 'transcribing', progress: 0.4 });
    expect(recovered.request).toMatchObject({ modelId: 'tiny', modelHash: sha256('model'), chunkDurationMs: 900_000 });
    expect(recovered.checkpoints.at(-1)).toMatchObject({ chunkIndex: 1, chunkCount: 4 });
  });
});

describe('local media tool boundary', () => {
  it('probes duration and plans deterministic chunks without decoding the full media', async () => {
    const calls: string[] = [];
    const duration = await probeMediaDuration('C:/vault/talk.mp4', 'C:/tools/ffmpeg.exe', (request) => {
      calls.push(`${request.executablePath.replaceAll('\\', '/')} ${request.args.join(' ')}`);
      return Promise.resolve({ exitCode: 0, stdout: '{"format":{"duration":"3600.125"}}', stderr: '' });
    });
    expect(duration).toBe(3_600_125);
    expect(deriveFfprobePath('C:/tools/ffmpeg.exe').replaceAll('\\', '/')).toBe('C:/tools/ffprobe.exe');
    expect(calls[0]).toContain('-show_entries format=duration');
    const chunks = planMediaChunks(duration, 15 * 60_000);
    expect(chunks).toHaveLength(5);
    expect(chunks.at(-1)).toEqual({ index: 4, startMs: 3_600_000, endMs: 3_600_125 });
  });

  it('fails before transcription when the working volume lacks reserved space', async () => {
    const required = estimateTranscriptionWorkingBytes(15 * 60_000);
    await expect(ensureAvailableDiskSpace('C:/vault', required, () => Promise.resolve({
      bsize: 4_096n,
      bavail: 1n,
    }))).rejects.toBeInstanceOf(InsufficientDiskSpaceError);
  });

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

  it('resumes from verified chunk artifacts and offsets their timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-resumable-whisper-'));
    roots.push(root);
    const mediaPath = join(root, 'talk.mp4');
    const modelPath = join(root, 'model.bin');
    await writeFile(mediaPath, 'media');
    await writeFile(modelPath, 'model');
    const model = {
      id: 'tiny',
      filePath: modelPath,
      sha256: sha256('model'),
      license: 'MIT',
      sourceUrl: 'https://example.com/model.bin',
    };
    const completed: { index: number; artifactHash: string }[] = [];
    let firstWhisperCalls = 0;
    const first = new WhisperCppTranscriber(async (request) => {
      if (request.executablePath.includes('whisper')) {
        firstWhisperCalls += 1;
        if (firstWhisperCalls === 3) throw new Error('simulated interruption');
        const outputBase = request.args[request.args.indexOf('-of') + 1];
        if (!outputBase) throw new Error('missing output path');
        await writeFile(`${outputBase}.vtt`, 'WEBVTT\n\n00:01.000 --> 00:02.000\nEvidence');
      } else {
        const wavePath = request.args.at(-1);
        if (!wavePath) throw new Error('missing wave path');
        await writeFile(wavePath, 'wave');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await expect(first.transcribeResumable(mediaPath, {
      ffmpegPath: 'ffmpeg',
      whisperPath: 'whisper-cli',
      model,
      workDirectory: root,
      durationMs: 35_000,
      chunkDurationMs: 10_000,
      onChunkComplete: (chunk, _path, artifactHash) => {
        completed.push({ index: chunk.index, artifactHash });
      },
    })).rejects.toThrow('simulated interruption');
    expect(completed).toHaveLength(2);

    let resumedWhisperCalls = 0;
    const resumed = new WhisperCppTranscriber(async (request) => {
      if (request.executablePath.includes('whisper')) {
        resumedWhisperCalls += 1;
        const outputBase = request.args[request.args.indexOf('-of') + 1];
        if (!outputBase) throw new Error('missing output path');
        await writeFile(`${outputBase}.vtt`, 'WEBVTT\n\n00:01.000 --> 00:02.000\nEvidence');
      } else {
        const wavePath = request.args.at(-1);
        if (!wavePath) throw new Error('missing wave path');
        await writeFile(wavePath, 'wave');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const result = await resumed.transcribeResumable(mediaPath, {
      ffmpegPath: 'ffmpeg',
      whisperPath: 'whisper-cli',
      model,
      workDirectory: root,
      durationMs: 35_000,
      chunkDurationMs: 10_000,
      completedChunks: completed,
    });
    expect(resumedWhisperCalls).toBe(2);
    expect(result.segments.map((segment) => segment.startMs)).toEqual([1_000, 11_000, 21_000, 31_000]);
  });

  it('stores device-only tool paths and probes configured executables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-device-media-'));
    roots.push(root);
    const store = new MediaDeviceConfigStore(join(root, 'media.json'));
    expect(await store.load()).toEqual({ version: 1, models: [] });
    await store.setTool('ffmpeg', 'C:/tools/ffmpeg.exe');
    await store.setTool('whisper', 'C:/tools/whisper-cli.exe');
    const config = await store.load();
    const calls: string[] = [];
    const status = await probeMediaTools(config, (request) => {
      calls.push(`${request.executablePath.replaceAll('\\', '/')} ${request.args.join(' ')}`);
      return Promise.resolve({ stdout: `${request.args[0] === '-version' ? 'media tool 8.0' : 'whisper.cpp 1.7'}`, stderr: '' });
    });
    expect(status.ffmpeg).toMatchObject({ available: true, version: 'media tool 8.0' });
    expect(status.whisper).toMatchObject({ available: true, version: 'whisper.cpp 1.7' });
    expect(calls).toEqual([
      'C:/tools/ffmpeg.exe -version',
      'C:/tools/ffprobe.exe -version',
      'C:/tools/whisper-cli.exe --help',
    ]);

    const missingProbe = await probeMediaTools(config, (request) => {
      if (request.executablePath.includes('ffprobe')) return Promise.reject(new Error('not found'));
      return Promise.resolve({ stdout: 'available', stderr: '' });
    });
    expect(missingProbe.ffmpeg).toMatchObject({ available: false });
    expect(missingProbe.ffmpeg.error).toContain('ffprobe is required');
  });

  it('imports models and media assets by streaming content hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-local-assets-'));
    roots.push(root);
    const sourceModel = join(root, 'tiny.bin');
    const sourceMedia = join(root, 'talk.mp3');
    await writeFile(sourceModel, 'model bytes');
    await writeFile(sourceMedia, 'media bytes');
    const model = await importLocalModel({
      sourcePath: sourceModel,
      modelDirectory: join(root, 'models'),
      id: 'tiny',
      license: 'user-confirmed-license',
      sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp',
      licenseAccepted: true,
      expectedSha256: sha256('model bytes'),
      now: () => new Date('2026-08-13T00:00:00.000Z'),
    });
    expect(model).toMatchObject({ id: 'tiny', sha256: sha256('model bytes'), byteLength: 11 });
    expect(await readFile(model.filePath, 'utf8')).toBe('model bytes');
    await expect(importLocalModel({
      sourcePath: sourceModel,
      modelDirectory: join(root, 'models'),
      id: 'bad',
      license: 'accepted',
      sourceUrl: 'https://example.com/model',
      licenseAccepted: true,
      expectedSha256: sha256('wrong'),
    })).rejects.toThrow(/trusted manifest/);

    const asset = await importMediaAsset(sourceMedia, join(root, 'vault'));
    expect(asset.vaultPath).toBe(`assets/media/${sha256('media bytes')}.mp3`);
    expect(await readFile(asset.absolutePath, 'utf8')).toBe('media bytes');
  });
});
