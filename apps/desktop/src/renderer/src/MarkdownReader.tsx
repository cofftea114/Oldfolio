import ReactMarkdown from 'react-markdown';

import { parseMediaTimestamp, parseWikiTarget, prepareMarkdownForReading } from './reading-markdown.js';

interface MarkdownReaderProps {
  value: string;
  onOpenDocument: (target: string) => void;
  onSeek: (startMs: number) => void;
}

export function MarkdownReader({ value, onOpenDocument, onSeek }: MarkdownReaderProps) {
  return (
    <article className="markdown-reader" aria-label="笔记阅读视图">
      <ReactMarkdown
        components={{
          a: ({ href = '', children, ...props }) => {
            const wikiTarget = parseWikiTarget(href);
            const startMs = parseMediaTimestamp(href);
            const actionable = wikiTarget !== null || startMs !== null;
            return (
              <a
                {...props}
                href={actionable ? '#' : href}
                onClick={(event) => {
                  if (!actionable) return;
                  event.preventDefault();
                  if (wikiTarget !== null) onOpenDocument(wikiTarget);
                  if (startMs !== null) onSeek(startMs);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {prepareMarkdownForReading(value)}
      </ReactMarkdown>
    </article>
  );
}
