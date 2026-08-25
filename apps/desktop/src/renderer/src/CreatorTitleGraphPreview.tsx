import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import type {
  CreatorTitleGraphEdgeSummary,
  CreatorTitleGraphNodeSummary,
  CreatorTitleGraphSummary,
} from '../../shared/contracts';

interface StarPoint extends CreatorTitleGraphNodeSummary {
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  component: number;
  readonly neighbors: Set<string>;
}

export interface CreatorStarLayout {
  readonly points: StarPoint[];
  readonly edges: readonly CreatorTitleGraphEdgeSummary[];
  readonly pointById: Map<string, StarPoint>;
  readonly bounds: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
}

interface ViewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

interface PointerOperation {
  readonly mode: 'pan' | 'node';
  readonly nodeId?: string;
  lastX: number;
  lastY: number;
  moved: boolean;
}

const COLORS = ['#8a4df2', '#4f79e8', '#2f9f8f', '#c06a45', '#b44d83', '#6c6ad4'] as const;
const MIN_SCALE = 0.08;
const MAX_SCALE = 4;

function deterministicUnit(value: string): number {
  const integer = Number.parseInt(value.slice(0, 8), 16);
  return Number.isFinite(integer) ? integer / 0xffffffff : 0.5;
}

function graphComponents(
  nodes: readonly CreatorTitleGraphNodeSummary[],
  edges: readonly CreatorTitleGraphEdgeSummary[],
): readonly string[][] {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.fromNode)?.add(edge.toNode);
    adjacency.get(edge.toNode)?.add(edge.fromNode);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const component: string[] = [];
    const pending = [node.id];
    visited.add(node.id);
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

function settleForces(
  points: StarPoint[],
  edges: readonly CreatorTitleGraphEdgeSummary[],
  centers: readonly { readonly x: number; readonly y: number }[],
): void {
  const pointById = new Map(points.map((point) => [point.id, point]));
  const cellSize = 90;
  for (let iteration = 0; iteration < 72; iteration += 1) {
    for (const edge of edges) {
      const left = pointById.get(edge.fromNode);
      const right = pointById.get(edge.toNode);
      if (!left || !right) continue;
      const dx = right.x - left.x;
      const dy = right.y - left.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const target = 70 + (1 - edge.score) * 80;
      const force = (distance - target) * 0.012;
      const fx = dx / distance * force;
      const fy = dy / distance * force;
      left.vx += fx;
      left.vy += fy;
      right.vx -= fx;
      right.vy -= fy;
    }
    const cells = new Map<string, StarPoint[]>();
    for (const point of points) {
      const key = `${String(Math.floor(point.x / cellSize))}:${String(Math.floor(point.y / cellSize))}`;
      cells.set(key, [...(cells.get(key) ?? []), point]);
    }
    for (const point of points) {
      const column = Math.floor(point.x / cellSize);
      const row = Math.floor(point.y / cellSize);
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (const other of cells.get(`${String(column + offsetX)}:${String(row + offsetY)}`) ?? []) {
            if (other.id <= point.id) continue;
            let dx = other.x - point.x;
            let dy = other.y - point.y;
            if (dx === 0 && dy === 0) {
              dx = deterministicUnit(point.id) - 0.5;
              dy = deterministicUnit(other.id) - 0.5;
            }
            const distance = Math.max(1, Math.hypot(dx, dy));
            if (distance >= 84) continue;
            const force = (84 - distance) * 0.018;
            const fx = dx / distance * force;
            const fy = dy / distance * force;
            point.vx -= fx;
            point.vy -= fy;
            other.vx += fx;
            other.vy += fy;
          }
        }
      }
    }
    for (const point of points) {
      const center = centers[point.component] ?? { x: 0, y: 0 };
      point.vx += (center.x - point.x) * 0.0018;
      point.vy += (center.y - point.y) * 0.0018;
      point.vx *= 0.78;
      point.vy *= 0.78;
      point.x += point.vx;
      point.y += point.vy;
    }
  }
}

