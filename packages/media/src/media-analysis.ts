import { statfs } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import type { ProcessRunner } from './whisper.js';

export interface MediaChunk {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface DiskSpaceReport {
  readonly availableBytes: number;
  readonly requiredBytes: number;
}

export type DiskSpaceInspector = (directory: string) => Promise<{
  readonly bavail: number | bigint;
  readonly bsize: number | bigint;
}>;

export class InsufficientDiskSpaceError extends Error {
  readonly availableBytes: number;
  readonly requiredBytes: number;

  constructor(report: DiskSpaceReport) {
    super(`Insufficient disk space: ${report.requiredBytes} bytes required, ${report.availableBytes} bytes available.`);
    this.name = 'InsufficientDiskSpaceError';
    this.availableBytes = report.availableBytes;
    this.requiredBytes = report.requiredBytes;
  }
}

export function deriveFfprobePath(ffmpegPath: string): string {
  const extension = extname(ffmpegPath);
  const name = basename(ffmpegPath, extension);
  return name.toLowerCase() === 'ffmpeg'
    ? join(dirname(ffmpegPath), `ffprobe${extension}`)
    : join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

export async function probeMediaDuration(
  mediaPath: string,
  ffmpegPath: string,
  run: ProcessRunner,
  signal?: AbortSignal,
): Promise<number> {
  const result = await run({
    executablePath: deriveFfprobePath(ffmpegPath),
    args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mediaPath],
    cwd: dirname(mediaPath),
    timeoutMs: 60_000,
    maxOutputBytes: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  let duration: unknown;
  try {
    duration = (JSON.parse(result.stdout) as { readonly format?: { readonly duration?: unknown } }).format?.duration;
  } catch {
    throw new Error('ffprobe returned invalid JSON.');
  }
  const durationSeconds = typeof duration === 'string' || typeof duration === 'number' ? Number(duration) : Number.NaN;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('ffprobe did not return a valid media duration.');
  return Math.ceil(durationSeconds * 1_000);
}

export function planMediaChunks(durationMs: number, chunkDurationMs: number): readonly MediaChunk[] {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new TypeError('Media duration must be a positive integer.');
  if (!Number.isSafeInteger(chunkDurationMs) || chunkDurationMs < 10_000) {
    throw new TypeError('Media chunk duration must be an integer of at least 10 seconds.');
  }
  const chunks: MediaChunk[] = [];
  for (let startMs = 0, index = 0; startMs < durationMs; startMs += chunkDurationMs, index += 1) {
    chunks.push({ index, startMs, endMs: Math.min(durationMs, startMs + chunkDurationMs) });
  }
  return chunks;
}

export function estimateTranscriptionWorkingBytes(chunkDurationMs: number): number {
  const pcmBytes = Math.ceil((chunkDurationMs / 1_000) * 16_000 * 2);
  return pcmBytes * 2 + 256 * 1024 * 1024;
}

export async function ensureAvailableDiskSpace(
  directory: string,
  requiredBytes: number,
  inspect: DiskSpaceInspector = statfs,
): Promise<DiskSpaceReport> {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) throw new TypeError('Required bytes must be a positive integer.');
  const status = await inspect(directory);
  const availableBytes = Number(status.bavail) * Number(status.bsize);
  const report = { availableBytes, requiredBytes };
  if (!Number.isSafeInteger(availableBytes) || availableBytes < requiredBytes) throw new InsufficientDiskSpaceError(report);
  return report;
}
