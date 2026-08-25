import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaDeviceConfigStore, MediaJobStore, type ProcessRunner } from '@oldfolio/media';
import { parseOkfDocument } from '@oldfolio/okf';
import { VaultRepository } from '@oldfolio/vault';

import { resumeMediaTranscription, transcribeMediaFile } from './media-transcription.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop local media transcription', () => {
  it('runs configured tools, persists the media asset, and compiles a transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-transcribe-'));
    roots.push(root);
    const vaultRoot = join(root, 'vault');
    const mediaPath = join(root, 'talk.mp3');
    const modelPath = join(root, 'model.bin');
    await writeFile(mediaPath, 'fake audio');
    await writeFile(modelPath, 'model');
    const vault = await VaultRepository.open(vaultRoot);
    await vault.initialize();
    const jobs = new MediaJobStore(join(vaultRoot, '.oldfolio/cache/media-jobs'));
    await jobs.initialize();
    const device = new MediaDeviceConfigStore(join(root, 'device-media.json'));
    await device.save({
      version: 1,
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      whisperPath: 'C:/tools/whisper-cli.exe',
      models: [{
        id: 'tiny',
        filePath: modelPath,
        sha256: createHash('sha256').update('model').digest('hex'),
        license: 'accepted',
        sourceUrl: 'https://example.com/model',
        byteLength: 5,
        importedAt: '2026-08-13T00:00:00.000Z',
        licenseAcceptedAt: '2026-08-13T00:00:00.000Z',
      }],
    });
    const calls: string[][] = [];
    const result = await transcribeMediaFile(vault, jobs, device, {
      mediaPath,
      vaultRoot,
      modelId: 'tiny',
      language: 'zh',
      sourceTitle: '博主视频',
      targetBundleRoot: 'bundles/creators/creator-0123456789abcdef',
      creatorId: 'creator-0123456789abcdef',
      creatorTitle: '测试博主',
      creatorEntryId: 'yt:video:one',
    }, {
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      run: async (request) => {
        calls.push([...request.args]);
        if (request.executablePath.includes('ffprobe')) {
          return { exitCode: 0, stdout: '{"format":{"duration":"2"}}', stderr: '' };
        }
        if (request.executablePath.includes('ffmpeg')) {
          await writeFile(request.args.at(-1) ?? '', 'wav');
        } else {
          const outputIndex = request.args.indexOf('-of');
          await writeFile(`${request.args[outputIndex + 1]}.vtt`, 'WEBVTT\n\n00:00.000 --> 00:02.000\n知识应当可追溯。');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(calls.some((args) => args.includes('16000'))).toBe(true);
    expect(calls.some((args) => args.includes('-ovtt'))).toBe(true);
    expect(await readFile(join(vaultRoot, ...result.assetPath.split('/')), 'utf8')).toBe('fake audio');
    const transcript = await vault.read(result.transcriptPath);
    expect(result.transcriptPath).toMatch(/^bundles\/creators\/creator-0123456789abcdef\/wiki\/transcripts\//u);
    expect(result.sourcePath).toMatch(/^bundles\/creators\/creator-0123456789abcdef\/raw\//u);
    expect(parseOkfDocument(transcript.text, result.transcriptPath.replace('bundles/creators/creator-0123456789abcdef/', '')).valid).toBe(true);
    expect(transcript.text).toContain('知识应当可追溯。');
    expect(transcript.text).toContain('creator_entry_id: yt:video:one');
    expect((await jobs.get(result.jobId)).stage).toBe('completed');
    vault.close();
  });

  it('prefers an embedded text subtitle track and skips speech recognition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-embedded-subtitle-flow-'));
    roots.push(root);
    const vaultRoot = join(root, 'vault');
    const mediaPath = join(root, 'lesson.mkv');
    const modelPath = join(root, 'model.bin');
    await writeFile(mediaPath, 'fake video');
    await writeFile(modelPath, 'model');
    const vault = await VaultRepository.open(vaultRoot);
    await vault.initialize();
    const jobs = new MediaJobStore(join(vaultRoot, '.oldfolio/cache/media-jobs'));
    await jobs.initialize();
    const device = new MediaDeviceConfigStore(join(root, 'device-media.json'));
    await device.save({
      version: 1,
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      whisperPath: 'C:/tools/whisper-cli.exe',
      models: [{
        id: 'tiny', filePath: modelPath, sha256: createHash('sha256').update('model').digest('hex'),
        license: 'accepted', sourceUrl: 'https://example.com/model', byteLength: 5,
        importedAt: '2026-08-13T00:00:00.000Z', licenseAcceptedAt: '2026-08-13T00:00:00.000Z',
      }],
    });
    let whisperCalls = 0;
    let durationProbeCalls = 0;
    const result = await transcribeMediaFile(vault, jobs, device, {
      mediaPath, vaultRoot, modelId: 'tiny', language: 'zh',
    }, {
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      run: async (request) => {
        if (request.executablePath.includes('ffprobe')) {
          if (!request.args.includes('-select_streams')) {
            durationProbeCalls += 1;
            return { exitCode: 0, stdout: '{"format":{"duration":"60"}}', stderr: '' };
          }
          return {
            exitCode: 0,
            stdout: '{"streams":[{"index":2,"codec_name":"ass","codec_type":"subtitle","tags":{"language":"eng"},"disposition":{"default":1}},{"index":3,"codec_name":"subrip","codec_type":"subtitle","tags":{"language":"chi"},"disposition":{"default":0}}]}',
            stderr: '',
          };
        }
        if (request.executablePath.includes('ffmpeg')) {
          expect(request.args).toContain('0:3');
          await writeFile(request.args.at(-1) ?? '', 'WEBVTT\n\n00:05.000 --> 00:07.000\n内嵌字幕证据');
        } else {
          whisperCalls += 1;
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(result.transcriptSource).toBe('embedded_subtitle');
    expect(durationProbeCalls).toBe(0);
    expect(whisperCalls).toBe(0);
    const transcript = await vault.read(result.transcriptPath);
    expect(transcript.text).toContain('内嵌字幕证据');
    expect(transcript.text).toContain('ffmpeg:subtitle:subrip:stream-3');
    expect((await jobs.get(result.jobId)).checkpoints.some((checkpoint) => checkpoint.stage === 'extracting_subtitles')).toBe(true);
    vault.close();
  });

  it('retries a failed job without recomputing verified chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-transcribe-retry-'));
    roots.push(root);
    const vaultRoot = join(root, 'vault');
    const mediaPath = join(root, 'long.mp3');
    const modelPath = join(root, 'model.bin');
    await writeFile(mediaPath, 'fake long audio');
    await writeFile(modelPath, 'model');
    const vault = await VaultRepository.open(vaultRoot);
    await vault.initialize();
    const jobs = new MediaJobStore(join(vaultRoot, '.oldfolio/cache/media-jobs'));
    await jobs.initialize();
    const device = new MediaDeviceConfigStore(join(root, 'device-media.json'));
    await device.save({
      version: 1,
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      whisperPath: 'C:/tools/whisper-cli.exe',
      models: [{
        id: 'tiny', filePath: modelPath, sha256: createHash('sha256').update('model').digest('hex'),
        license: 'accepted', sourceUrl: 'https://example.com/model', byteLength: 5,
        importedAt: '2026-08-13T00:00:00.000Z', licenseAcceptedAt: '2026-08-13T00:00:00.000Z',
      }],
    });
    let firstWhisperCalls = 0;
    const firstRun: ProcessRunner = async (request) => {
      if (request.executablePath.includes('ffprobe')) return { exitCode: 0, stdout: '{"format":{"duration":"7200"}}', stderr: '' };
      if (request.executablePath.includes('ffmpeg')) {
        await writeFile(request.args.at(-1) ?? '', 'wav');
      } else {
        firstWhisperCalls += 1;
        if (firstWhisperCalls === 3) throw new Error('interrupted');
        const outputIndex = request.args.indexOf('-of');
        await writeFile(`${request.args[outputIndex + 1]}.vtt`, 'WEBVTT\n\n00:01.000 --> 00:02.000\nFirst chunk');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(transcribeMediaFile(vault, jobs, device, {
      mediaPath, vaultRoot, modelId: 'tiny',
    }, { run: firstRun })).rejects.toThrow('interrupted');
    const [failed] = await jobs.list();
    expect(failed).toMatchObject({ stage: 'failed', attempts: 1 });
    expect(failed?.checkpoints.filter((checkpoint) => checkpoint.artifactHash && checkpoint.chunkIndex !== undefined)).toHaveLength(2);

    let resumedWhisperCalls = 0;
    const result = await resumeMediaTranscription(vault, jobs, device, failed!.id, {
      run: async (request) => {
        if (request.executablePath.includes('ffprobe')) return { exitCode: 0, stdout: '{"format":{"duration":"7200"}}', stderr: '' };
        if (request.executablePath.includes('ffmpeg')) {
          await writeFile(request.args.at(-1) ?? '', 'wav');
        } else {
          resumedWhisperCalls += 1;
          const outputIndex = request.args.indexOf('-of');
          await writeFile(`${request.args[outputIndex + 1]}.vtt`, 'WEBVTT\n\n00:01.000 --> 00:02.000\nSecond chunk');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(resumedWhisperCalls).toBe(6);
    expect((await jobs.get(result.jobId))).toMatchObject({ stage: 'completed', attempts: 2 });
    const transcript = await vault.read(result.transcriptPath);
    expect(transcript.text).toContain('First chunk');
    expect(transcript.text).toContain('Second chunk');
    vault.close();
  });
});