export function buildCreatorStarLayout(graph: CreatorTitleGraphSummary): CreatorStarLayout {
  const components = graphComponents(graph.nodes, graph.edges);
  const componentByNode = new Map<string, number>();
  const centers = components.map((component, index) => {
    component.forEach((id) => componentByNode.set(id, index));
    if (index === 0) return { x: 0, y: 0 };
    const angle = index * 2.399963229728653;
    const radius = 260 + Math.sqrt(index) * 230;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  const degrees = new Map<string, number>();
  const neighbors = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of graph.edges) {
    degrees.set(edge.fromNode, (degrees.get(edge.fromNode) ?? 0) + 1);
    degrees.set(edge.toNode, (degrees.get(edge.toNode) ?? 0) + 1);
    neighbors.get(edge.fromNode)?.add(edge.toNode);
    neighbors.get(edge.toNode)?.add(edge.fromNode);
  }
  const indexWithinComponent = new Map<string, number>();
  const sortedComponents = components.map((component) => [...component].sort((left, right) =>
    (degrees.get(right) ?? 0) - (degrees.get(left) ?? 0) || left.localeCompare(right)));
  sortedComponents.forEach((component) => component.forEach((id, index) => indexWithinComponent.set(id, index)));
  const points: StarPoint[] = graph.nodes.map((node) => {
    const component = componentByNode.get(node.id) ?? 0;
    const members = sortedComponents[component] ?? [node.id];
    const index = indexWithinComponent.get(node.id) ?? 0;
    const center = centers[component] ?? { x: 0, y: 0 };
    const angle = 2 * Math.PI * index / Math.max(1, members.length) + deterministicUnit(node.id) * 0.35;
    const degree = degrees.get(node.id) ?? 0;
    const radius = members.length === 1 ? 0 : 42 + Math.sqrt(index + 1) * 34 + Math.max(0, 4 - degree) * 12;
    return {
      ...node,
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      degree,
      component,
      neighbors: neighbors.get(node.id) ?? new Set<string>(),
    };
  });
  settleForces(points, graph.edges, centers);
  const bounds = {
    minX: Math.min(...points.map((point) => point.x), 0),
    minY: Math.min(...points.map((point) => point.y), 0),
    maxX: Math.max(...points.map((point) => point.x), 0),
    maxY: Math.max(...points.map((point) => point.y), 0),
  };
  return { points, edges: graph.edges, pointById: new Map(points.map((point) => [point.id, point])), bounds };
}

function shortTitle(value: string, maximum = 22): string {
  return [...value].length > maximum ? `${[...value].slice(0, maximum - 1).join('')}…` : value;
}

function fitView(layout: CreatorStarLayout, width: number, height: number): ViewTransform {
  const graphWidth = Math.max(120, layout.bounds.maxX - layout.bounds.minX + 140);
  const graphHeight = Math.max(120, layout.bounds.maxY - layout.bounds.minY + 140);
  const scale = Math.max(MIN_SCALE, Math.min(1.5, (width - 40) / graphWidth, (height - 40) / graphHeight));
  const centerX = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const centerY = (layout.bounds.minY + layout.bounds.maxY) / 2;
  return { scale, x: width / 2 - centerX * scale, y: height / 2 - centerY * scale };
}

function screenPoint(
  event: ReactMouseEvent<HTMLCanvasElement> | ReactPointerEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>,
): { x: number; y: number } {
  const rectangle = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
}

function hitPoint(layout: CreatorStarLayout, view: ViewTransform, x: number, y: number): StarPoint | undefined {
  const worldX = (x - view.x) / view.scale;
  const worldY = (y - view.y) / view.scale;
  let closest: StarPoint | undefined;
  let closestDistance = 15 / view.scale;
  for (const point of layout.points) {
    const distance = Math.hypot(point.x - worldX, point.y - worldY);
    if (distance < closestDistance) {
      closest = point;
      closestDistance = distance;
    }
  }
  return closest;
}

export function CreatorTitleGraphPreview({
  graph,
  onClose,
  onOpenUrl,
}: {
  readonly graph: CreatorTitleGraphSummary;
  readonly onClose: () => void;
  readonly onOpenUrl: (url: string) => void;
}) {
  const layout = useMemo(() => buildCreatorStarLayout(graph), [graph]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<PointerOperation | null>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [view, setView] = useState<ViewTransform>(() => fitView(layout, 900, 600));
  const [hoveredId, setHoveredId] = useState('');
  const [focusedId, setFocusedId] = useState('');
  const [search, setSearch] = useState('');
  const [layoutVersion, setLayoutVersion] = useState(0);
  const focused = layout.pointById.get(focusedId);
  const isolatedCount = layout.points.filter((point) => point.degree === 0).length;
  const suggestions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN');
    if (!query) return [];
    return layout.points.filter((point) => point.title.toLocaleLowerCase('zh-CN').includes(query)).slice(0, 8);
  }, [layout, search]);

  useEffect(() => {
    const target = viewportRef.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.max(320, Math.floor(entry.contentRect.width));
      const height = Math.max(320, Math.floor(entry.contentRect.height));
      setSize({ width, height });
      setView(fitView(layout, width, height));
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [layout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.width * pixelRatio);
    canvas.height = Math.round(size.height * pixelRatio);
    canvas.style.width = `${String(size.width)}px`;
    canvas.style.height = `${String(size.height)}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);
    const activeId = hoveredId || focusedId;
    const active = layout.pointById.get(activeId);
    for (const edge of layout.edges) {
      const from = layout.pointById.get(edge.fromNode);
      const to = layout.pointById.get(edge.toNode);
      if (!from || !to) continue;
      const incident = !active || edge.fromNode === active.id || edge.toNode === active.id;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.strokeStyle = incident ? `rgba(112, 85, 180, ${active ? '0.78' : '0.24'})` : 'rgba(120, 124, 130, 0.045)';
      context.lineWidth = (incident && active ? 1.6 : 0.8) / view.scale;
      context.stroke();
    }
    const hubs = [...layout.points].sort((left, right) => right.degree - left.degree).slice(0, 10);
    const labelled = new Set(active
      ? [active.id, ...[...active.neighbors].slice(0, 12)]
      : hubs.filter((point) => point.degree > 0).map((point) => point.id));
    for (const point of layout.points) {
      const neighbor = active?.neighbors.has(point.id) ?? false;
      const dimmed = Boolean(active) && point.id !== active?.id && !neighbor;
      const radius = (3.2 + Math.log2(point.degree + 1) * 1.7 + (point.id === active?.id ? 2.5 : 0)) / view.scale;
      const color = COLORS[point.component % COLORS.length] ?? COLORS[0];
      context.globalAlpha = dimmed ? 0.13 : point.degree === 0 ? 0.48 : 0.94;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = color;
      context.shadowColor = color;
      context.shadowBlur = dimmed ? 0 : 7 / view.scale;
      context.fill();
      context.shadowBlur = 0;
      if (labelled.has(point.id) && !dimmed) {
        context.globalAlpha = 0.9;
        context.font = `${String(11 / view.scale)}px Inter, "Microsoft YaHei", sans-serif`;
        context.fillStyle = '#3b3c39';
        context.fillText(shortTitle(point.title), point.x + radius + 5 / view.scale, point.y + 4 / view.scale);
      }
    }
    context.globalAlpha = 1;
    context.restore();
  }, [focusedId, hoveredId, layout, layoutVersion, size, view]);

  const zoomAtCenter = (factor: number) => {
    setView((current) => {
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, current.scale * factor));
      const worldX = (size.width / 2 - current.x) / current.scale;
      const worldY = (size.height / 2 - current.y) / current.scale;
      return { scale: nextScale, x: size.width / 2 - worldX * nextScale, y: size.height / 2 - worldY * nextScale };
    });
  };

  const focusPoint = (point: StarPoint) => {
    setFocusedId(point.id);
    setSearch(point.title);
    setView((current) => ({ ...current, x: size.width / 2 - point.x * current.scale, y: size.height / 2 - point.y * current.scale }));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const position = screenPoint(event);
    const point = hitPoint(layout, view, position.x, position.y);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = {
      mode: point ? 'node' : 'pan',
      ...(point ? { nodeId: point.id } : {}),
      lastX: position.x,
      lastY: position.y,
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const position = screenPoint(event);
    const operation = pointerRef.current;
    if (!operation) {
      setHoveredId(hitPoint(layout, view, position.x, position.y)?.id ?? '');
      return;
    }
    const dx = position.x - operation.lastX;
    const dy = position.y - operation.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 1) operation.moved = true;
    operation.lastX = position.x;
    operation.lastY = position.y;
    if (operation.mode === 'pan') {
      setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
      return;
    }
    const point = operation.nodeId ? layout.pointById.get(operation.nodeId) : undefined;
    if (point) {
      point.x += dx / view.scale;
      point.y += dy / view.scale;
      setLayoutVersion((current) => current + 1);
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const operation = pointerRef.current;
    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!operation?.moved && operation?.nodeId) setFocusedId(operation.nodeId);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const position = screenPoint(event);
    setView((current) => {
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, current.scale * Math.exp(-event.deltaY * 0.001)));
      const worldX = (position.x - current.x) / current.scale;
      const worldY = (position.y - current.y) / current.scale;
      return { scale: nextScale, x: position.x - worldX * nextScale, y: position.y - worldY * nextScale };
    });
  };

  return (
    <section className="creator-title-graph" aria-label={`${graph.creatorTitle} 标题知识星图`} role="dialog" aria-modal="true">
      <header className="creator-title-graph-heading">
        <span>
          <small>// CREATOR KNOWLEDGE GRAPH</small>
          <strong>{graph.creatorTitle} · 知识星图</strong>
          <small>悬停看关系，点击聚焦邻居，双击打开原内容。</small>
        </span>
        <button className="creator-title-graph-close" onClick={onClose} type="button">关闭</button>
      </header>
      <div className="creator-title-graph-stage" ref={viewportRef}>
        <canvas
          aria-label={`可交互知识星图：${String(graph.nodeCount)} 个标题节点，${String(graph.edgeCount)} 条关系`}
          onDoubleClick={(event) => {
            const position = screenPoint(event);
            const point = hitPoint(layout, view, position.x, position.y);
            if (point?.url) onOpenUrl(point.url);
          }}
          onPointerDown={handlePointerDown}
          onPointerLeave={() => { if (!pointerRef.current) setHoveredId(''); }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          ref={canvasRef}
          tabIndex={0}
        />
        <aside className="creator-title-graph-lens">
          <small>GLOBAL TITLE GRAPH</small>
          <strong>{graph.nodeCount} 标题</strong>
          <span>{graph.edgeCount} 关系 · {isolatedCount} 孤岛</span>
          <hr />
          {focused ? <>
            <small>FOCUSED NODE</small>
            <strong>{focused.title}</strong>
            <span>{focused.degree} 个直接关联</span>
          </> : <p>节点大小代表连接数。选择一个节点，展开它的局部标题网络。</p>}
        </aside>
        <div className="creator-title-graph-search">
          <input
            aria-label="搜索星图节点"
            list="creator-title-graph-suggestions"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && suggestions[0]) focusPoint(suggestions[0]);
            }}
            placeholder={`搜索 ${String(graph.nodeCount)} 个标题…`}
            value={search}
          />
          <datalist id="creator-title-graph-suggestions">
            {suggestions.map((point) => <option key={point.id} value={point.title} />)}
          </datalist>
        </div>
        <div className="creator-title-graph-controls" aria-label="星图视图控制" role="group">
          <button aria-label="缩小星图" onClick={() => zoomAtCenter(0.8)} type="button">−</button>
          <span>{Math.round(view.scale * 100)}%</span>
          <button aria-label="放大星图" onClick={() => zoomAtCenter(1.25)} type="button">＋</button>
          <button aria-label="让全部节点适合画布" onClick={() => setView(fitView(layout, size.width, size.height))} type="button">适配</button>
        </div>
      </div>
      <footer className="creator-title-graph-footer">
        <span>拖拽平移 · 拖动节点 · 滚轮缩放 · 双击打开</span>
        <span>{graph.path}</span>
      </footer>
    </section>
  );
}
