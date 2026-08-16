import { describe, expect, it, vi } from 'vitest';

import type { AIInvocationContext, AIProviderConfig } from '@oldfolio/domain';

import {
  TencentCloudASRProvider,
  signTencentCloudRequest,
} from './cloud-transcription.js';

const NOW = new Date('2026-08-16T08:00:00.000Z');

function requestBody(value: BodyInit | null | undefined): string {
  if (typeof value !== 'string') throw new TypeError('Expected a JSON string body');
  return value;
}

describe('cloud transcription request signing', () => {
  it('creates deterministic Tencent TC3 headers without exposing the secret key', () => {
    const headers = signTencentCloudRequest({
      secretId: 'secret-id', secretKey: 'secret-key', action: 'CreateRecTask',
      body: '{"SourceType":1}', timestamp: Math.floor(NOW.getTime() / 1_000), region: 'ap-guangzhou',
    });
    expect(headers.get('Authorization')).toMatch(/^TC3-HMAC-SHA256 Credential=secret-id\/2026-08-16\/asr\/tc3_request,/u);
    expect(headers.get('Authorization')).not.toContain('secret-key');
    expect(headers.get('X-TC-Action')).toBe('CreateRecTask');
    expect(headers.get('X-TC-Region')).toBe('ap-guangzhou');
  });

});

describe('cloud transcription providers', () => {
  it('polls Tencent and preserves sentence timestamps and speakers', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Response: { Data: { TaskId: 42 } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Response: { Data: { Status: 1 } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Response: { Data: { Status: 2, ResultDetail: [
          { StartMs: 120, EndMs: 860, FinalSentence: '第一句。', SpeakerId: 1 },
          { StartMs: 900, EndMs: 1_500, FinalSentence: '第二句。', SpeakerId: 2 },
        ] } },
      }), { status: 200 }));
    const provider = new TencentCloudASRProvider({
      fetch: fetchMock,
      readMedia: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), fileName: 'chunk.m4a', mimeType: 'audio/mp4' }),
      now: () => NOW, sleep: () => Promise.resolve(), maxPolls: 3,
    });
    const config: AIProviderConfig = {
      providerId: 'tencent-asr', endpoint: 'https://asr.tencentcloudapi.com/', model: '', secretRef: 'session:tencent',
    };
    const context: AIInvocationContext = {
      resolveSecret: () => Promise.resolve(JSON.stringify({ secretId: 'secret-id', secretKey: 'secret-key', region: 'ap-guangzhou' })),
    };
    const result = await provider.transcribe(config, { model: config.model, mediaUri: 'C:/chunk.m4a', durationMs: 2_000 }, context);

    expect(result.text).toBe('第一句。\n第二句。');
    expect(result.segments).toEqual([
      { startMs: 120, endMs: 860, text: '第一句。', speaker: 'speaker-1' },
      { startMs: 900, endMs: 1_500, text: '第二句。', speaker: 'speaker-2' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.has('Host')).toBe(false);
    const createBody = JSON.parse(requestBody(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(createBody).toMatchObject({ SourceType: 1, DataLen: 3, EngineModelType: '16k_zh' });
  });

});
