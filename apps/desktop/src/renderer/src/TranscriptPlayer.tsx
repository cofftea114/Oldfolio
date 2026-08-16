import { FileAudio2, FileVideo2, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptPlaybackSummary } from '../../shared/contracts';

interface TranscriptPlayerProps {
  playback: TranscriptPlaybackSummary;
  seekRequest?: { readonly startMs: number; readonly requestId: number } | null;
}

function activeSegmentAt(segments: TranscriptPlaybackSummary['segments'], currentMs: number): number {
  let low = 0;
  let high = segments.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = segments[middle];
    if (segment && segment.startMs <= currentMs) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

export function TranscriptPlayer({ playback, seekRequest }: TranscriptPlayerProps) {
  const mediaRef = useRef<HTMLMediaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const activeIndex = useMemo(() => activeSegmentAt(playback.segments, currentMs), [currentMs, playback.segments]);

  useEffect(() => {
    const active = timelineRef.current?.querySelector<HTMLElement>(`[data-segment-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const seek = (startMs: number) => {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = startMs / 1_000;
    setCurrentMs(startMs);
    void media.play().catch(() => undefined);
  };

  const onTimeUpdate = () => setCurrentMs(Math.floor((mediaRef.current?.currentTime ?? 0) * 1_000));

  useEffect(() => {
    if (seekRequest) seek(seekRequest.startMs);
  }, [seekRequest]);

  return (
    <section className="transcript-player" aria-label="转录媒体播放器">
      <div className="player-media">
        <div className="player-heading">
          {playback.mediaKind === 'video' ? <FileVideo2 size={16} /> : <FileAudio2 size={16} />}
          <span><strong>{playback.title}</strong><small>{playback.resource}</small></span>
        </div>
        {playback.mediaKind === 'video'
          ? <video controls onTimeUpdate={onTimeUpdate} preload="metadata" ref={(element) => { mediaRef.current = element; }} src={playback.mediaUrl} aria-label={playback.title} />
          : <audio controls onTimeUpdate={onTimeUpdate} preload="metadata" ref={(element) => { mediaRef.current = element; }} src={playback.mediaUrl} aria-label={playback.title} />}
      </div>
      <div className="transcript-timeline" ref={timelineRef} aria-label="转录时间轴">
        {playback.segments.map((segment, index) => (
          <button
            className={index === activeIndex ? 'timeline-segment active' : 'timeline-segment'}
            data-segment-index={index}
            key={`${segment.startMs}-${index}`}
            onClick={() => seek(segment.startMs)}
            type="button"
          >
            <span className="timeline-time"><Play size={10} />{segment.label}</span>
            <span>{segment.speaker && <strong>{segment.speaker}：</strong>}{segment.text}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
