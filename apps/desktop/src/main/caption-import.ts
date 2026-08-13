import { lstat, readFile } from 'node:fs/promises';
import { extname, parse } from 'node:path';
import {
  IngestionPipeline,
  LocalFileSourceConnector,
  compileSourceDocument,
} from '@oldfolio/ingest';
import {
  compileTranscriptDocument,
  parseCaptions,
  type CaptionFormat,
  type MediaJobStore,
} from '@oldfolio/media';
import { parseOkfDocument } from '@oldfolio/okf';
import { VaultNotFoundError, type VaultRepository } from '@oldfolio/vault';

const MAX_CAPTION_BYTES = 20 * 1024 * 1024;

export interface CaptionImportResult {
  readonly sourcePath: string;
  readonly transcriptPath: string;
  readonly jobId: string;
  readonly createdSource: boolean;
  readonly createdTranscript: boolean;
}

function captionFormat(path: string): CaptionFormat {
  const extension = extname(path).toLowerCase();
  if (extension === '.srt') return 'srt';
  if (extension === '.vtt') return 'webvtt';
  throw new Error('只支持 .srt 和 .vtt 字幕文件');
}

async function writeConceptOnce(
  repository: VaultRepository,
  path: string,
  content: string,
  stableId: string,
): Promise<boolean> {
  try {
    const existing = await repository.read(path);
    const bundlePath = path.replace(/^bundles\/personal\//u, '');
    const parsed = parseOkfDocument(existing.text, bundlePath);
    const oldfolio = parsed.frontmatter?.oldfolio as { readonly id?: unknown } | undefined;
    if (!parsed.valid || oldfolio?.id !== stableId) {
      throw new Error(`路径 ${path} 已存在，但不是预期的不可变知识对象`);
    }
    return false;
  } catch (error: unknown) {
    if (!(error instanceof VaultNotFoundError)) throw error;
    await repository.write(path, content, null);
    return true;
  }
}

export async function importCaptionFile(
  repository: VaultRepository,
  jobs: MediaJobStore,
  filePath: string,
  now: () => Date = () => new Date(),
): Promise<CaptionImportResult> {
  const format = captionFormat(filePath);
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('字幕来源必须是普通文件');
  if (fileStat.size > MAX_CAPTION_BYTES) throw new Error('字幕文件超过 20 MB 限制');
  const bytes = await readFile(filePath);
  const connector = new LocalFileSourceConnector({
    read: () => Promise.resolve({
      bytes,
      displayName: parse(filePath).base,
      mimeType: format === 'srt' ? 'application/x-subrip' : 'text/vtt',
      modifiedAt: fileStat.mtime.toISOString(),
    }),
    now,
  });
  const pipeline = new IngestionPipeline([connector]);
  const ingested = await pipeline.ingest(connector.id, {
    input: { kind: 'file', uri: filePath, mimeType: format === 'srt' ? 'application/x-subrip' : 'text/vtt' },
    capabilities: ['metadata', 'content', 'captions'],
  });
  const job = await jobs.create({ sourceUri: filePath, sourceHash: ingested.snapshot.contentHash });
  try {
    await jobs.checkpoint(job.id, 'probing', 0.1);
    const transcript = parseCaptions(ingested.snapshot.text ?? '', format);
    await jobs.checkpoint(job.id, 'transcribing', 0.65, { transcriptSegments: transcript.segments });
    const source = compileSourceDocument(ingested.snapshot);
    const createdSource = await writeConceptOnce(repository, source.path, source.content, ingested.snapshot.id);
    await jobs.checkpoint(job.id, 'compiling', 0.85, { artifactPath: source.path, artifactHash: ingested.snapshot.contentHash });
    const compiled = compileTranscriptDocument({
      sourceId: ingested.snapshot.id,
      sourceHash: ingested.snapshot.contentHash,
      sourceResource: filePath,
      ...(ingested.snapshot.title ? { sourceTitle: ingested.snapshot.title } : {}),
      transcript,
      generatedAt: ingested.snapshot.fetchedAt,
      generator: `caption-import:${format}`,
    });
    const createdTranscript = await writeConceptOnce(repository, compiled.path, compiled.content, compiled.id);
    await jobs.checkpoint(job.id, 'completed', 1, {
      artifactPath: compiled.path,
      transcriptSegments: transcript.segments,
    });
    await repository.rebuildIndex();
    return {
      sourcePath: source.path,
      transcriptPath: compiled.path,
      jobId: job.id,
      createdSource,
      createdTranscript,
    };
  } catch (error: unknown) {
    await jobs.fail(job.id, {
      code: 'caption_import_failed',
      message: error instanceof Error ? error.message : 'Unknown caption import failure',
      retryable: false,
    });
    throw error;
  }
}
