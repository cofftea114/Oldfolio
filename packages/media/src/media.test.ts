import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AIProvider } from '@oldfolio/domain';
import { parseOkfDocument } from '@oldfolio/okf';

import { importMediaAsset } from './asset-import.js';
import { CaptionParseError, parseCaptions } from './captions.js';
import { MediaDeviceConfigStore, probeMediaTools } from './device-config.js';
import {
  extractEmbeddedTextSubtitle,
  probeEmbeddedSubtitleTracks,
  selectEmbeddedTextSubtitle,
} from './embedded-subtitles.js';
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
import { OnlineAudioTranscriber } from './online-transcription.js';
import { parseSynthesisTranscriptPath, parseTranscriptPlaybackManifest } from './playback.js';
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
    expect(parseTranscriptPlaybackManifest(compiled.content, compiled.path)).toEqual({
      title: 'Talk — Transcript',
      resource: 'assets/talk.mp4',
      segments: [{ startMs: 1_250, label: '00:01', text: 'A cited claim' }],
    });
  });

  it('can compile a transcript into an isolated Creator bundle', () => {
    const compiled = compileTranscriptDocument({
      sourceId: 'media-creator-video',
      sourceHash: 'a'.repeat(64),
      sourceResource: 'assets/media/video.mp4',
      sourceTitle: 'Creator video',
      transcript: { text: 'Creator knowledge', segments: [{ startMs: 0, endMs: 1_000, text: 'Creator knowledge' }] },
      generatedAt: '2026-08-25T00:00:00.000Z',
      generator: 'test',
      bundleRoot: 'bundles/creators/creator-0123456789abcdef',
      creatorId: 'creator-0123456789abcdef',
      creatorTitle: 'Creator',
      creatorEntryId: 'yt:video:one',
    });
    expect(compiled.path).toMatch(/^bundles\/creators\/creator-0123456789abcdef\/wiki\/transcripts\//u);
    expect(compiled.content).toContain('creator_entry_id: yt:video:one');
  });

  it('does not create playback manifests from ordinary or malformed notes', () => {
    expect(parseTranscriptPlaybackManifest('# Note\n\n- [00:01](assets/a.mp3#t=1) text', 'notes/a.md')).toBeNull();
    const transcript = compileTranscriptDocument({
      sourceId: 'source', sourceHash: sha256('source'), sourceResource: 'assets/a.mp3',
      sourceTitle: 'Audio', generatedAt: '2026-08-13T00:00:00.000Z', generator: 'test',
      transcript: { text: 'hello', segments: [{ startMs: 1_000, endMs: 2_000, text: 'hello' }] },
    });
    expect(parseTranscriptPlaybackManifest(
      transcript.content.replace('(assets/a.mp3#t=1.000)', '(assets/other.mp3#t=1.000)'),
      transcript.path,
    )).toBeNull();
  });

  it('resolves the transcript linked by a Synthesis note for source playback', () => {
    const sourcePath = 'bundles/personal/wiki/transcripts/source.md';
    const synthesis = [
      '---',
      'type: Synthesis',
      'title: Summary',
      'oldfolio:',
      '  id: synthesis-01',
      `  source_path: ${sourcePath}`,
      '---',
      '',
      '# Summary',
    ].join('\n');

    expect(parseSynthesisTranscriptPath(synthesis, 'bundles/personal/wiki/summaries/summary.md')).toBe(sourcePath);
    expect(parseSynthesisTranscriptPath('# Ordinary note', 'notes/note.md')).toBeNull();
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

  it('deletes only failed jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-media-job-delete-'));
    roots.push(root);
    const store = new MediaJobStore(root);
    await store.initialize();
    const failed = await store.create({ sourceUri: 'assets/media/failed.mp4', sourceHash: sha256('failed') });
    const queued = await store.create({ sourceUri: 'assets/media/queued.mp4', sourceHash: sha256('queued') });
    await store.fail(failed.id, { code: 'test_failure', message: 'failed', retryable: true });

    await expect(store.deleteFailed(failed.id)).resolves.toMatchObject({ id: failed.id, stage: 'failed' });
    await expect(store.get(failed.id)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.deleteFailed(queued.id)).rejects.toThrow(/failed/u);
    await expect(store.get(queued.id)).resolves.toMatchObject({ id: queued.id, stage: 'queued' });
  });

  it('cancels an individual queued job and then allows its metadata to be deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-media-job-cancel-'));
    roots.push(root);
    const store = new MediaJobStore(root);
    await store.initialize();
    const first = await store.create({ sourceUri: 'assets/media/first.mp4', sourceHash: sha256('first') });
    const second = await store.create({ sourceUri: 'assets/media/second.mp4', sourceHash: sha256('second') });

    await expect(store.cancel(first.id)).resolves.toMatchObject({ id: first.id, stage: 'cancelled' });
    await expect(store.get(second.id)).resolves.toMatchObject({ id: second.id, stage: 'queued' });
    await expect(store.deleteTerminal(first.id)).resolves.toMatchObject({ id: first.id, stage: 'cancelled' });
    await expect(store.get(first.id)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('local media tool boundary', () => {
  it('detects embedded subtitle kinds and selects the preferred text language', async () => {
    const tracks = await probeEmbeddedSubtitleTracks('C:/vault/movie.mkv', 'C:/tools/ffmpeg.exe', () => Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({ streams: [
        { index: 2, codec_name: 'hdmv_pgs_subtitle', codec_type: 'subtitle', tags: { language: 'zho' }, disposition: { default: 1 } },
        { index: 3, codec_name: 'ass', codec_type: 'subtitle', tags: { language: 'eng', title: 'English' }, disposition: { default: 1 } },
        { index: 4, codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'chi' }, disposition: { default: 0 } },
      ] }),
      stderr: '',
    }));
    expect(tracks).toMatchObject([
      { index: 2, kind: 'bitmap', language: 'zho' },
      { index: 3, kind: 'text', language: 'eng', title: 'English' },
      { index: 4, kind: 'text', language: 'chi' },
    ]);
    expect(selectEmbeddedTextSubtitle(tracks, 'zh')).toMatchObject({ index: 4, language: 'chi' });
    expect(selectEmbeddedTextSubtitle(tracks, 'en')).toMatchObject({ index: 3, language: 'eng' });
    expect(selectEmbeddedTextSubtitle(tracks.filter((track) => track.kind === 'bitmap'))).toBeNull();
  });

  it('extracts a selected text subtitle track as timestamped WebVTT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-embedded-subtitle-'));
    roots.push(root);
    const outputPath = join(root, 'embedded.vtt');
    const calls: string[][] = [];
    const transcript = await extractEmbeddedTextSubtitle(
      join(root, 'movie.mkv'),
      'C:/tools/ffmpeg.exe',
      { index: 3, codec: 'ass', kind: 'text', language: 'zho', default: true, forced: false },
      outputPath,
      async (request) => {
        calls.push([...request.args]);
        await writeFile(outputPath, 'WEBVTT\n\n00:01.000 --> 00:03.000\nEmbedded evidence');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );
    expect(calls[0]).toContain('0:3');
    expect(calls[0]).toContain('webvtt');
    expect(transcript).toMatchObject({ language: 'zho', segments: [{ startMs: 1_000, endMs: 3_000, text: 'Embedded evidence' }] });
  });

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
    await store.setTool('yt-dlp', 'C:/tools/yt-dlp.exe');
    const config = await store.load();
    const calls: string[] = [];
    const status = await probeMediaTools(config, (request) => {
      calls.push(`${request.executablePath.replaceAll('\\', '/')} ${request.args.join(' ')}`);
      return Promise.resolve({ stdout: `${request.args[0] === '-version' ? 'media tool 8.0' : 'whisper.cpp 1.7'}`, stderr: '' });
    });
    expect(status.ffmpeg).toMatchObject({ available: true, version: 'media tool 8.0' });
    expect(status.whisper).toMatchObject({ available: true, version: 'whisper.cpp 1.7' });
    expect(status.ytDlp).toMatchObject({ available: true });
    expect(calls).toEqual([
      'C:/tools/ffmpeg.exe -version',
      'C:/tools/ffprobe.exe -version',
      'C:/tools/whisper-cli.exe --help',
      'C:/tools/yt-dlp.exe --version',
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

  it('transcribes bounded online audio chunks and resumes from verified artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-transcription-'));
    roots.push(root);
    const mediaPath = join(root, 'video.mp4');
    await writeFile(mediaPath, 'video');
    let providerCalls = 0;
    const provider: AIProvider = {
      id: 'openai-compatible', displayName: 'Online', capabilities: ['transcription'],
      listModels: () => Promise.resolve([]),
      complete: () => Promise.reject(new Error('not used')),
      transcribe: (_config, request) => {
        providerCalls += 1;
        expect(request.mediaUri).toMatch(/online-chunk-\d{5}\.m4a$/u);
        return Promise.resolve({
          text: `chunk ${providerCalls}`,
          segments: [{ startMs: 500, endMs: 1_500, text: `chunk ${providerCalls}` }],
        });
      },
    };
    const processCalls: string[][] = [];
    const completed: { index: number; artifactHash: string }[] = [];
    const transcriber = new OnlineAudioTranscriber((request) => {
      processCalls.push([...request.args]);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const baseOptions = {
      ffmpegPath: 'ffmpeg', workDirectory: root, durationMs: 25_000, chunkDurationMs: 10_000,
      provider,
      providerConfig: {
        providerId: 'openai-compatible', endpoint: 'https://api.example.test/v1/', model: 'chat',
      },
      providerContext: { resolveSecret: () => Promise.resolve('secret') },
      model: 'transcribe',
    } as const;
    const result = await transcriber.transcribe(mediaPath, {
      ...baseOptions,
      onChunkComplete: (chunk, _path, artifactHash) => { completed.push({ index: chunk.index, artifactHash }); },
    });
    expect(result.segments.map((segment) => segment.startMs)).toEqual([500, 10_500, 20_500]);
    expect(processCalls).toHaveLength(3);
    expect(processCalls[0]).toContain('64k');
    expect(providerCalls).toBe(3);

    const resumed = new OnlineAudioTranscriber(() => Promise.reject(new Error('must reuse cache')));
    const resumedResult = await resumed.transcribe(mediaPath, { ...baseOptions, completedChunks: completed });
    expect(resumedResult.segments.map((segment) => segment.startMs)).toEqual([500, 10_500, 20_500]);
    expect(providerCalls).toBe(3);
  });
});
