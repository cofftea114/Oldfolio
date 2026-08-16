import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { compileSourceDocument } from '@oldfolio/ingest';
import {
  InsufficientDiskSpaceError,
  WhisperCppTranscriber,
  compileTranscriptDocument,
  ensureAvailableDiskSpace,
  estimateTranscriptionWorkingBytes,
  extractEmbeddedTextSubtitle,
  importMediaAsset,
  probeEmbeddedSubtitleTracks,
  probeMediaDuration,
  runControlledProcess,
  selectEmbeddedTextSubtitle,
  type InstalledLocalModel,
  type MediaDeviceConfigStore,
  type MediaJobStore,
  type ProcessRunner,
} from '@oldfolio/media';
import type { AITranscriptionResult, MediaJobRecord, SourceSnapshot } from '@oldfolio/domain';
import { VaultPathResolver, type VaultRepository } from '@oldfolio/vault';

import { writeConceptOnce } from './write-concept.js';

const CHUNK_DURATION_MS = 15 * 60_000;

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
  readonly transcriptSource: 'embedded_subtitle' | 'speech_recognition';
}

export interface MediaTranscriptionRuntimeOptions {
  readonly now?: () => Date;
  readonly run?: ProcessRunner;
  readonly signal?: AbortSignal;
}

function modelById(models: readonly InstalledLocalModel[], id: string): InstalledLocalModel {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`本机未安装模型：${id}`);
  return model;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

export async function resolveVerifiedAsset(vaultRoot: string, job: MediaJobRecord): Promise<{ absolutePath: string; byteLength: number }> {
  const match = /^assets\/media\/([a-f0-9]{64})\.[a-z0-9]+$/iu.exec(job.sourceUri);
  if (!match || match[1]?.toLowerCase() !== job.sourceHash.toLowerCase()) throw new Error('媒体任务引用了无效的 Vault 资产。');
  const resolver = await VaultPathResolver.create(vaultRoot);
  await resolver.assertNoSymlinks(job.sourceUri);
  const { absolutePath } = resolver.resolve(job.sourceUri);
  const status = await lstat(absolutePath);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('媒体资产必须是普通文件。');
  if ((await hashFile(absolutePath)).toLowerCase() !== job.sourceHash.toLowerCase()) throw new Error('媒体资产校验失败，文件可能已损坏。');
  return { absolutePath, byteLength: status.size };
}

