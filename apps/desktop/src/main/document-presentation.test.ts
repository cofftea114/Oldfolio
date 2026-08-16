import { describe, expect, it } from 'vitest';

import { classifyDocumentPath } from './document-presentation.js';

describe('desktop document presentation', () => {
  it('separates knowledge notes and transcripts while hiding bundle internals', () => {
    const paths = [
      'bundles/personal/index.md',
      'bundles/personal/log.md',
      'bundles/personal/raw/media-a/source.md',
      'bundles/personal/wiki/summaries/video-summary.md',
      'bundles/personal/wiki/transcripts/media-a/transcript.md',
      'bundles/synthesis/index.md',
      'bundles/synthesis/log.md',
      'notes/欢迎使用 Oldfolio.md',
    ];

    expect(paths.map((path) => classifyDocumentPath(path))).toEqual([
      'internal',
      'internal',
      'internal',
      'knowledge',
      'transcript',
      'internal',
      'internal',
      'knowledge',
    ]);
  });

  it('hides creator bundle internals without hiding creator knowledge pages', () => {
    expect(classifyDocumentPath('bundles/creators/alice/index.md')).toBe('internal');
    expect(classifyDocumentPath('bundles/creators/alice/log.md')).toBe('internal');
    expect(classifyDocumentPath('bundles/creators/alice/raw/source.md')).toBe('internal');
    expect(classifyDocumentPath('bundles/creators/alice/wiki/perspective.md')).toBe('knowledge');
  });
});
