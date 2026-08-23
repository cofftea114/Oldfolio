import { describe, expect, it } from 'vitest';

import { classifyDocumentPath, isDocumentManageable } from './document-presentation.js';

describe('desktop document presentation', () => {
  it('separates notes, AI derivatives, and transcripts while hiding bundle internals', () => {
    const paths = [
      'bundles/personal/index.md',
      'bundles/personal/log.md',
      'bundles/personal/raw/media-a/source.md',
      'bundles/personal/wiki/summaries/video-summary.md',
      'bundles/personal/wiki/concepts/local-first.md',
      'bundles/personal/wiki/qa/2026-08-23/answer.md',
      'bundles/personal/wiki/transcripts/media-a/transcript.md',
      'bundles/synthesis/index.md',
      'bundles/synthesis/log.md',
      'notes/欢迎使用 Oldfolio.md',
    ];

    expect(paths.map((path) => classifyDocumentPath(path))).toEqual([
      'internal',
      'internal',
      'internal',
      'summary',
      'concept',
      'qa',
      'transcript',
      'internal',
      'internal',
      'note',
    ]);
  });

  it('hides creator bundle internals without hiding creator knowledge pages', () => {
    expect(classifyDocumentPath('bundles/creators/alice/index.md')).toBe('internal');
    expect(classifyDocumentPath('bundles/creators/alice/log.md')).toBe('internal');
    expect(classifyDocumentPath('bundles/creators/alice/raw/source.md')).toBe('internal');
    expect(classifyDocumentPath('bundles/creators/alice/wiki/perspective.md')).toBe('knowledge');
  });

  it('allows lifecycle actions only for visible Markdown documents', () => {
    expect(isDocumentManageable('notes/idea.md')).toBe(true);
    expect(isDocumentManageable('bundles/personal/wiki/summaries/video.md')).toBe(true);
    expect(isDocumentManageable('bundles/personal/raw/source.md')).toBe(false);
    expect(isDocumentManageable('.oldfolio/history/private.json')).toBe(false);
    expect(isDocumentManageable('.oldfolio/cache/fake.md')).toBe(false);
  });
});
