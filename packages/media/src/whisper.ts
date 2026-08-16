import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { AITranscriptionResult, LocalModelDescriptor } from '@oldfolio/domain';

import { parseCaptions } from './captions.js';
import { planMediaChunks, type MediaChunk } from './media-analysis.js';
import { runControlledProcess, type ControlledProcessRequest } from './process.js';

export interface LocalTranscriptionOptions {
  readonly ffmpegPath: string;
  readonly whisperPath: string;
  readonly model: LocalModelDescriptor;
  readonly workDirectory: string;
  readonly language?: string;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: 'extracting_audio' | 'transcribing', chunk?: MediaChunk) => void | Promise<void>;
}

export interface CompletedTranscriptionChunk {
  readonly index: number;
  readonly artifactHash: string;
}

export interface ResumableTranscriptionOptions extends LocalTranscriptionOptions {
  readonly durationMs: number;
  readonly chunkDurationMs: number;
  readonly completedChunks?: readonly CompletedTranscriptionChunk[];
  readonly onChunkComplete?: (
    chunk: MediaChunk,
    artifactPath: string,
    artifactHash: string,
  ) => void | Promise<void>;
}

export type ProcessRunner = (request: ControlledProcessRequest) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

export async function verifyLocalModel(model: LocalModelDescriptor): Promise<void> {
  if (!model.license.trim() || !/^https:\/\//u.test(model.sourceUrl)) {
    throw new Error('Local model metadata must include a license and HTTPS source URL.');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(model.filePath) as AsyncIterable<Buffer>) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== model.sha256.toLowerCase()) {
    throw new Error(`Local model hash mismatch for ${model.id}.`);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

export class WhisperCppTranscriber {
  readonly #run: ProcessRunner;

  constructor(run: ProcessRunner = runControlledProcess) {
    this.#run = run;
  }

  async transcribe(mediaPath: string, options: LocalTranscriptionOptions): Promise<AITranscriptionResult> {
    await verifyLocalModel(options.model);
    const stem = basename(mediaPath, extname(mediaPath)).replaceAll(/[^a-zA-Z0-9._-]/gu, '-');
    const wavePath = join(options.workDirectory, `${stem}.16khz.wav`);
    const outputBase = join(options.workDirectory, `${stem}.transcript`);
    await options.onStage?.('extracting_audio');
    await this.#run({
      executablePath: options.ffmpegPath,
      args: ['-nostdin', '-y', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavePath],
      cwd: dirname(mediaPath),
      timeoutMs: 2 * 60 * 60 * 1_000,
      maxOutputBytes: 8 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await options.onStage?.('transcribing');
    await this.#run({
      executablePath: options.whisperPath,
      args: [
        '-m', options.model.filePath,
        '-f', wavePath,
        '-ovtt',
        '-of', outputBase,
        ...(options.language ? ['-l', options.language] : []),
      ],
      cwd: options.workDirectory,
      timeoutMs: 2 * 60 * 60 * 1_000,
      maxOutputBytes: 8 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const result = parseCaptions(await readFile(`${outputBase}.vtt`, 'utf8'), 'webvtt');
    return { ...result, ...(options.language ? { language: options.language } : {}) };
  }

  async transcribeResumable(mediaPath: string, options: ResumableTranscriptionOptions): Promise<AITranscriptionResult> {
    await verifyLocalModel(options.model);
    const chunks = planMediaChunks(options.durationMs, options.chunkDurationMs);
    const completedByIndex = new Map(options.completedChunks?.map((chunk) => [chunk.index, chunk]));
    const segments: AITranscriptionResult['segments'][number][] = [];

    for (const chunk of chunks) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Transcription aborted.');
      const prefix = `chunk-${chunk.index.toString().padStart(5, '0')}`;
      const wavePath = join(options.workDirectory, `${prefix}.16khz.wav`);
      const outputBase = join(options.workDirectory, `${prefix}.transcript`);
      const artifactPath = `${outputBase}.vtt`;
      const completed = completedByIndex.get(chunk.index);
      let transcript: AITranscriptionResult | undefined;

      if (completed && /^[a-f0-9]{64}$/iu.test(completed.artifactHash)) {
        try {
          if ((await hashFile(artifactPath)).toLowerCase() === completed.artifactHash.toLowerCase()) {
            transcript = parseCaptions(await readFile(artifactPath, 'utf8'), 'webvtt');
          }
        } catch {
          transcript = undefined;
        }
      }

      if (!transcript) {
        await options.onStage?.('extracting_audio', chunk);
        await this.#run({
          executablePath: options.ffmpegPath,
          args: [
            '-nostdin', '-y', '-ss', seconds(chunk.startMs), '-t', seconds(chunk.endMs - chunk.startMs),
            '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavePath,
          ],
          cwd: dirname(mediaPath),
          timeoutMs: 60 * 60 * 1_000,
          maxOutputBytes: 8 * 1024 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        try {
          await options.onStage?.('transcribing', chunk);
          await this.#run({
            executablePath: options.whisperPath,
            args: [
              '-m', options.model.filePath,
              '-f', wavePath,
              '-ovtt',
              '-of', outputBase,
              ...(options.language ? ['-l', options.language] : []),
            ],
            cwd: options.workDirectory,
            timeoutMs: 2 * 60 * 60 * 1_000,
            maxOutputBytes: 8 * 1024 * 1024,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          transcript = parseCaptions(await readFile(artifactPath, 'utf8'), 'webvtt');
          await options.onChunkComplete?.(chunk, artifactPath, await hashFile(artifactPath));
        } finally {
          await rm(wavePath, { force: true });
        }
      }

      segments.push(...transcript.segments.map((segment) => ({
        ...segment,
        startMs: segment.startMs + chunk.startMs,
        endMs: segment.endMs + chunk.startMs,
      })));
    }

    return {
      text: segments.map((segment) => segment.text).join('\n'),
      segments,
      ...(options.language ? { language: options.language } : {}),
    };
  }
}
