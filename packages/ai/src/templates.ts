export const SUMMARY_TEMPLATES = [
  'course',
  'interview',
  'podcast',
  'tutorial',
  'meeting',
  'news-commentary',
  'debate',
  'review',
] as const;

export type SummaryTemplate = (typeof SUMMARY_TEMPLATES)[number];

export interface SummaryClassificationInput {
  readonly title?: string;
  readonly description?: string;
  readonly transcriptSample?: string;
  readonly participantCount?: number;
  readonly sourceKind?: 'audio' | 'video' | 'article' | 'meeting' | 'podcast';
}

export interface SummaryTemplateClassification {
  readonly template: SummaryTemplate;
  readonly confidence: number;
  readonly scores: Readonly<Record<SummaryTemplate, number>>;
}

const KEYWORDS: Readonly<Record<SummaryTemplate, readonly string[]>> = {
  course: ['课程', '讲座', 'lecture', 'lesson', 'chapter', '学习目标'],
  interview: ['采访', '访谈', 'interview', '嘉宾', 'host', 'guest'],
  podcast: ['播客', 'podcast', 'episode', 'shownotes'],
  tutorial: ['教程', '步骤', 'how to', 'tutorial', '实操', '安装'],
  meeting: ['会议', '议程', '待办', 'meeting', 'action item', 'minutes'],
  'news-commentary': ['新闻', '时事', '观点', '分析', '剖析', '解读', 'breaking', 'news', '报道', '评论'],
  debate: ['辩论', '正方', '反方', 'debate', 'rebuttal', '反驳'],
  review: ['评测', '测评', 'review', '优缺点', '体验', '评分'],
};

export function classifySummaryTemplate(input: SummaryClassificationInput): SummaryTemplateClassification {
  const text = `${input.title ?? ''}\n${input.description ?? ''}\n${input.transcriptSample ?? ''}`.toLowerCase();
  const scores = Object.fromEntries(
    SUMMARY_TEMPLATES.map((template) => [
      template,
      KEYWORDS[template].reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0),
    ]),
  ) as Record<SummaryTemplate, number>;

  if (input.sourceKind === 'podcast') scores.podcast += 3;
  if (input.sourceKind === 'meeting') scores.meeting += 3;
  if ((input.participantCount ?? 0) >= 2) scores.interview += 1;

  const ranked = SUMMARY_TEMPLATES.map((template) => ({ template, score: scores[template] })).sort(
    (left, right) => right.score - left.score,
  );
  const best = ranked[0] ?? { template: 'course' as const, score: 0 };
  const total = ranked.reduce((sum, item) => sum + item.score, 0);
  return {
    template: best.template,
    confidence: total === 0 ? 0 : Number((best.score / total).toFixed(3)),
    scores: Object.freeze(scores),
  };
}
