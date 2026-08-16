import { describe, expect, it } from 'vitest';

import { prepareMarkdownForReading } from './reading-markdown.js';

describe('Markdown reading view', () => {
  it('hides OKF frontmatter and presents wikilinks with readable labels', () => {
    const source = [
      '---',
      'type: Synthesis',
      'title: 测试摘要',
      'oldfolio:',
      '  id: synthesis-01',
      '---',
      '',
      '# 测试摘要',
      '',
      '> 来源：[[bundles/personal/wiki/transcripts/source.md|原始转录]]',
      '',
      '观点内容 [定位 00:14](assets/media/abc.mp4#t=14.840)',
    ].join('\n');

    const rendered = prepareMarkdownForReading(source);

    expect(rendered).not.toContain('type: Synthesis');
    expect(rendered).not.toContain('oldfolio:');
    expect(rendered).toContain('# 测试摘要');
    expect(rendered).toContain('[原始转录](#oldfolio-note=');
    expect(rendered).toContain('[定位 00:14](assets/media/abc.mp4#t=14.840)');
  });

  it('leaves ordinary Markdown without frontmatter intact', () => {
    expect(prepareMarkdownForReading('# 普通笔记\n\n正文')).toBe('# 普通笔记\n\n正文');
  });
});
