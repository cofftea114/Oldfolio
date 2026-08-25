import { createHash } from 'node:crypto';

export interface CreatorTitleGraphEntry {
  readonly id: string;
  readonly title: string;
  readonly link?: string;
  readonly mediaUrl?: string;
  readonly publishedAt?: string;
}

export interface CreatorTitleGraphNode {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly publishedAt?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color?: string;
}

export interface CreatorTitleGraphEdge {
  readonly id: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly score: number;
  readonly terms: readonly string[];
  readonly color?: string;
}

interface CanvasTextNode {
  readonly id: string;
  readonly type: 'text';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly color?: string;
}

interface CanvasEdge {
  readonly id: string;
  readonly fromNode: string;
  readonly fromEnd: 'none';
  readonly toNode: string;
  readonly toEnd: 'none';
  readonly color?: string;
}

export interface CreatorTitleGraphResult {
  readonly creatorId: string;
  readonly creatorTitle: string;
  readonly generatedAt: string;
  readonly nodes: readonly CreatorTitleGraphNode[];
  readonly edges: readonly CreatorTitleGraphEdge[];
  readonly relatedNodeCount: number;
  readonly canvas: {
    readonly nodes: readonly CanvasTextNode[];
    readonly edges: readonly CanvasEdge[];
  };
}

interface CandidatePair {
  readonly left: number;
  readonly right: number;
  sharedWeight: number;
  readonly terms: Set<string>;
}

const NODE_WIDTH = 340;
const NODE_HEIGHT = 120;
const COLUMN_GAP = 80;
const ROW_GAP = 60;
const COMPONENT_GAP = 140;
const MAX_DEGREE = 4;
const COLORS = ['1', '2', '3', '4', '5', '6'] as const;
const COMMON_LATIN = new Set(['the', 'and', 'for', 'with', 'from', 'video', 'youtube', 'official']);
const COMMON_HAN = new Set(['视频', '解说', '分享', '最新', '完整', '合集', '频道', '节目', '观看']);

