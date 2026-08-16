import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AITranscriptSegment,
  MediaTranscriptionRequest,
  MediaJobError,
  MediaJobRecord,
  MediaJobStage,
} from '@oldfolio/domain';

const ACTIVE_STAGES = new Set<MediaJobStage>(['probing', 'extracting_subtitles', 'extracting_audio', 'transcribing', 'compiling']);

export interface CreateMediaJobInput {
  readonly sourceUri: string;
  readonly sourceHash: string;
  readonly request?: MediaTranscriptionRequest;
}

export class MediaJobStore {
  readonly #directory: string;
  readonly #now: () => Date;

  constructor(directory: string, now: () => Date = () => new Date()) {
    this.#directory = directory;
    this.#now = now;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const jobs = await this.list();
    await Promise.all(jobs.filter((job) => ACTIVE_STAGES.has(job.stage)).map(async (job) => {
      await this.save({
        ...job,
        stage: 'queued',
        updatedAt: this.#now().toISOString(),
        error: { code: 'interrupted', message: 'Previous process ended before the job completed.', retryable: true },
      });
    }));
  }

  async create(input: CreateMediaJobInput): Promise<MediaJobRecord> {
    if (!input.sourceUri.trim() || !/^[a-f0-9]{64}$/iu.test(input.sourceHash)) throw new Error('Invalid media job source.');
    const timestamp = this.#now().toISOString();
    const job: MediaJobRecord = {
      version: 1,
      id: randomUUID(),
      sourceUri: input.sourceUri,
      sourceHash: input.sourceHash.toLowerCase(),
      createdAt: timestamp,
      updatedAt: timestamp,
      stage: 'queued',
      attempts: 0,
      checkpoints: [{ stage: 'queued', progress: 0, updatedAt: timestamp }],
      ...(input.request ? { request: input.request } : {}),
    };
    await this.save(job);
    return job;
  }

  async get(id: string): Promise<MediaJobRecord> {
    if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new Error('Invalid media job id.');
    return this.parse(await readFile(join(this.#directory, `${id}.json`), 'utf8'));
  }

  async list(): Promise<readonly MediaJobRecord[]> {
    await mkdir(this.#directory, { recursive: true });
    const names = (await readdir(this.#directory)).filter((name) => /^[a-f0-9-]{36}\.json$/iu.test(name));
    const jobs = await Promise.all(names.map(async (name) => this.parse(await readFile(join(this.#directory, name), 'utf8'))));
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async checkpoint(
    id: string,
    stage: MediaJobStage,
    progress: number,
    details: {
      readonly artifactPath?: string;
      readonly artifactHash?: string;
      readonly chunkIndex?: number;
      readonly chunkCount?: number;
      readonly transcriptSegments?: readonly AITranscriptSegment[];
    } = {},
  ): Promise<MediaJobRecord> {
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('Job progress must be between 0 and 1.');
    const current = await this.get(id);
    if (current.stage === 'completed' || current.stage === 'cancelled') throw new Error('Terminal media jobs cannot be changed.');
    const updatedAt = this.#now().toISOString();
    const checkpoint = {
      stage,
      progress,
      updatedAt,
      ...(details.artifactPath ? { artifactPath: details.artifactPath } : {}),
      ...(details.artifactHash ? { artifactHash: details.artifactHash } : {}),
      ...(details.chunkIndex !== undefined ? { chunkIndex: details.chunkIndex } : {}),
      ...(details.chunkCount !== undefined ? { chunkCount: details.chunkCount } : {}),
    };
    const { error: _previousError, ...currentWithoutError } = current;
    void _previousError;
    const updated: MediaJobRecord = {
      ...currentWithoutError,
      stage,
      updatedAt,
      attempts: current.attempts + (stage === 'probing' ? 1 : 0),
      checkpoints: [...current.checkpoints, checkpoint],
      ...(details.transcriptSegments ? { transcriptSegments: details.transcriptSegments } : {}),
      ...(stage === 'completed' && details.artifactPath ? { outputPaths: [details.artifactPath] } : {}),
    };
    await this.save(updated);
    return updated;
  }

  async fail(id: string, error: MediaJobError): Promise<MediaJobRecord> {
    const current = await this.get(id);
    if (current.stage === 'completed' || current.stage === 'cancelled') throw new Error('Terminal media jobs cannot fail.');
    const updatedAt = this.#now().toISOString();
    const updated: MediaJobRecord = { ...current, stage: 'failed', updatedAt, error };
    await this.save(updated);
    return updated;
  }

  private parse(source: string): MediaJobRecord {
    const value = JSON.parse(source) as Partial<MediaJobRecord>;
    if (value.version !== 1 || typeof value.id !== 'string' || typeof value.sourceUri !== 'string' || !Array.isArray(value.checkpoints)) {
      throw new Error('Invalid persisted media job.');
    }
    return value as MediaJobRecord;
  }

  private async save(job: MediaJobRecord): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const target = join(this.#directory, `${job.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  }
}
