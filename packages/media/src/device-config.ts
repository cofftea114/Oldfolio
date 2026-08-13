import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LocalModelDescriptor } from '@oldfolio/domain';

import { deriveFfprobePath } from './media-analysis.js';
import { runControlledProcess, type ControlledProcessRequest } from './process.js';

export interface InstalledLocalModel extends LocalModelDescriptor {
  readonly byteLength: number;
  readonly importedAt: string;
  readonly licenseAcceptedAt: string;
}

export interface MediaDeviceConfig {
  readonly version: 1;
  readonly ffmpegPath?: string;
  readonly whisperPath?: string;
  readonly models: readonly InstalledLocalModel[];
}

export interface MediaToolProbe {
  readonly configured: boolean;
  readonly available: boolean;
  readonly path?: string;
  readonly version?: string;
  readonly error?: string;
}

export interface MediaToolsStatus {
  readonly ffmpeg: MediaToolProbe;
  readonly whisper: MediaToolProbe;
}

const EMPTY_CONFIG: MediaDeviceConfig = { version: 1, models: [] };

function validatePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Invalid media tool path.');
  return value;
}

function validateModel(value: unknown): InstalledLocalModel {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid installed model record.');
  const model = value as Partial<InstalledLocalModel>;
  if (
    typeof model.id !== 'string' || !model.id ||
    typeof model.filePath !== 'string' || !model.filePath ||
    typeof model.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(model.sha256) ||
    typeof model.license !== 'string' || !model.license ||
    typeof model.sourceUrl !== 'string' || !/^https:\/\//u.test(model.sourceUrl) ||
    typeof model.byteLength !== 'number' || !Number.isSafeInteger(model.byteLength) || model.byteLength <= 0 ||
    typeof model.importedAt !== 'string' || !Number.isFinite(Date.parse(model.importedAt)) ||
    typeof model.licenseAcceptedAt !== 'string' || !Number.isFinite(Date.parse(model.licenseAcceptedAt))
  ) {
    throw new Error('Invalid installed model record.');
  }
  return model as InstalledLocalModel;
}

function parseConfig(source: string): MediaDeviceConfig {
  const value = JSON.parse(source) as Partial<MediaDeviceConfig>;
  if (value.version !== 1 || !Array.isArray(value.models)) throw new Error('Invalid media device configuration.');
  const ffmpegPath = validatePath(value.ffmpegPath);
  const whisperPath = validatePath(value.whisperPath);
  return {
    version: 1,
    ...(ffmpegPath ? { ffmpegPath } : {}),
    ...(whisperPath ? { whisperPath } : {}),
    models: value.models.map(validateModel),
  };
}

export class MediaDeviceConfigStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<MediaDeviceConfig> {
    try {
      return parseConfig(await readFile(this.filePath, 'utf8'));
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return EMPTY_CONFIG;
      throw error;
    }
  }

  async save(config: MediaDeviceConfig): Promise<void> {
    const validated = parseConfig(JSON.stringify(config));
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  async setTool(kind: 'ffmpeg' | 'whisper', executablePath: string): Promise<MediaDeviceConfig> {
    const current = await this.load();
    const validatedPath = validatePath(executablePath);
    if (!validatedPath) throw new Error('Media tool path is required.');
    const updated: MediaDeviceConfig = {
      ...current,
      ...(kind === 'ffmpeg' ? { ffmpegPath: validatedPath } : { whisperPath: validatedPath }),
    };
    await this.save(updated);
    return updated;
  }

  async addModel(model: InstalledLocalModel): Promise<MediaDeviceConfig> {
    const current = await this.load();
    const updated = { ...current, models: [...current.models.filter((candidate) => candidate.id !== model.id), validateModel(model)] };
    await this.save(updated);
    return updated;
  }
}

type ProbeRunner = (request: ControlledProcessRequest) => Promise<{ readonly stdout: string; readonly stderr: string }>;

async function probeOne(
  executablePath: string | undefined,
  args: readonly string[],
  runner: ProbeRunner,
): Promise<MediaToolProbe> {
  if (!executablePath) return { configured: false, available: false };
  try {
    const result = await runner({ executablePath, args, timeoutMs: 10_000, maxOutputBytes: 512 * 1024 });
    const version = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    return { configured: true, available: true, path: executablePath, ...(version ? { version } : {}) };
  } catch (error: unknown) {
    return { configured: true, available: false, path: executablePath, error: error instanceof Error ? error.message : 'Tool probe failed.' };
  }
}

export async function probeMediaTools(
  config: MediaDeviceConfig,
  runner: ProbeRunner = runControlledProcess,
): Promise<MediaToolsStatus> {
  const [ffmpeg, ffprobe, whisper] = await Promise.all([
    probeOne(config.ffmpegPath, ['-version'], runner),
    probeOne(config.ffmpegPath ? deriveFfprobePath(config.ffmpegPath) : undefined, ['-version'], runner),
    probeOne(config.whisperPath, ['--help'], runner),
  ]);
  const ffmpegBundle = ffmpeg.available && !ffprobe.available
    ? { ...ffmpeg, available: false, error: `ffprobe is required beside FFmpeg: ${ffprobe.error ?? ffprobe.path ?? 'not found'}` }
    : ffmpeg;
  return { ffmpeg: ffmpegBundle, whisper };
}
