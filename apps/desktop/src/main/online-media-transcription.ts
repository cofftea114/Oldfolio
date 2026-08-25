import { mkdir } from 'node:fs/promises';
import { join, parse } from 'node:path';

import { compileSourceDocument } from '@oldfolio/ingest';
import {
  OnlineAudioTranscriber,
  compileTranscriptDocument,
  extractEmbeddedTextSubtitle,
  importMediaAsset,
  probeEmbeddedSubtitleTracks,
  probeMediaDuration,
  runControlledProcess,
  selectEmbeddedTextSubtitle,
  type MediaDeviceConfigStore,
  type MediaJobStore,
  type ProcessRunner,
} from '@oldfolio/media';
import type { AITranscriptionResult, SourceSnapshot } from '@oldfolio/domain';
import type { VaultRepository } from '@oldfolio/vault';

import { resolveVerifiedAsset, validatedMediaBundleRoot, type TranscribeMediaFileResult } from './media-transcription.js';
import type { CloudTranscriptionService } from './cloud-transcription.js';
import { downloadRemoteMediaAsset } from './remote-media.js';
import { writeConceptOnce } from './write-concept.js';

const ONLINE_CHUNK_DURATION_MS = 10 * 60_000;

export interface OnlineMediaTranscriptionOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly run?: ProcessRunner;
  readonly signal?: AbortSignal;
}

interface CreatorMediaTargetInput {
  readonly sourceTitle?: string;
  readonly targetBundleRoot?: string;
  readonly creatorId?: string;
  readonly creatorTitle?: string;
  readonly creatorEntryId?: string;
}

