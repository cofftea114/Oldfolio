import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { MediaDeviceConfigStore, MediaJobStore } from '@oldfolio/media';
import { VaultRepository } from '@oldfolio/vault';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OnlineAIConfigStore, OnlineAIService, SessionSecretStore } from './online-ai.js';
import { CloudTranscriptionConfigStore, CloudTranscriptionService } from './cloud-transcription.js';
import { transcribeCloudMediaFile, transcribeOnlineMediaUrl } from './online-media-transcription.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop online media transcription', () => {
  it('downloads a direct media URL, uploads bounded audio, and compiles a timestamped transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-online-media-flow-'));
    roots.push(root);
    const vaultRoot = join(root, 'vault');
    const vault = await VaultRepository.open(vaultRoot);
    await vault.initialize();
    const jobs = new MediaJobStore(join(vaultRoot, '.oldfolio/cache/media-jobs'));
    await jobs.initialize();
    const device = new MediaDeviceConfigStore(join(root, 'device-media.json'));
    await device.save({ version: 1, ffmpegPath: 'C:/tools/ffmpeg.exe', models: [] });
    const transcriptionFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      text: '在线视频观点。',
      language: 'zh',
      segments: [{ start: 0.5, end: 1.75, text: '在线视频观点。' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const secrets = new SessionSecretStore();
    const readMedia = async (uri: string) => ({
      bytes: await readFile(uri), fileName: basename(uri), mimeType: 'audio/mp4',
    });
    const onlineAI = new OnlineAIService(
      new OnlineAIConfigStore(join(root, 'online-ai.json')),
      secrets,
      transcriptionFetch,
      readMedia,
    );
    await onlineAI.configure({
      endpoint: 'https://api.example.test/v1',
      chatModel: 'chat-model',
      transcriptionModel: 'transcribe-model',
      apiKey: 'session-key',
      hostConfirmed: true,
    });
    const cloudTranscription = new CloudTranscriptionService(
      new CloudTranscriptionConfigStore(join(root, 'cloud-transcription.json')),
      secrets,
      onlineAI,
      transcriptionFetch,
      readMedia,
    );
    await cloudTranscription.configure({ providerId: 'openai-compatible', model: 'transcribe-model' });
    const mediaFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { 'content-type': 'video/mp4' },
    }));

    const result = await transcribeOnlineMediaUrl(vault, jobs, device, cloudTranscription, {
      url: 'https://media.example.test/video.mp4', language: 'zh',
    }, {
      fetcher: mediaFetch,
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      run: async (request) => {
        if (request.executablePath.includes('ffprobe')) {
          return request.args.includes('-select_streams')
            ? { exitCode: 0, stdout: '{"streams":[]}', stderr: '' }
            : { exitCode: 0, stdout: '{"format":{"duration":"2"}}', stderr: '' };
        }
        await writeFile(request.args.at(-1) ?? '', 'bounded audio');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.transcriptSource).toBe('speech_recognition');
    const transcript = await vault.read(result.transcriptPath);
    expect(transcript.text).toContain('在线视频观点。');
    expect(transcript.text).toContain('[00:00]');
    const job = await jobs.get(result.jobId);
    expect(job.request).toMatchObject({
      kind: 'online_transcription',
      endpointHost: 'api.example.test',
      transcriptionModel: 'transcribe-model',
    });
    expect(transcriptionFetch).toHaveBeenCalledTimes(1);
    const body = transcriptionFetch.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect(JSON.stringify(job)).not.toContain('session-key');
    vault.close();
  });

  it('imports a local media file and transcribes it with a chunk-capable cloud provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oldfolio-cloud-local-media-flow-'));
    roots.push(root);
    const vaultRoot = join(root, 'vault');
    const vault = await VaultRepository.open(vaultRoot);
    await vault.initialize();
    const jobs = new MediaJobStore(join(vaultRoot, '.oldfolio/cache/media-jobs'));
    await jobs.initialize();
    const device = new MediaDeviceConfigStore(join(root, 'device-media.json'));
    await device.save({ version: 1, ffmpegPath: 'C:/tools/ffmpeg.exe', models: [] });
    const mediaPath = join(root, 'local-video.mp4');
    await writeFile(mediaPath, 'local media bytes');
    const transcriptionFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      text: '本地视频文案。', segments: [{ start: 0.25, end: 1.25, text: '本地视频文案。' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const secrets = new SessionSecretStore();
    const readMedia = async (uri: string) => ({ bytes: await readFile(uri), fileName: basename(uri), mimeType: 'audio/mp4' });
    const onlineAI = new OnlineAIService(
      new OnlineAIConfigStore(join(root, 'online-ai.json')), secrets, transcriptionFetch, readMedia,
    );
    await onlineAI.configure({
      endpoint: 'https://api.example.test/v1', chatModel: 'chat-model', transcriptionModel: 'transcribe-model',
      apiKey: 'session-key', hostConfirmed: true,
    });
    const cloudTranscription = new CloudTranscriptionService(
      new CloudTranscriptionConfigStore(join(root, 'cloud-transcription.json')),
      secrets, onlineAI, transcriptionFetch, readMedia,
    );
    await cloudTranscription.configure({ providerId: 'openai-compatible', model: 'transcribe-model' });

    const result = await transcribeCloudMediaFile(vault, jobs, device, cloudTranscription, {
      mediaPath, language: 'zh',
    }, {
      now: () => new Date('2026-08-16T09:00:00.000Z'),
      run: async (request) => {
        if (request.executablePath.includes('ffprobe')) {
          return request.args.includes('-select_streams')
            ? { exitCode: 0, stdout: '{"streams":[]}', stderr: '' }
            : { exitCode: 0, stdout: '{"format":{"duration":"2"}}', stderr: '' };
        }
        await writeFile(request.args.at(-1) ?? '', 'bounded audio');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.transcriptSource).toBe('speech_recognition');
    expect((await vault.read(result.transcriptPath)).text).toContain('本地视频文案。');
    expect((await jobs.get(result.jobId)).request).toMatchObject({
      kind: 'online_transcription', sourceKind: 'local-file', importedFrom: mediaPath,
    });
    vault.close();
  });
});
