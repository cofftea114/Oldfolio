import { describe, expect, it } from 'vitest';

import { buildCreatorTitleGraph } from './creator-title-graph.js';

const CREATOR_ID = 'creator-0123456789abcdef';
const ENTRIES = [
  { id: 'deepseek-install', title: 'DeepSeek 本地部署教程 | 测试博主', link: 'https://example.test/deepseek-install', publishedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'deepseek-guide', title: 'DeepSeek 本地模型安装指南 | 测试博主', link: 'https://example.test/deepseek-guide', publishedAt: '2026-07-01T00:00:00.000Z' },
  { id: 'openai-api', title: 'OpenAI API 配置教程 | 测试博主', link: 'https://example.test/openai-api' },
  { id: 'openai-key', title: 'OpenAI 接口 Key 配置指南 | 测试博主', link: 'https://example.test/openai-key' },
  { id: 'history', title: '康熙晚年的继承难题 | 测试博主', link: 'https://example.test/history' },
  { id: 'economy', title: '美国制造业周期观察 | 测试博主', link: 'https://example.test/economy' },
] as const;

describe('creator title knowledge graph', () => {
  it('connects related titles with straight undirected JSON Canvas edges', () => {
    const graph = buildCreatorTitleGraph(CREATOR_ID, '测试博主', ENTRIES, '2026-08-25T00:00:00.000Z');
    expect(graph.nodes).toHaveLength(ENTRIES.length);
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);
    const titleByNode = new Map(graph.nodes.map((node) => [node.id, node.title]));
    const linkedTitles = graph.edges.map((edge) => [titleByNode.get(edge.fromNode), titleByNode.get(edge.toNode)]);
    expect(linkedTitles.some((titles) => titles.every((title) => title?.includes('DeepSeek')))).toBe(true);
    expect(linkedTitles.some((titles) => titles.every((title) => title?.includes('OpenAI')))).toBe(true);
    expect(graph.canvas.edges.every((edge) => edge.fromEnd === 'none' && edge.toEnd === 'none')).toBe(true);
  });

  it('produces deterministic valid IDs and resolvable edge references', () => {
    const first = buildCreatorTitleGraph(CREATOR_ID, '测试博主', ENTRIES, '2026-08-25T00:00:00.000Z');
    const second = buildCreatorTitleGraph(CREATOR_ID, '测试博主', ENTRIES, '2026-08-25T00:00:00.000Z');
    expect(second.canvas).toEqual(first.canvas);
    const allIds = [...first.canvas.nodes, ...first.canvas.edges].map((item) => item.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.every((id) => /^[a-f0-9]{16}$/u.test(id))).toBe(true);
    const nodeIds = new Set(first.canvas.nodes.map((node) => node.id));
    expect(first.canvas.edges.every((edge) => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode))).toBe(true);
    expect(() => { JSON.parse(`${JSON.stringify(first.canvas)}\n`); }).not.toThrow();
    expect(first.canvas.nodes[0]?.text).toContain('\n');
    expect(first.canvas.nodes[0]?.text).not.toContain('\\n');
  });

  it('bounds relationship density for a 2,000-title creator history', () => {
    const entries = Array.from({ length: 2_000 }, (_, index) => ({
      id: `entry-${String(index)}`,
      title: `专题 ${String(index % 40)} 深度分析 第 ${String(index)} 期`,
      link: `https://example.test/watch/${String(index)}`,
    }));
    const graph = buildCreatorTitleGraph(CREATOR_ID, '测试博主', entries, '2026-08-25T00:00:00.000Z');
    const degrees = new Map<string, number>();
    for (const edge of graph.edges) {
      degrees.set(edge.fromNode, (degrees.get(edge.fromNode) ?? 0) + 1);
      degrees.set(edge.toNode, (degrees.get(edge.toNode) ?? 0) + 1);
    }
    expect(graph.nodes).toHaveLength(2_000);
    expect(Math.max(0, ...degrees.values())).toBeLessThanOrEqual(4);
    expect(graph.edges.length).toBeLessThanOrEqual(4_000);
  });
});