export async function transcribeOnlineMediaUrl(
  repository: VaultRepository,
  jobs: MediaJobStore,
  deviceConfig: MediaDeviceConfigStore,
  cloudTranscription: CloudTranscriptionService,
  input: { readonly url: string; readonly language?: string } & CreatorMediaTargetInput,
  options: OnlineMediaTranscriptionOptions = {},
): Promise<TranscribeMediaFileResult> {
  const config = await deviceConfig.load();
  if (!config.ffmpegPath) throw new Error('在线转录仍需要本机 FFmpeg 来提取受控音频分块。');
  const runtime = await cloudTranscription.runtime(options.signal);
  const asset = await downloadRemoteMediaAsset(input.url, repository.root, {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const job = await jobs.create({
    sourceUri: asset.vaultPath,
    sourceHash: asset.contentHash,
    request: {
      kind: 'online_transcription',
      sourceKind: 'remote-url',
      sourceTitle: input.sourceTitle?.trim() || asset.originalName,
      importedFrom: asset.finalUrl,
      providerId: runtime.config.providerId as 'openai-compatible' | 'tencent-asr',
      endpointHost: runtime.host,
      transcriptionModel: runtime.transcriptionModel,
      secretRef: runtime.config.secretRef ?? '',
      inputMode: runtime.inputMode,
      ...(input.language ? { language: input.language } : {}),
      chunkDurationMs: ONLINE_CHUNK_DURATION_MS,
      ...(input.targetBundleRoot ? { targetBundleRoot: validatedMediaBundleRoot(input.targetBundleRoot) } : {}),
      ...(input.creatorId ? { creatorId: input.creatorId } : {}),
      ...(input.creatorTitle ? { creatorTitle: input.creatorTitle } : {}),
      ...(input.creatorEntryId ? { creatorEntryId: input.creatorEntryId } : {}),
    },
  });
  return resumeOnlineMediaTranscription(repository, jobs, deviceConfig, cloudTranscription, job.id, options);
}

export async function transcribeCloudMediaFile(
  repository: VaultRepository,
  jobs: MediaJobStore,
  deviceConfig: MediaDeviceConfigStore,
  cloudTranscription: CloudTranscriptionService,
  input: { readonly mediaPath: string; readonly importedFrom?: string; readonly language?: string } & CreatorMediaTargetInput,
  options: OnlineMediaTranscriptionOptions = {},
): Promise<TranscribeMediaFileResult> {
  const config = await deviceConfig.load();
  if (!config.ffmpegPath) throw new Error('请先配置 FFmpeg，用于字幕检测和受控音频分块。');
  const runtime = await cloudTranscription.runtime(options.signal);
  const asset = await importMediaAsset(input.mediaPath, repository.root);
  const job = await jobs.create({
    sourceUri: asset.vaultPath,
    sourceHash: asset.contentHash,
    request: {
      kind: 'online_transcription',
      sourceKind: input.importedFrom ? 'remote-url' : 'local-file',
      sourceTitle: input.sourceTitle?.trim() || asset.originalName,
      importedFrom: input.importedFrom ?? input.mediaPath,
      providerId: runtime.config.providerId as 'openai-compatible' | 'tencent-asr',
      endpointHost: runtime.host,
      transcriptionModel: runtime.transcriptionModel,
      secretRef: runtime.config.secretRef ?? '',
      inputMode: runtime.inputMode,
      ...(input.language ? { language: input.language } : {}),
      chunkDurationMs: ONLINE_CHUNK_DURATION_MS,
      ...(input.targetBundleRoot ? { targetBundleRoot: validatedMediaBundleRoot(input.targetBundleRoot) } : {}),
      ...(input.creatorId ? { creatorId: input.creatorId } : {}),
      ...(input.creatorTitle ? { creatorTitle: input.creatorTitle } : {}),
      ...(input.creatorEntryId ? { creatorEntryId: input.creatorEntryId } : {}),
    },
  });
  return resumeOnlineMediaTranscription(repository, jobs, deviceConfig, cloudTranscription, job.id, options);
}

export async function resumeOnlineMediaTranscription(
  repository: VaultRepository,
  jobs: MediaJobStore,
  deviceConfig: MediaDeviceConfigStore,
  cloudTranscription: CloudTranscriptionService,
  jobId: string,
  options: OnlineMediaTranscriptionOptions = {},
): Promise<TranscribeMediaFileResult> {
  const now = options.now ?? (() => new Date());
  const job = await jobs.get(jobId);
  if (!job.request || job.request.kind !== 'online_transcription') throw new Error('该任务不包含可恢复的在线转录请求。');
  const request = job.request;
  if (job.stage === 'completed' || job.stage === 'cancelled') throw new Error('已结束的媒体任务不能重试。');
  if (job.stage !== 'queued' && job.stage !== 'failed') throw new Error('该媒体任务已在运行。');
  try {
    const config = await deviceConfig.load();
    if (!config.ffmpegPath) throw new Error('在线转录仍需要本机 FFmpeg。');
    const runtime = await cloudTranscription.runtime(options.signal);
    if (
      runtime.host !== request.endpointHost
      || runtime.config.providerId !== request.providerId
      || runtime.transcriptionModel !== request.transcriptionModel
      || runtime.config.secretRef !== request.secretRef
      || runtime.inputMode !== request.inputMode
    ) throw new Error('在线转录配置已变化，请恢复原服务与模型后重试。');
    const asset = await resolveVerifiedAsset(repository.root, job);
    const runner = options.run ?? runControlledProcess;
    await jobs.checkpoint(job.id, 'probing', 0.05, { artifactPath: job.sourceUri, artifactHash: job.sourceHash });
    const workDirectory = join(repository.root, '.oldfolio', 'cache', 'media-work', job.id);
    await mkdir(workDirectory, { recursive: true });
    const subtitleTracks = await probeEmbeddedSubtitleTracks(asset.absolutePath, config.ffmpegPath, runner, options.signal);
    const subtitleTrack = selectEmbeddedTextSubtitle(subtitleTracks, request.language);
    let transcript: AITranscriptionResult;
    let generator: string;
    let transcriptSource: TranscribeMediaFileResult['transcriptSource'];
    let selectedSubtitleTrack: number | undefined;
    if (subtitleTrack) {
      const subtitlePath = join(workDirectory, `embedded-subtitle-${subtitleTrack.index}.vtt`);
      try {
        await jobs.checkpoint(job.id, 'extracting_subtitles', 0.2);
        transcript = await extractEmbeddedTextSubtitle(
          asset.absolutePath, config.ffmpegPath, subtitleTrack, subtitlePath, runner, options.signal,
        );
        generator = `ffmpeg:subtitle:${subtitleTrack.codec}:stream-${subtitleTrack.index}`;
        transcriptSource = 'embedded_subtitle';
        selectedSubtitleTrack = subtitleTrack.index;
      } catch (error: unknown) {
        if (options.signal?.aborted) throw error;
        transcript = await transcribeWithOnlineProvider();
        generator = `${request.providerId}:${request.transcriptionModel}`;
        transcriptSource = 'speech_recognition';
      }
    } else {
      transcript = await transcribeWithOnlineProvider();
      generator = `${request.providerId}:${request.transcriptionModel}`;
      transcriptSource = 'speech_recognition';
    }

    async function transcribeWithOnlineProvider(): Promise<AITranscriptionResult> {
      const durationMs = await probeMediaDuration(asset.absolutePath, config.ffmpegPath!, runner, options.signal);
      const chunks = Math.ceil(durationMs / request.chunkDurationMs);
      const completedChunks = job.checkpoints.flatMap((checkpoint) => (
        checkpoint.stage === 'transcribing' && checkpoint.chunkIndex !== undefined && checkpoint.artifactHash
          ? [{ index: checkpoint.chunkIndex, artifactHash: checkpoint.artifactHash }]
          : []
      ));
      return new OnlineAudioTranscriber(options.run).transcribe(asset.absolutePath, {
        ffmpegPath: config.ffmpegPath!,
        workDirectory,
        durationMs,
        chunkDurationMs: request.chunkDurationMs,
        provider: runtime.provider,
        providerConfig: runtime.config,
        providerContext: runtime.context,
        model: request.transcriptionModel,
        completedChunks,
        ...(request.language ? { language: request.language } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onStage: async (stage, chunk) => {
          const progress = 0.1 + 0.7 * (chunk.index / chunks) + (stage === 'transcribing' ? 0.02 : 0);
          await jobs.checkpoint(job.id, stage, Math.min(progress, 0.82), {
            chunkIndex: chunk.index, chunkCount: chunks,
          });
        },
        onChunkComplete: async (chunk, _artifactPath, artifactHash) => {
          await jobs.checkpoint(job.id, 'transcribing', 0.1 + 0.7 * ((chunk.index + 1) / chunks), {
            artifactPath: `.oldfolio/cache/media-work/${job.id}/online-chunk-${chunk.index.toString().padStart(5, '0')}.json`,
            artifactHash,
            chunkIndex: chunk.index,
            chunkCount: chunks,
          });
        },
      });
    }

    await jobs.checkpoint(job.id, 'compiling', 0.85, { transcriptSegments: transcript.segments });
    const fetchedAt = now().toISOString();
    const sourceId = `media-${job.sourceHash}`;
    const targetBundleRoot = validatedMediaBundleRoot(request.targetBundleRoot);
    const localSource = request.sourceKind === 'local-file';
    const snapshot: SourceSnapshot = {
      id: sourceId,
      connectorId: localSource ? 'org.oldfolio.local-media' : 'org.oldfolio.remote-media',
      canonicalUri: localSource ? job.sourceUri : request.importedFrom,
      fetchedAt,
      contentHash: job.sourceHash,
      title: request.sourceTitle,
      metadata: {
        sourceLineageId: sourceId,
        byteLength: asset.byteLength,
        importedFrom: request.importedFrom,
        transcriptSource,
        onlineProvider: request.providerId,
        onlineProviderHost: request.endpointHost,
        transcriptionModel: request.transcriptionModel,
        subtitleTracks: subtitleTracks.map((track) => ({
          index: track.index,
          codec: track.codec,
          kind: track.kind,
          ...(track.language ? { language: track.language } : {}),
        })),
        ...(selectedSubtitleTrack === undefined ? {} : { selectedSubtitleTrack }),
        ...(request.creatorId ? { creatorId: request.creatorId } : {}),
        ...(request.creatorTitle ? { creatorTitle: request.creatorTitle } : {}),
        ...(request.creatorEntryId ? { creatorEntryId: request.creatorEntryId } : {}),
      },
      deletionPolicy: { supportsRemoteDeletionSignals: false },
    };
    const source = compileSourceDocument(snapshot, { bundleRoot: targetBundleRoot });
    const createdSource = await writeConceptOnce(repository, source.path, source.content, sourceId);
    const compiled = compileTranscriptDocument({
      sourceId,
      sourceHash: job.sourceHash,
      sourceResource: job.sourceUri,
      sourceTitle: parse(request.sourceTitle).name,
      transcript,
      generatedAt: fetchedAt,
      generator,
      bundleRoot: targetBundleRoot,
      ...(request.creatorId ? { creatorId: request.creatorId } : {}),
      ...(request.creatorTitle ? { creatorTitle: request.creatorTitle } : {}),
      ...(request.creatorEntryId ? { creatorEntryId: request.creatorEntryId } : {}),
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
      code: 'online_transcription_failed',
      message: error instanceof Error ? error.message : 'Unknown online transcription failure',
      retryable: true,
    });
    throw error;
  }
}
