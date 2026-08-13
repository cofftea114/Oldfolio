import { mkdir } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { compileSourceDocument } from '@oldfolio/ingest';
import {
  WhisperCppTranscriber,
  compileTranscriptDocument,
  importMediaAsset,
  type InstalledLocalModel,
  type MediaDeviceConfigStore,
  type MediaJobStore,
  type ProcessRunner,
} from '@oldfolio/media';
import type { SourceSnapshot } from '@oldfolio/domain';
import type { VaultRepository } from '@oldfolio/vault';

import { writeConceptOnce } from './write-concept.js';

export interface TranscribeMediaFileInput {
  readonly mediaPath: string;
  readonly vaultRoot: string;
  readonly modelId: string;
  readonly language?: string;
}

export interface TranscribeMediaFileResult {
  readonly jobId: string;
  readonly assetPath: string;
  readonly sourcePath: string;
  readonly transcriptPath: string;
  readonly createdSource: boolean;
  readonly createdTranscript: boolean;
}

function modelById(models: readonly InstalledLocalModel[], id: string): InstalledLocalModel {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`本机未安装模型：${id}`);
  return model;
}

export async function transcribeMediaFile(
  repository: VaultRepository,
  jobs: MediaJobStore,
  deviceConfig: MediaDeviceConfigStore,
  input: TranscribeMediaFileInput,
  options: { readonly now?: () => Date; readonly run?: ProcessRunner; readonly signal?: AbortSignal } = {},
): Promise<TranscribeMediaFileResult> {
  const now = options.now ?? (() => new Date());
  const config = await deviceConfig.load();
  if (!config.ffmpegPath || !config.whisperPath) throw new Error('请先配置 FFmpeg 与 whisper-cli');
  const model = modelById(config.models, input.modelId);
  const asset = await importMediaAsset(input.mediaPath, input.vaultRoot);
  const job = await jobs.create({ sourceUri: asset.vaultPath, sourceHash: asset.contentHash });
  try {
    await jobs.checkpoint(job.id, 'probing', 0.05, { artifactPath: asset.vaultPath, artifactHash: asset.contentHash });
    const workDirectory = join(input.vaultRoot, '.oldfolio', 'cache', 'media-work', job.id);
    await mkdir(workDirectory, { recursive: true });
    const transcriber = new WhisperCppTranscriber(options.run);
    const transcript = await transcriber.transcribe(asset.absolutePath, {
      ffmpegPath: config.ffmpegPath,
      whisperPath: config.whisperPath,
      model,
      workDirectory,
      ...(input.language ? { language: input.language } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onStage: async (stage) => {
        await jobs.checkpoint(job.id, stage, stage === 'extracting_audio' ? 0.15 : 0.45);
      },
    });
    await jobs.checkpoint(job.id, 'compiling', 0.85, { transcriptSegments: transcript.segments });
    const fetchedAt = now().toISOString();
    const sourceId = `media-${asset.contentHash}`;
    const snapshot: SourceSnapshot = {
      id: sourceId,
      connectorId: 'org.oldfolio.local-media',
      canonicalUri: asset.vaultPath,
      fetchedAt,
      contentHash: asset.contentHash,
      title: asset.originalName,
      metadata: {
        sourceLineageId: sourceId,
        byteLength: asset.byteLength,
        importedFrom: input.mediaPath,
      },
      deletionPolicy: { supportsRemoteDeletionSignals: false },
    };
    const source = compileSourceDocument(snapshot);
    const createdSource = await writeConceptOnce(repository, source.path, source.content, sourceId);
    const compiled = compileTranscriptDocument({
      sourceId,
      sourceHash: asset.contentHash,
      sourceResource: asset.vaultPath,
      sourceTitle: parse(asset.originalName).name,
      transcript,
      generatedAt: fetchedAt,
      generator: `whisper.cpp:${model.id}`,
    });
    const createdTranscript = await writeConceptOnce(repository, compiled.path, compiled.content, compiled.id);
    await jobs.checkpoint(job.id, 'completed', 1, { artifactPath: compiled.path, transcriptSegments: transcript.segments });
    await repository.rebuildIndex();
    return {
      jobId: job.id,
      assetPath: asset.vaultPath,
      sourcePath: source.path,
      transcriptPath: compiled.path,
      createdSource,
      createdTranscript,
    };
  } catch (error: unknown) {
    await jobs.fail(job.id, {
      code: 'local_transcription_failed',
      message: error instanceof Error ? error.message : 'Unknown local transcription failure',
      retryable: true,
    });
    throw error;
  }
}