export async function resumeMediaTranscription(
  repository: VaultRepository,
  jobs: MediaJobStore,
  deviceConfig: MediaDeviceConfigStore,
  jobId: string,
  options: MediaTranscriptionRuntimeOptions = {},
): Promise<TranscribeMediaFileResult> {
  const now = options.now ?? (() => new Date());
  const job = await jobs.get(jobId);
  if (!job.request || job.request.kind !== 'local_transcription') throw new Error('该任务不包含可恢复的本地转录请求。');
  const request = job.request;
  if (job.stage === 'completed' || job.stage === 'cancelled') throw new Error('已结束的媒体任务不能重试。');
  if (job.stage !== 'queued' && job.stage !== 'failed') throw new Error('该媒体任务已在运行。');

  try {
    const config = await deviceConfig.load();
    if (!config.ffmpegPath) throw new Error('请先配置 FFmpeg 与 ffprobe。');
    const asset = await resolveVerifiedAsset(repository.root, job);
    await jobs.checkpoint(job.id, 'probing', 0.05, { artifactPath: job.sourceUri, artifactHash: job.sourceHash });
    const workDirectory = join(repository.root, '.oldfolio', 'cache', 'media-work', job.id);
    await mkdir(workDirectory, { recursive: true });
    const run = options.run;
    const runner = run ?? runControlledProcess;
    const subtitleTracks = await probeEmbeddedSubtitleTracks(asset.absolutePath, config.ffmpegPath, runner, options.signal);
    const subtitleTrack = selectEmbeddedTextSubtitle(subtitleTracks, request.language);
    let transcript: AITranscriptionResult;
    let generator: string;
    let transcriptSource: TranscribeMediaFileResult['transcriptSource'];
    let extractedSubtitleTrack: typeof subtitleTrack = null;
    if (subtitleTrack) {
      const subtitlePath = join(workDirectory, `embedded-subtitle-${subtitleTrack.index}.vtt`);
      try {
        await jobs.checkpoint(job.id, 'extracting_subtitles', 0.2);
        transcript = await extractEmbeddedTextSubtitle(
          asset.absolutePath,
          config.ffmpegPath,
          subtitleTrack,
          subtitlePath,
          runner,
          options.signal,
        );
        await jobs.checkpoint(job.id, 'extracting_subtitles', 0.8, {
          artifactPath: `.oldfolio/cache/media-work/${job.id}/embedded-subtitle-${subtitleTrack.index}.vtt`,
          artifactHash: await hashFile(subtitlePath),
        });
        generator = `ffmpeg:subtitle:${subtitleTrack.codec}:stream-${subtitleTrack.index}`;
        transcriptSource = 'embedded_subtitle';
        extractedSubtitleTrack = subtitleTrack;
      } catch (error: unknown) {
        if (options.signal?.aborted) throw error;
        transcript = await transcribeWithWhisper();
        generator = `whisper.cpp:${request.modelId}`;
        transcriptSource = 'speech_recognition';
      }
    } else {
      transcript = await transcribeWithWhisper();
      generator = `whisper.cpp:${request.modelId}`;
      transcriptSource = 'speech_recognition';
    }

    async function transcribeWithWhisper(): Promise<AITranscriptionResult> {
      if (!config.whisperPath) throw new Error('媒体没有可提取的文本字幕，请先配置 whisper-cli。');
      const model = modelById(config.models, request.modelId);
      if (model.sha256.toLowerCase() !== request.modelHash.toLowerCase()) {
        throw new Error('任务绑定的模型版本已变化，请重新导入原模型。');
      }
      const durationMs = await probeMediaDuration(asset.absolutePath, config.ffmpegPath!, runner, options.signal);
      await ensureAvailableDiskSpace(workDirectory, estimateTranscriptionWorkingBytes(request.chunkDurationMs));
      const chunkCount = Math.ceil(durationMs / request.chunkDurationMs);
      const completedChunks = job.checkpoints.flatMap((checkpoint) => (
        checkpoint.stage === 'transcribing' && checkpoint.chunkIndex !== undefined && checkpoint.artifactHash
          ? [{ index: checkpoint.chunkIndex, artifactHash: checkpoint.artifactHash }]
          : []
      ));
      return new WhisperCppTranscriber(run).transcribeResumable(asset.absolutePath, {
        ffmpegPath: config.ffmpegPath!,
        whisperPath: config.whisperPath,
        model,
        workDirectory,
        durationMs,
        chunkDurationMs: request.chunkDurationMs,
        completedChunks,
        ...(request.language ? { language: request.language } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onStage: async (stage, chunk) => {
          const index = chunk?.index ?? 0;
          const progress = 0.1 + 0.7 * (index / chunkCount) + (stage === 'transcribing' ? 0.02 : 0);
          await jobs.checkpoint(job.id, stage, Math.min(progress, 0.82), {
            ...(chunk ? { chunkIndex: chunk.index, chunkCount } : {}),
          });
        },
        onChunkComplete: async (chunk, _artifactPath, artifactHash) => {
          const artifactPath = `.oldfolio/cache/media-work/${job.id}/chunk-${chunk.index.toString().padStart(5, '0')}.transcript.vtt`;
          await jobs.checkpoint(job.id, 'transcribing', 0.1 + 0.7 * ((chunk.index + 1) / chunkCount), {
            artifactPath, artifactHash, chunkIndex: chunk.index, chunkCount,
          });
        },
      });
    }
    await jobs.checkpoint(job.id, 'compiling', 0.85, { transcriptSegments: transcript.segments });
    const fetchedAt = now().toISOString();
    const sourceId = `media-${job.sourceHash}`;
    const snapshot: SourceSnapshot = {
      id: sourceId,
      connectorId: 'org.oldfolio.local-media',
      canonicalUri: job.sourceUri,
      fetchedAt,
      contentHash: job.sourceHash,
      title: request.sourceTitle,
      metadata: {
        sourceLineageId: sourceId,
        byteLength: asset.byteLength,
        ...(request.importedFrom ? { importedFrom: request.importedFrom } : {}),
        transcriptSource,
        subtitleTracks: subtitleTracks.map((track) => ({
          index: track.index,
          codec: track.codec,
          kind: track.kind,
          ...(track.language ? { language: track.language } : {}),
        })),
        ...(extractedSubtitleTrack ? { selectedSubtitleTrack: extractedSubtitleTrack.index } : {}),
      },
      deletionPolicy: { supportsRemoteDeletionSignals: false },
    };
    const source = compileSourceDocument(snapshot);
    const createdSource = await writeConceptOnce(repository, source.path, source.content, sourceId);
    const compiled = compileTranscriptDocument({
      sourceId,
      sourceHash: job.sourceHash,
      sourceResource: job.sourceUri,
      sourceTitle: parse(request.sourceTitle).name,
      transcript,
      generatedAt: fetchedAt,
      generator,
    });
    const createdTranscript = await writeConceptOnce(repository, compiled.path, compiled.content, compiled.id);
    await jobs.checkpoint(job.id, 'completed', 1, { artifactPath: compiled.path, transcriptSegments: transcript.segments });
    await repository.rebuildIndex();
    return {
      jobId: job.id,
      assetPath: job.sourceUri,
      sourcePath: source.path,
      transcriptPath: compiled.path,
      createdSource,
      createdTranscript,
      transcriptSource,
    };
  } catch (error: unknown) {
    await jobs.fail(job.id, {
      code: error instanceof InsufficientDiskSpaceError ? 'insufficient_disk_space' : 'local_transcription_failed',
      message: error instanceof Error ? error.message : 'Unknown local transcription failure',
      retryable: true,
    });
    throw error;
  }
}

export async function transcribeMediaFile(
  repository: VaultRepository,
  jobs: MediaJobStore,
  deviceConfig: MediaDeviceConfigStore,
  input: TranscribeMediaFileInput,
  options: MediaTranscriptionRuntimeOptions = {},
): Promise<TranscribeMediaFileResult> {
  const config = await deviceConfig.load();
  if (!config.ffmpegPath || !config.whisperPath) throw new Error('请先配置 FFmpeg 与 whisper-cli。');
  const model = modelById(config.models, input.modelId);
  const asset = await importMediaAsset(input.mediaPath, input.vaultRoot);
  const job = await jobs.create({
    sourceUri: asset.vaultPath,
    sourceHash: asset.contentHash,
    request: {
      kind: 'local_transcription',
      sourceTitle: asset.originalName,
      importedFrom: input.mediaPath,
      modelId: model.id,
      modelHash: model.sha256,
      ...(input.language ? { language: input.language } : {}),
      chunkDurationMs: CHUNK_DURATION_MS,
    },
  });
  return resumeMediaTranscription(repository, jobs, deviceConfig, job.id, options);
}