function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function markdownText(value: string): string {
  return value
    .replaceAll(/[\\`*_{}<>#]/gu, '\\$&')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function validDate(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

function tokenize(title: string, creatorTitle: string): ReadonlyMap<string, string> {
  const normalizedCreator = creatorTitle.normalize('NFKC').trim();
  const normalized = title.normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replaceAll(normalizedCreator.toLocaleLowerCase('zh-CN'), ' ');
  const tokens = new Map<string, string>();
  for (const match of normalized.matchAll(/[\p{Script=Latin}\p{Number}][\p{Script=Latin}\p{Number}._+-]{1,}/gu)) {
    const token = match[0].replaceAll(/^[._+-]+|[._+-]+$/gu, '');
    if (token.length < 2 || COMMON_LATIN.has(token)) continue;
    tokens.set(`latin:${token}`, token);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const characters = [...match[0]];
    for (const width of [2, 3]) {
      for (let index = 0; index + width <= characters.length; index += 1) {
        const token = characters.slice(index, index + width).join('');
        if (COMMON_HAN.has(token)) continue;
        tokens.set(`han${String(width)}:${token}`, token);
      }
    }
  }
  return tokens;
}

function tokenWeight(token: string, documentFrequency: number, documentCount: number): number {
  const base = Math.log((documentCount + 1) / (documentFrequency + 1)) + 1;
  return token.startsWith('han3:') ? base * 1.25 : token.startsWith('latin:') ? base * 1.15 : base;
}

function buildCandidatePairs(
  tokenMaps: readonly ReadonlyMap<string, string>[],
): readonly { readonly pair: CandidatePair; readonly score: number }[] {
  const postings = new Map<string, number[]>();
  tokenMaps.forEach((tokens, index) => {
    for (const token of tokens.keys()) postings.set(token, [...(postings.get(token) ?? []), index]);
  });
  const documentCount = tokenMaps.length;
  const maximumPosting = Math.min(80, Math.max(8, Math.ceil(documentCount * 0.1)));
  const eligible = [...postings.entries()].filter(([, indexes]) => indexes.length >= 2 && indexes.length <= maximumPosting);
  const totals = tokenMaps.map((tokens) => [...tokens.keys()].reduce((total, token) => {
    const frequency = postings.get(token)?.length ?? 0;
    return frequency >= 2 && frequency <= maximumPosting
      ? total + tokenWeight(token, frequency, documentCount)
      : total;
  }, 0));
  const pairs = new Map<string, CandidatePair>();
  for (const [token, indexes] of eligible) {
    const weight = tokenWeight(token, indexes.length, documentCount);
    for (let leftIndex = 0; leftIndex < indexes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < indexes.length; rightIndex += 1) {
        const left = indexes[leftIndex]!;
        const right = indexes[rightIndex]!;
        const key = `${String(left)}:${String(right)}`;
        const pair = pairs.get(key) ?? { left, right, sharedWeight: 0, terms: new Set<string>() };
        pair.sharedWeight += weight;
        pair.terms.add(token);
        pairs.set(key, pair);
      }
    }
  }
  return [...pairs.values()].flatMap((pair) => {
    const denominator = Math.min(totals[pair.left] ?? 0, totals[pair.right] ?? 0);
    if (denominator <= 0) return [];
    const score = pair.sharedWeight / denominator;
    const strongTerm = [...pair.terms].some((token) => token.startsWith('han3:') || token.replace(/^[^:]+:/u, '').length >= 4);
    if (score < 0.28 || (pair.terms.size < 2 && !strongTerm)) return [];
    return [{ pair, score }];
  }).sort((left, right) => right.score - left.score || left.pair.left - right.pair.left || left.pair.right - right.pair.right);
}

function selectEdges(
  creatorId: string,
  entries: readonly CreatorTitleGraphEntry[],
  tokenMaps: readonly ReadonlyMap<string, string>[],
): readonly CreatorTitleGraphEdge[] {
  const degrees = entries.map(() => 0);
  const edges: CreatorTitleGraphEdge[] = [];
  for (const candidate of buildCandidatePairs(tokenMaps)) {
    const { left, right, terms } = candidate.pair;
    if ((degrees[left] ?? 0) >= MAX_DEGREE || (degrees[right] ?? 0) >= MAX_DEGREE) continue;
    const leftId = hashId(`creator-title-node:${creatorId}:${entries[left]!.id}`);
    const rightId = hashId(`creator-title-node:${creatorId}:${entries[right]!.id}`);
    const displays = [...terms]
      .map((token) => tokenMaps[left]?.get(token) ?? tokenMaps[right]?.get(token) ?? token.replace(/^[^:]+:/u, ''))
      .sort((a, b) => [...b].length - [...a].length || a.localeCompare(b, 'zh-CN'))
      .slice(0, 3);
    edges.push({
      id: hashId(`creator-title-edge:${creatorId}:${[leftId, rightId].sort().join(':')}`),
      fromNode: leftId,
      toNode: rightId,
      score: Number(candidate.score.toFixed(4)),
      terms: displays,
    });
    degrees[left] = (degrees[left] ?? 0) + 1;
    degrees[right] = (degrees[right] ?? 0) + 1;
  }
  return edges;
}

function connectedComponents(nodeIds: readonly string[], edges: readonly CreatorTitleGraphEdge[]): readonly string[][] {
  const adjacency = new Map(nodeIds.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.fromNode)?.add(edge.toNode);
    adjacency.get(edge.toNode)?.add(edge.fromNode);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of nodeIds) {
    if (visited.has(id)) continue;
    const component: string[] = [];
    const pending = [id];
    visited.add(id);
    while (pending.length > 0) {
      const current = pending.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    components.push(component);
  }
  return components.sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!));
}

function layoutNodes(
  entries: readonly CreatorTitleGraphEntry[],
  nodeIds: readonly string[],
  edges: readonly CreatorTitleGraphEdge[],
): readonly CreatorTitleGraphNode[] {
  const entryByNode = new Map(nodeIds.map((id, index) => [id, entries[index]!]));
  const components = connectedComponents(nodeIds, edges);
  const related = components.filter((component) => component.length > 1);
  const singletons = components.flatMap((component) => component.length === 1 ? component : []);
  const ordered = [...related, ...(singletons.length > 0 ? [singletons] : [])];
  const positions = new Map<string, { readonly x: number; readonly y: number; readonly color?: string }>();
  let yOffset = 0;
  ordered.forEach((component, componentIndex) => {
    const columns = component === singletons ? 6 : Math.min(6, Math.max(2, Math.ceil(Math.sqrt(component.length))));
    const sorted = [...component].sort((left, right) => {
      const leftEntry = entryByNode.get(left)!;
      const rightEntry = entryByNode.get(right)!;
      const leftTime = Date.parse(leftEntry.publishedAt ?? '');
      const rightTime = Date.parse(rightEntry.publishedAt ?? '');
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
      return leftEntry.title.localeCompare(rightEntry.title, 'zh-CN');
    });
    sorted.forEach((id, index) => positions.set(id, {
      x: (index % columns) * (NODE_WIDTH + COLUMN_GAP),
      y: yOffset + Math.floor(index / columns) * (NODE_HEIGHT + ROW_GAP),
      ...(component === singletons ? {} : { color: COLORS[componentIndex % COLORS.length] }),
    }));
    yOffset += Math.ceil(component.length / columns) * (NODE_HEIGHT + ROW_GAP) + COMPONENT_GAP;
  });
  return nodeIds.map((id, index) => {
    const entry = entries[index]!;
    const position = positions.get(id)!;
    const url = entry.link ?? entry.mediaUrl;
    return {
      id,
      title: entry.title,
      ...(url ? { url } : {}),
      ...(validDate(entry.publishedAt) ? { publishedAt: entry.publishedAt } : {}),
      x: position.x,
      y: position.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      ...(position.color ? { color: position.color } : {}),
    };
  });
}

function validateCanvas(nodes: readonly CanvasTextNode[], edges: readonly CanvasEdge[]): void {
  const ids = new Set<string>();
  for (const item of [...nodes, ...edges]) {
    if (!/^[a-f0-9]{16}$/u.test(item.id) || ids.has(item.id)) throw new Error('标题关系图包含无效或重复的 ID。');
    ids.add(item.id);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (edges.some((edge) => !nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode))) {
    throw new Error('标题关系图包含断开的边引用。');
  }
}

export function buildCreatorTitleGraph(
  creatorId: string,
  creatorTitle: string,
  inputEntries: readonly CreatorTitleGraphEntry[],
  generatedAt: string,
): CreatorTitleGraphResult {
  if (!/^creator-[a-f0-9]{16}$/u.test(creatorId)) throw new Error('博主 ID 无效。');
  if (!creatorTitle.trim()) throw new Error('博主标题不能为空。');
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('关系图生成时间无效。');
  const entries = [...new Map(inputEntries.map((entry) => [entry.id, entry])).values()]
    .filter((entry) => entry.id && entry.title.trim())
    .slice(0, 2_000);
  if (entries.length === 0) throw new Error('该博主还没有可用于生成关系图的历史标题。');
  const tokenMaps = entries.map((entry) => tokenize(entry.title, creatorTitle));
  const nodeIds = entries.map((entry) => hashId(`creator-title-node:${creatorId}:${entry.id}`));
  const rawEdges = selectEdges(creatorId, entries, tokenMaps);
  const nodes = layoutNodes(entries, nodeIds, rawEdges);
  const colorByNode = new Map(nodes.map((node) => [node.id, node.color]));
  const edges: CreatorTitleGraphEdge[] = rawEdges.map((edge) => {
    const color = colorByNode.get(edge.fromNode);
    return { ...edge, ...(color ? { color } : {}) };
  });
  const canvasNodes: CanvasTextNode[] = nodes.map((node) => ({
    id: node.id,
    type: 'text',
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    text: [
      `**${markdownText(node.title)}**`,
      node.publishedAt ? `\n${node.publishedAt.slice(0, 10)}` : '',
      node.url ? `\n[打开原内容](<${node.url}>)` : '',
    ].join(''),
    ...(node.color ? { color: node.color } : {}),
  }));
  const canvasEdges: CanvasEdge[] = edges.map((edge) => ({
    id: edge.id,
    fromNode: edge.fromNode,
    fromEnd: 'none',
    toNode: edge.toNode,
    toEnd: 'none',
    ...(edge.color ? { color: edge.color } : {}),
  }));
  validateCanvas(canvasNodes, canvasEdges);
  const related = new Set(edges.flatMap((edge) => [edge.fromNode, edge.toNode]));
  return {
    creatorId,
    creatorTitle: creatorTitle.trim(),
    generatedAt,
    nodes,
    edges,
    relatedNodeCount: related.size,
    canvas: { nodes: canvasNodes, edges: canvasEdges },
  };
}
