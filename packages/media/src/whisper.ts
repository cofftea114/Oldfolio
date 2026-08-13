import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { AITranscriptionResult, LocalModelDescriptor } from '@oldfolio/domain';

import { parseCaptions } from './captions.js';
import { runControlledProcess, type ControlledProcessRequest } from './process.js';

export interface LocalTranscriptionOptions {
  readonly ffmpegPath: string;
  readonly whisperPath: string;
  readonly model: LocalModelDescriptor;
  readonly workDirectory: string;
  readonly language?: string;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: 'extracting_audio' | 'transcribing') => void | Promise<void>;
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
  const bytes = await readFile(model.filePath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual.toLowerCase() !== model.sha256.toLowerCase()) {
    throw new Error(`Local model hash mismatch for ${model.id}.`);
  }
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
}
