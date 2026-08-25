import { describe, expect, it } from 'vitest';

import type { CreatorTitleGraphSummary } from '../../shared/contracts.js';
import { buildCreatorStarLayout } from './CreatorTitleGraphPreview.js';

const graph: CreatorTitleGraphSummary = {
  creatorId: 'creator-1',
  creatorTitle: '测试创作者',
  path: 'bundles/creators/creator-1/wiki/graphs/title-knowledge-network.canvas',
  generatedAt: '2026-08-25T00:00:00.000Z',
  nodeCount: 5,
  edgeCount: 3,
  relatedNodeCount: 4,
  nodes: [
    { id: '0000000000000001', title: '大模型推理方法', x: 0, y: 0, width: 360, height: 160 },
    { id: '0000000000000002', title: 'DeepSeek 推理实践', x: 0, y: 0, width: 360, height: 160 },
    { id: '0000000000000003', title: '本地模型部署', x: 0, y: 0, width: 360, height: 160 },
    { id: '0000000000000004', title: '模型上下文设计', x: 0, y: 0, width: 360, height: 160 },
    { id: '0000000000000005', title: '孤立标题', x: 0, y: 0, width: 360, height: 160 },
  ],
  edges: [
    { id: '1000000000000001', fromNode: '0000000000000001', toNode: '0000000000000002', score: 0.8, terms: ['推理'] },
    { id: '1000000000000002', fromNode: '0000000000000001', toNode: '0000000000000003', score: 0.7, terms: ['模型'] },
    { id: '1000000000000003', fromNode: '0000000000000001', toNode: '0000000000000004', score: 0.6, terms: ['模型'] },
  ],
};

describe('creator knowledge star layout', () => {
  it('places every title deterministically at finite coordinates', () => {
    const first = buildCreatorStarLayout(graph);
    const second = buildCreatorStarLayout(graph);

    expect(first.points).toHaveLength(graph.nodes.length);
    expect(first.points.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      second.points.map(({ id, x, y }) => ({ id, x, y })),
    );
    expect(first.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(first.bounds.maxX).toBeGreaterThanOrEqual(first.bounds.minX);
    expect(first.bounds.maxY).toBeGreaterThanOrEqual(first.bounds.minY);
  });

  it('derives degree, neighbor and component metadata from graph edges', () => {
    const layout = buildCreatorStarLayout(graph);
    const hub = layout.pointById.get('0000000000000001');
    const isolated = layout.pointById.get('0000000000000005');

    expect(hub?.degree).toBe(3);
    expect([...hub!.neighbors].sort()).toEqual([
      '0000000000000002',
      '0000000000000003',
      '0000000000000004',
    ]);
    expect(isolated?.degree).toBe(0);
    expect(isolated?.component).not.toBe(hub?.component);
  });
});
