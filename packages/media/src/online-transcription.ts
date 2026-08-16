import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  AIInvocationContext,
  AIProvider,
  AIProviderConfig,
  AITranscriptionResult,
} from '@oldfolio/domain';

import { planMediaChunks, type MediaChunk } from './media-analysis.js';
import { runControlledProcess, type ControlledProcessRequest } from './process.js';
import type { CompletedTranscriptionChunk, ProcessRunner } from './whisper.js';

export interface OnlineTranscriptionOptions {
  readonly ffmpegPath: string;
  readonly workDirectory: string;
  readonly durationMs: number;
  readonly chunkDurationMs: number;
  readonly provider: AIProvider;
  readonly providerConfig: AIProviderConfig;
  readonly providerContext: AIInvocationContext;
  readonly model: string;
  readonly language?: string;
  readonly signal?: AbortSignal;
  readonly completedChunks?: readonly CompletedTranscriptionChunk[];
  readonly onStage?: (stage: 'extracting_audio' | 'transcribing', chunk: MediaChunk) => void | Promise<void>;
  readonly onChunkComplete?: (
    chunk: MediaChunk,
    artifactPath: string,
    artifactHash: string,
  ) => void | Promise<void>;
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function parseArtifact(source: string): AITranscriptionResult {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== 'object' || value === null) throw new Error('在线转录分块缓存无效。');
  const record = value as { readonly text?: unknown; readonly segments?: unknown };
  if (typeof record.text !== 'string' || !Array.isArray(record.segments) || record.segments.length === 0) {
    throw new Error('在线转录分块缓存无效。');
  }
  for (const segment of record.segments as unknown[]) {
    if (
      typeof segment !== 'object' || segment === null
      || typeof (segment as { readonly startMs?: unknown }).startMs !== 'number'
      || typeof (segment as { readonly endMs?: unknown }).endMs !== 'number'
      || typeof (segment as { readonly text?: unknown }).text !== 'string'
    ) throw new Error('在线转录分块缓存无效。');
  }
  return value as AITranscriptionResult;
}

async function writeArtifact(path: string, result: AITranscriptionResult): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

/** Extracts bounded AAC chunks locally and sends only those chunks to the configured online transcription provider. */
export class OnlineAudioTranscriber {
  constructor(private readonly run: ProcessRunner = runControlledProcess) {}

  async transcribe(mediaPath: string, options: OnlineTranscriptionOptions): Promise<AITranscriptionResult> {
    if (!options.provider.transcribe) throw new Error('当前在线 AI Provider 不支持音频转录。');
    const chunks = planMediaChunks(options.durationMs, options.chunkDurationMs);
    const completed = new Map(options.completedChunks?.map((chunk) => [chunk.index, chunk]));
    const segments: AITranscriptionResult['segments'][number][] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    for (const chunk of chunks) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('在线转录已取消。');
      const prefix = `online-chunk-${chunk.index.toString().padStart(5, '0')}`;
      const audioPath = join(options.workDirectory, `${prefix}.m4a`);
      const artifactPath = join(options.workDirectory, `${prefix}.json`);
      const checkpoint = completed.get(chunk.index);
      let result: AITranscriptionResult | undefined;
      if (checkpoint && /^[a-f0-9]{64}$/iu.test(checkpoint.artifactHash)) {
        try {
          if ((await hashFile(artifactPath)).toLowerCase() === checkpoint.artifactHash.toLowerCase()) {
            result = parseArtifact(await readFile(artifactPath, 'utf8'));
          }
        } catch {
          result = undefined;
        }
      }
      if (!result) {
        await options.onStage?.('extracting_audio', chunk);
        await this.run({
          executablePath: options.ffmpegPath,
          args: [
            '-nostdin', '-y', '-ss', seconds(chunk.startMs), '-t', seconds(chunk.endMs - chunk.startMs),
            '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', audioPath,
          ],
          cwd: dirname(mediaPath),
          timeoutMs: 60 * 60 * 1_000,
          maxOutputBytes: 8 * 1024 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        } satisfies ControlledProcessRequest);
        try {
          await options.onStage?.('transcribing', chunk);
          result = await options.provider.transcribe(options.providerConfig, {
            model: options.model,
            mediaUri: audioPath,
            durationMs: chunk.endMs - chunk.startMs,
            ...(options.language ? { language: options.language } : {}),
          }, options.providerContext);
          await writeArtifact(artifactPath, result);
          await options.onChunkComplete?.(chunk, artifactPath, await hashFile(artifactPath));
        } finally {
          await rm(audioPath, { force: true });
        }
      }
      inputTokens += result.usage?.inputTokens ?? 0;
      outputTokens += result.usage?.outputTokens ?? 0;
      segments.push(...result.segments.map((segment) => ({
        ...segment,
        startMs: segment.startMs + chunk.startMs,
        endMs: segment.endMs + chunk.startMs,
      })));
    }
    return {
      text: segments.map((segment) => segment.text).join('\n'),
      segments,
      ...(options.language ? { language: options.language } : {}),
      ...((inputTokens || outputTokens) ? { usage: { inputTokens, outputTokens } } : {}),
    };
  }
}
