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
  anchorX: number;
  anchorY: number;
  degree: number;
  component: number;
  arm: number;
  readonly neighbors: Set<string>;
}

export type GalaxyLayoutMode = 'spiral' | 'barred' | 'elliptical' | 'cluster';

export interface CreatorStarLayout {
  readonly mode: GalaxyLayoutMode;
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

interface DustParticle {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly alpha: number;
  readonly tint: number;
}

interface NebulaBlob {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly alpha: number;
  readonly tint: number;
}

interface SatelliteGlow {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly squash: number;
  readonly rotation: number;
  readonly tint: number;
}

interface BarGlow {
  readonly halfLength: number;
  readonly halfThickness: number;
}

interface GalaxyScene {
  readonly dust: readonly DustParticle[];
  readonly knots: readonly DustParticle[];
  readonly dustLanes: readonly DustLane[];
  readonly nebulae: readonly NebulaBlob[];
  readonly satellites: readonly SatelliteGlow[];
  readonly coreRadius: number;
  readonly bar: BarGlow | null;
}

interface BackgroundStar {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly alpha: number;
  readonly phase: number;
  readonly speed: number;
  readonly tint: number;
}

const SATELLITE_COLORS = ['#b58cff', '#8fa9ff', '#5fd6c4', '#e89a6c', '#e578b9', '#9c9cf0'] as const;
const MIN_SCALE = 0.08;
const MAX_SCALE = 4;
const GALAXY_LABELS: Record<GalaxyLayoutMode, string> = {
  spiral: '螺旋星系',
  barred: '棒旋星系',
  elliptical: '椭圆星系',
  cluster: '星团',
};

function deterministicUnit(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
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
  maximumDisplacement: number,
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
      point.vx += (point.anchorX - point.x) * 0.006;
      point.vy += (point.anchorY - point.y) * 0.006;
      point.vx += (center.x - point.x) * 0.0006;
      point.vy += (center.y - point.y) * 0.0006;
      point.vx *= 0.78;
      point.vy *= 0.78;
      point.x += point.vx;
      point.y += point.vy;
      const anchorDx = point.x - point.anchorX;
      const anchorDy = point.y - point.anchorY;
      const anchorDistance = Math.hypot(anchorDx, anchorDy);
      if (anchorDistance > maximumDisplacement) {
        point.x = point.anchorX + anchorDx / anchorDistance * maximumDisplacement;
        point.y = point.anchorY + anchorDy / anchorDistance * maximumDisplacement;
        point.vx *= 0.25;
        point.vy *= 0.25;
      }
    }
  }
}

function galaxyOffset(
  mode: GalaxyLayoutMode,
  index: number,
  count: number,
  id: string,
): { readonly x: number; readonly y: number; readonly arm: number } {
  if (count <= 1 || index === 0) return { x: 0, y: 0, arm: -1 };
  const jitter = (deterministicUnit(id) - 0.5) * 0.42;
  const goldenAngle = 2.399963229728653;
  if (mode === 'elliptical') {
    const radius = 50 + Math.sqrt(index / Math.max(1, count - 1)) * Math.max(110, Math.sqrt(count) * 48);
    const angle = index * goldenAngle + jitter;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.52, arm: index % 4 };
  }
  if (mode === 'cluster') {
    const angle = deterministicUnit(`${id}a`) * Math.PI * 2;
    const radius = 38 + Math.sqrt(deterministicUnit(`${id}b`)) * Math.max(120, Math.sqrt(count) * 55);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, arm: index % 5 };
  }
  if (mode === 'barred') {
    const barCount = Math.max(2, Math.ceil(count * 0.3));
    const barHalfLength = Math.max(90, Math.sqrt(count) * 21);
    if (index < barCount) {
      // 棒体有真实厚度：中段最厚、两端收细的椭圆包络
      const progress = index / Math.max(1, barCount - 1) - 0.5;
      const envelope = Math.sqrt(Math.max(0.12, 1 - (progress * 2) ** 2));
      const halfThickness = 9 + Math.min(11, count * 0.14);
      const lateral = (deterministicUnit(`${id}bar`) - 0.5) * 2 * halfThickness * envelope;
      return { x: progress * barHalfLength * 2, y: lateral, arm: -2 };
    }
    const armIndex = index - barCount;
    const arm = armIndex % 2;
    const step = Math.floor(armIndex / 2) + 1;
    // 旋臂从棒端拖出，缠绕更开、抖动更小，保证臂形连贯可读
    const radius = barHalfLength * 0.94 + Math.sqrt(step) * 46;
    const angle = (arm === 0 ? 0 : Math.PI) + step * 0.3 + jitter * 0.35;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, arm };
  }
  const arm = index % 3;
  const step = Math.floor(index / 3) + 1;
  const radius = 36 + Math.sqrt(step) * 57;
  const angle = arm * Math.PI * 2 / 3 + step * 0.48 + jitter;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, arm };
}

export function buildCreatorStarLayout(
  graph: CreatorTitleGraphSummary,
  mode: GalaxyLayoutMode = 'spiral',
): CreatorStarLayout {
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
    const degree = degrees.get(node.id) ?? 0;
    const offset = galaxyOffset(mode, index, members.length, node.id);
    const anchorX = center.x + offset.x;
    const anchorY = center.y + offset.y;
    return {
      ...node,
      x: anchorX,
      y: anchorY,
      vx: 0,
      vy: 0,
      anchorX,
      anchorY,
      degree,
      component,
      arm: offset.arm,
      neighbors: neighbors.get(node.id) ?? new Set<string>(),
    };
  });
  settleForces(points, graph.edges, centers, mode === 'spiral' || mode === 'barred' ? 8 : 34);
  const bounds = {
    minX: Math.min(...points.map((point) => point.x), 0),
    minY: Math.min(...points.map((point) => point.y), 0),
    maxX: Math.max(...points.map((point) => point.x), 0),
    maxY: Math.max(...points.map((point) => point.y), 0),
  };
  return { mode, points, edges: graph.edges, pointById: new Map(points.map((point) => [point.id, point])), bounds };
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

// 尘埃着色板：0 暖白 / 1 金 / 2 紫 / 3 蓝 / 4 青 / 5 粉 / 6 深空靛（星云）
const SPRITE_STOPS: readonly (readonly [string, string])[] = [
  ['rgba(255,252,242,0.95)', 'rgba(255,224,168,0)'],
  ['rgba(255,228,178,0.9)', 'rgba(255,158,94,0)'],
  ['rgba(224,204,255,0.9)', 'rgba(148,102,255,0)'],
  ['rgba(206,222,255,0.9)', 'rgba(96,134,255,0)'],
  ['rgba(205,255,244,0.9)', 'rgba(79,216,200,0)'],
  ['rgba(255,214,238,0.9)', 'rgba(255,127,196,0)'],
  ['rgba(168,178,255,0.55)', 'rgba(64,72,160,0)'],
];

function createGalaxySprites(): readonly HTMLCanvasElement[] {
  return SPRITE_STOPS.map(([inner, outer]) => {
    const sprite = document.createElement('canvas');
    sprite.width = 64;
    sprite.height = 64;
    const context = sprite.getContext('2d');
    if (!context) return sprite;
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, inner);
    gradient.addColorStop(0.38, inner.replace(/[\d.]+\)$/u, `${0.42})`));
    gradient.addColorStop(1, outer);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    return sprite;
  });
}

interface CurveSample {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly theta: number;
  readonly fade: number;
}

// 暗尘带：旋臂/棒内侧吸收光的路径，渲染时用 source-over 压暗
interface DustLane {
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly width: number;
  readonly alpha: number;
}

// 对数旋线采样：与节点锚点公式同源，保证云带、尘带与节点位置一致
function spiralArmSamples(
  baseAngle: number,
  startRadius: number,
  radiusStep: number,
  windPerStep: number,
  maxStep: number,
  startStep = 1,
  sampleCount = 130,
): CurveSample[] {
  const samples: CurveSample[] = [];
  for (let index = 0; index <= sampleCount; index += 1) {
    const progress = index / sampleCount;
    const step = startStep + progress * maxStep;
    const radius = startRadius + Math.sqrt(step) * radiusStep;
    const theta = baseAngle + windPerStep * step;
    const fade = progress < 0.8 ? 1 : 1 - ((progress - 0.8) / 0.2) * 0.75;
    samples.push({ x: Math.cos(theta) * radius, y: Math.sin(theta) * radius, radius, theta, fade });
  }
  return samples;
}

// 旋臂质感：大而暗的蓝白云团打底 + 偶发的小而亮星形成区结块（少量粉红 HII 区）
function scatterArmClouds(
  dust: DustParticle[],
  knots: DustParticle[],
  samples: readonly CurveSample[],
  maximumRadius: number,
  random: () => number,
): void {
  for (const sample of samples) {
    const ratio = Math.min(1, sample.radius / maximumRadius);
    const spread = 9 + sample.radius * 0.055;
    for (let index = 0; index < 3; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = (random() + random() - 1) * spread * 1.7;
      dust.push({
        x: sample.x + Math.cos(angle) * distance,
        y: sample.y + Math.sin(angle) * distance,
        size: 10 + random() * 22 + (1 - ratio) * 6,
        alpha: (0.05 + random() * 0.07) * (1.1 - ratio * 0.55) * sample.fade,
        tint: ratio < 0.2 ? (random() < 0.5 ? 0 : 3) : random() < 0.85 ? 3 : 0,
      });
    }
    if (random() < 0.5) {
      const count = random() < 0.3 ? 2 : 1;
      for (let index = 0; index < count; index += 1) {
        const angle = random() * Math.PI * 2;
        const distance = (random() + random() - 1) * spread * 0.7;
        knots.push({
          x: sample.x + Math.cos(angle) * distance,
          y: sample.y + Math.sin(angle) * distance,
          size: 2.5 + random() * 4.5,
          alpha: (0.3 + random() * 0.3) * sample.fade,
          tint: random() < 0.82 ? 3 : 5,
        });
      }
    }
  }
}

// 旋臂内侧（朝向星系核一侧）的暗尘带
function armDustLane(samples: readonly CurveSample[], maximumRadius: number): DustLane {
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < samples.length; index += 2) {
    const sample = samples[index]!;
    const radius = sample.radius * 0.93;
    const theta = sample.theta + 0.055;
    points.push({ x: Math.cos(theta) * radius, y: Math.sin(theta) * radius });
  }
  return { points, width: 6 + maximumRadius * 0.02, alpha: 0.17 };
}

// 稀薄指数盘：真实星系的旋臂浮在盘面上，而不是悬浮在虚空里
function scatterDisk(dust: DustParticle[], count: number, maximumRadius: number, random: () => number): void {
  for (let index = 0; index < count; index += 1) {
    const radius = Math.min(maximumRadius * 1.05, -Math.log(1 - random() * 0.96) * (maximumRadius / 3.2));
    const theta = random() * Math.PI * 2;
    const ratio = radius / maximumRadius;
    dust.push({
      x: Math.cos(theta) * radius,
      y: Math.sin(theta) * radius,
      size: 8 + random() * 14,
      alpha: (0.02 + random() * 0.035) * (1.15 - ratio * 0.6),
      tint: random() < 0.55 ? 3 : 0,
    });
  }
}

// 椭圆星系：完全光滑、无子结构的暖光斑（de Vaucouleurs 式中心聚拢），无尘埃、无结块
function scatterElliptical(dust: DustParticle[], maximumRadius: number, random: () => number): void {
  const flatten = 0.62;
  const positionAngle = -0.42;
  const cosPA = Math.cos(positionAngle);
  const sinPA = Math.sin(positionAngle);
  for (let index = 0; index < 1050; index += 1) {
    const radius = maximumRadius * Math.pow(random(), 2.3);
    const theta = random() * Math.PI * 2;
    const ratio = radius / maximumRadius;
    const ex = Math.cos(theta) * radius;
    const ey = Math.sin(theta) * radius * flatten;
    dust.push({
      x: ex * cosPA - ey * sinPA,
      y: ex * sinPA + ey * cosPA,
      size: 10 + random() * 20 + (1 - ratio) * 14,
      alpha: (0.03 + random() * 0.05) * (1.3 - ratio),
      tint: random() < 0.75 ? 0 : 1,
    });
  }
}

// 球状星团：中心极密、外围可分辨单星的颗粒球，颜色均匀偏暖白
function scatterCluster(dust: DustParticle[], maximumRadius: number, random: () => number): void {
  for (let index = 0; index < 850; index += 1) {
    const radius = maximumRadius * Math.pow(random(), 3);
    const theta = random() * Math.PI * 2;
    const ratio = radius / maximumRadius;
    const fine = random() < 0.85;
    dust.push({
      x: Math.cos(theta) * radius,
      y: Math.sin(theta) * radius,
      size: fine ? 1.2 + random() * 2.8 : 4 + random() * 8,
      alpha: (0.06 + random() * 0.2) * (1.25 - ratio * 0.8),
      tint: random() < 0.78 ? 0 : random() < 0.65 ? 3 : 1,
    });
  }
}

// 棒旋星系的棒：中间厚、两端收细的暖色发光带
function scatterBarDust(
  dust: DustParticle[],
  halfLength: number,
  halfThickness: number,
  random: () => number,
): void {
  const steps = Math.ceil((halfLength * 2) / 4);
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const envelope = Math.sqrt(Math.max(0.1, 1 - (progress * 2 - 1) ** 2));
    const spread = halfThickness * (0.55 + 0.75 * envelope);
    for (let index = 0; index < 4; index += 1) {
      dust.push({
        x: -halfLength + halfLength * 2 * progress + (random() - 0.5) * 6,
        y: (random() + random() + random() - 1.5) * 0.67 * spread * 1.6,
        size: 10 + random() * 18 + envelope * 8,
        alpha: (0.12 + random() * 0.14) * (0.55 + 0.45 * envelope),
        tint: random() < 0.68 ? 1 : 0,
      });
    }
  }
}

function buildGalaxyScene(layout: CreatorStarLayout): GalaxyScene {
  const primary = layout.points.filter((point) => point.component === 0);
  if (primary.length === 0) {
    return { dust: [], knots: [], dustLanes: [], nebulae: [], satellites: [], coreRadius: 60, bar: null };
  }
  const maximumRadius = Math.max(80, ...primary.map((point) => Math.hypot(point.anchorX, point.anchorY)));
  const random = mulberry32(
    Math.imul(primary.length + 11, 2_654_435_761) ^ Math.imul(layout.edges.length + 3, 97_003) ^ layout.mode.length,
  );
  const dust: DustParticle[] = [];
  const knots: DustParticle[] = [];
  const dustLanes: DustLane[] = [];
  let bar: BarGlow | null = null;
  let coreRadius = Math.max(34, Math.min(150, maximumRadius * 0.24));

  if (layout.mode === 'spiral') {
    // 大设计螺旋：指数盘 + 三条对数旋臂（蓝白云团与星形成结块）+ 臂内侧暗尘带
    scatterDisk(dust, 420, maximumRadius, random);
    const armCount = 3;
    const maxStep = Math.max(2, Math.ceil(primary.length / armCount));
    for (let arm = 0; arm < armCount; arm += 1) {
      const samples = spiralArmSamples((arm * Math.PI * 2) / armCount, 36, 57, 0.48, maxStep);
      scatterArmClouds(dust, knots, samples, maximumRadius, random);
      dustLanes.push(armDustLane(samples, maximumRadius));
    }
  } else if (layout.mode === 'barred') {
    // 棒旋：暖色厚棒 + 棒侧暗尘带 + 棒端拖出的两条旋臂
    scatterDisk(dust, 240, maximumRadius, random);
    const barCount = Math.max(2, Math.ceil(primary.length * 0.3));
    const halfLength = Math.max(90, Math.sqrt(primary.length) * 21);
    const halfThickness = 12 + Math.min(16, barCount * 0.6);
    bar = { halfLength, halfThickness };
    scatterBarDust(dust, halfLength, halfThickness, random);
    dustLanes.push({
      points: [
        { x: -halfLength * 0.92, y: -halfThickness * 0.6 },
        { x: 0, y: -halfThickness * 0.78 },
        { x: halfLength * 0.92, y: -halfThickness * 0.6 },
      ],
      width: halfThickness * 0.9,
      alpha: 0.15,
    });
    const maxStep = Math.max(2, Math.ceil((primary.length - barCount) / 2));
    for (const baseAngle of [0, Math.PI]) {
      const samples = spiralArmSamples(baseAngle, halfLength * 0.94, 46, 0.3, maxStep, 0.2);
      scatterArmClouds(dust, knots, samples, maximumRadius, random);
      dustLanes.push(armDustLane(samples, maximumRadius));
    }
  } else if (layout.mode === 'elliptical') {
    // 椭圆星系：无任何子结构的平滑暖光斑
    scatterElliptical(dust, maximumRadius, random);
    coreRadius = Math.max(30, Math.min(120, maximumRadius * 0.2));
  } else {
    // 球状星团：中心极密的颗粒球
    scatterCluster(dust, maximumRadius, random);
    coreRadius = Math.max(22, Math.min(80, maximumRadius * 0.18));
  }

  // 星系核：暖白高密尘埃团
  const coreParticles = layout.mode === 'cluster' ? 170 : 110;
  for (let index = 0; index < coreParticles; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = (random() + random()) * 0.5 * coreRadius;
    dust.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.86,
      size: 8 + random() * 18 * (1 - radius / coreRadius),
      alpha: 0.1 + random() * 0.22,
      tint: random() < 0.72 ? 0 : 1,
    });
  }

  const nebulae: NebulaBlob[] = [];
  for (let index = 0; index < 6; index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = maximumRadius * (0.75 + random() * 0.9);
    nebulae.push({
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      radius: maximumRadius * (0.45 + random() * 0.65),
      alpha: 0.05 + random() * 0.05,
      tint: [6, 2, 4][index % 3] ?? 6,
    });
  }

  const satellites: SatelliteGlow[] = [];
  const componentIds = [...new Set(layout.points.map((point) => point.component))].filter((id) => id !== 0);
  for (const componentId of componentIds) {
    const members = layout.points.filter((point) => point.component === componentId);
    if (members.length === 0) continue;
    const centerX = members.reduce((sum, point) => sum + point.anchorX, 0) / members.length;
    const centerY = members.reduce((sum, point) => sum + point.anchorY, 0) / members.length;
    const spread = Math.max(40, ...members.map((point) => Math.hypot(point.anchorX - centerX, point.anchorY - centerY)));
    satellites.push({
      x: centerX,
      y: centerY,
      radius: spread * 1.15 + 50,
      squash: 0.45 + random() * 0.3,
      rotation: random() * Math.PI,
      tint: componentId % SPRITE_STOPS.length,
    });
  }

  return {
    dust: dust.slice(0, 3000),
    knots: knots.slice(0, 600),
    dustLanes,
    nebulae,
    satellites,
    coreRadius,
    bar,
  };
}

function buildStarField(width: number, height: number): readonly BackgroundStar[] {
  const random = mulberry32(0xc0ffee);
  const count = Math.min(320, Math.round(width * height / 5_200));
  return Array.from({ length: count }, () => ({
    x: random() * width,
    y: random() * height,
    radius: 0.4 + random() * random() * 1.5,
    alpha: 0.25 + random() * 0.65,
    phase: random() * Math.PI * 2,
    speed: 0.4 + random() * 1.4,
    tint: random() < 0.72 ? 0 : random() < 0.6 ? 3 : 1,
  }));
}

function nodeStarTint(point: StarPoint, mode: GalaxyLayoutMode): string {
  if (point.component === 0) {
    // 配色贴近真实星系：棒与核暖黄，旋臂节点蓝白，椭圆暖白，星团乳白
    if (point.arm === -2) return '#ffdba6';
    if (mode === 'spiral' || mode === 'barred') return point.arm >= 0 ? '#d3e2ff' : '#ffe9c4';
    if (mode === 'elliptical') return '#ffe9c8';
    return point.degree > 0 ? '#f4f1e4' : '#dfe6f5';
  }
  return SATELLITE_COLORS[point.component % SATELLITE_COLORS.length] ?? SATELLITE_COLORS[0];
}

function nodeSpriteTint(point: StarPoint, mode: GalaxyLayoutMode): number {
  if (point.component === 0) {
    if (point.arm === -2) return 1;
    if (mode === 'spiral' || mode === 'barred') return point.arm >= 0 ? 3 : 0;
    return 0;
  }
  return (point.component % 5) + 1;
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
  const [galaxyMode, setGalaxyMode] = useState<GalaxyLayoutMode>('spiral');
  const layout = useMemo(() => buildCreatorStarLayout(graph, galaxyMode), [galaxyMode, graph]);
  const scene = useMemo(() => buildGalaxyScene(layout), [layout]);
  const sprites = useMemo(() => createGalaxySprites(), []);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<PointerOperation | null>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [view, setView] = useState<ViewTransform>(() => fitView(layout, 900, 600));
  const [hoveredId, setHoveredId] = useState('');
  const [focusedId, setFocusedId] = useState('');
  const [search, setSearch] = useState('');
  const [layoutVersion, setLayoutVersion] = useState(0);
  const starField = useMemo(() => buildStarField(size.width, size.height), [size.width, size.height]);
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

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const render = (time: number) => {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const twinkle = (phase: number, speed: number) => 0.72 + 0.28 * Math.sin(time * 0.0011 * speed + phase);

      // 深空背景
      const space = context.createRadialGradient(
        size.width / 2, size.height * 0.42, 0,
        size.width / 2, size.height * 0.5, Math.hypot(size.width, size.height) * 0.72,
      );
      space.addColorStop(0, '#0d1024');
      space.addColorStop(0.55, '#080a1a');
      space.addColorStop(1, '#030410');
      context.fillStyle = space;
      context.fillRect(0, 0, size.width, size.height);

      // 远景星野（带视差与闪烁）
      const parallaxX = view.x * 0.06;
      const parallaxY = view.y * 0.06;
      for (const star of starField) {
        const x = ((star.x + parallaxX) % size.width + size.width) % size.width;
        const y = ((star.y + parallaxY) % size.height + size.height) % size.height;
        context.globalAlpha = star.alpha * twinkle(star.phase, star.speed);
        context.beginPath();
        context.arc(x, y, star.radius, 0, Math.PI * 2);
        context.fillStyle = star.tint === 0 ? '#f4f6ff' : star.tint === 3 ? '#bcd0ff' : '#ffe7c2';
        context.fill();
      }
      context.globalAlpha = 1;

      context.save();
      context.translate(view.x, view.y);
      context.scale(view.scale, view.scale);

      // 星云与卫星星系（加色混合发光）
      context.globalCompositeOperation = 'lighter';
      for (const nebula of scene.nebulae) {
        const sprite = sprites[nebula.tint];
        if (!sprite) continue;
        context.globalAlpha = nebula.alpha;
        context.drawImage(sprite, nebula.x - nebula.radius, nebula.y - nebula.radius, nebula.radius * 2, nebula.radius * 2);
      }
      for (const satellite of scene.satellites) {
        const sprite = sprites[satellite.tint];
        if (!sprite) continue;
        context.save();
        context.translate(satellite.x, satellite.y);
        context.rotate(satellite.rotation);
        context.scale(1, satellite.squash);
        context.globalAlpha = 0.16;
        context.drawImage(sprite, -satellite.radius, -satellite.radius, satellite.radius * 2, satellite.radius * 2);
        context.restore();
      }

      // 星系核辉光（多层径向渐变）
      const coreRadius = scene.coreRadius;
      const coreGlow = context.createRadialGradient(0, 0, 0, 0, 0, coreRadius * 2.6);
      coreGlow.addColorStop(0, 'rgba(255,253,244,0.85)');
      coreGlow.addColorStop(0.12, 'rgba(255,238,196,0.5)');
      coreGlow.addColorStop(0.38, 'rgba(244,196,146,0.2)');
      coreGlow.addColorStop(0.72, 'rgba(146,114,222,0.07)');
      coreGlow.addColorStop(1, 'rgba(100,75,155,0)');
      context.globalAlpha = 1;
      context.fillStyle = coreGlow;
      context.beginPath();
      context.arc(0, 0, coreRadius * 2.6, 0, Math.PI * 2);
      context.fill();

      // 棒旋星系：棒体辉光（横向拉伸的暖色椭圆，让棒有体积而不是一根线）
      if (scene.bar) {
        const { halfLength, halfThickness } = scene.bar;
        const glowRadius = halfLength * 1.06;
        context.save();
        context.scale(1, (halfThickness * 2.6) / glowRadius);
        const barGlow = context.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
        barGlow.addColorStop(0, 'rgba(255,226,172,0.4)');
        barGlow.addColorStop(0.5, 'rgba(255,198,130,0.18)');
        barGlow.addColorStop(1, 'rgba(255,172,102,0)');
        context.globalAlpha = 1;
        context.fillStyle = barGlow;
        context.beginPath();
        context.arc(0, 0, glowRadius, 0, Math.PI * 2);
        context.fill();
        context.restore();
      }

      // 旋臂/椭球/星团尘埃
      for (const particle of scene.dust) {
        const sprite = sprites[particle.tint];
        if (!sprite) continue;
        context.globalAlpha = particle.alpha;
        context.drawImage(sprite, particle.x - particle.size, particle.y - particle.size, particle.size * 2, particle.size * 2);
      }
      context.globalAlpha = 1;

      // 暗尘带：压暗旋臂/棒内侧，形成真实星系的吸收轮廓
      context.globalCompositeOperation = 'source-over';
      context.lineCap = 'round';
      context.lineJoin = 'round';
      for (const lane of scene.dustLanes) {
        const chunks = 4;
        for (let chunk = 0; chunk < chunks; chunk += 1) {
          const start = Math.floor((chunk * lane.points.length) / chunks);
          const end = Math.min(lane.points.length - 1, Math.floor(((chunk + 1) * lane.points.length) / chunks));
          const first = lane.points[start];
          if (end <= start || !first) continue;
          const fade = 1 - (chunk / chunks) * 0.6;
          context.beginPath();
          context.moveTo(first.x, first.y);
          for (let index = start + 1; index <= end; index += 1) {
            const point = lane.points[index];
            if (point) context.lineTo(point.x, point.y);
          }
          context.lineWidth = lane.width;
          context.strokeStyle = `rgba(4,5,13,${String(lane.alpha * fade)})`;
          context.stroke();
        }
      }

      // 星形成区亮结块（压在尘带之上，保持亮蓝/粉红）
      context.globalCompositeOperation = 'lighter';
      for (const knot of scene.knots) {
        const sprite = sprites[knot.tint];
        if (!sprite) continue;
        context.globalAlpha = knot.alpha;
        context.drawImage(sprite, knot.x - knot.size, knot.y - knot.size, knot.size * 2, knot.size * 2);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';

      // 关系连线（星座式暗线）
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
        context.strokeStyle = incident
          ? active ? 'rgba(198,208,255,0.66)' : 'rgba(150,162,235,0.11)'
          : 'rgba(150,162,235,0.035)';
        context.lineWidth = (incident && active ? 1.5 : 0.8) / view.scale;
        context.stroke();
      }

      // 恒星节点
      const hubs = [...layout.points].sort((left, right) => right.degree - left.degree).slice(0, 10);
      const labelled = new Set(active
        ? [active.id, ...[...active.neighbors].slice(0, 12)]
        : hubs.filter((point) => point.degree > 0).map((point) => point.id));
      const hubIds = new Set(hubs.filter((point) => point.degree >= 3).map((point) => point.id));
      for (const point of layout.points) {
        const neighbor = active?.neighbors.has(point.id) ?? false;
        const dimmed = Boolean(active) && point.id !== active?.id && !neighbor;
        const isActive = point.id === active?.id;
        const baseRadius = 2.3 + Math.log2(point.degree + 1) * 1.6 + (isActive ? 2 : 0);
        const radius = Math.max(baseRadius, 1.7 / view.scale);
        const tint = nodeStarTint(point, layout.mode);
        const pulse = 0.88 + 0.12 * Math.sin(time * 0.0012 + deterministicUnit(point.id) * Math.PI * 2);
        const glowRadius = radius * (5.2 + Math.min(4, point.degree * 0.5)) * (isActive ? 1.35 : 1);

        context.globalCompositeOperation = 'lighter';
        const sprite = sprites[nodeSpriteTint(point, layout.mode)];
        if (sprite && !dimmed) {
          context.globalAlpha = (point.degree === 0 ? 0.34 : 0.62) * pulse * (isActive ? 1.25 : 1);
          context.drawImage(sprite, point.x - glowRadius, point.y - glowRadius, glowRadius * 2, glowRadius * 2);
        }
        context.globalCompositeOperation = 'source-over';

        context.globalAlpha = dimmed ? 0.13 : point.degree === 0 ? 0.55 : 1;
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fillStyle = tint;
        context.fill();
        context.beginPath();
        context.arc(point.x, point.y, radius * 0.55, 0, Math.PI * 2);
        context.fillStyle = '#ffffff';
        context.globalAlpha = dimmed ? 0.13 : 0.85;
        context.fill();

        // 亮星衍射芒
        if (!dimmed && (hubIds.has(point.id) || isActive)) {
          context.globalCompositeOperation = 'lighter';
          context.globalAlpha = 0.4 * pulse;
          const spike = radius * 6.5;
          context.lineWidth = 0.8 / view.scale;
          context.strokeStyle = tint;
          context.beginPath();
          context.moveTo(point.x - spike, point.y);
          context.lineTo(point.x + spike, point.y);
          context.moveTo(point.x, point.y - spike);
          context.lineTo(point.x, point.y + spike);
          context.stroke();
          context.globalCompositeOperation = 'source-over';
        }

        if (isActive) {
          context.globalAlpha = 0.75;
          context.beginPath();
          context.arc(point.x, point.y, radius + 6 / view.scale, 0, Math.PI * 2);
          context.strokeStyle = 'rgba(238,240,255,0.8)';
          context.lineWidth = 1 / view.scale;
          context.stroke();
        }

        if (labelled.has(point.id) && !dimmed) {
          context.globalAlpha = 0.94;
          context.font = `${String(11 / view.scale)}px Inter, "Microsoft YaHei", sans-serif`;
          context.fillStyle = '#e9ecfc';
          context.shadowColor = 'rgba(3,4,14,0.95)';
          context.shadowBlur = 4 / view.scale;
          context.fillText(shortTitle(point.title), point.x + radius + 5 / view.scale, point.y + 4 / view.scale);
          context.shadowBlur = 0;
        }
      }
      context.globalAlpha = 1;
      context.restore();

      // 暗角
      const vignette = context.createRadialGradient(
        size.width / 2, size.height / 2, Math.min(size.width, size.height) * 0.42,
        size.width / 2, size.height / 2, Math.hypot(size.width, size.height) * 0.68,
      );
      vignette.addColorStop(0, 'rgba(2,3,10,0)');
      vignette.addColorStop(1, 'rgba(2,3,10,0.42)');
      context.fillStyle = vignette;
      context.fillRect(0, 0, size.width, size.height);
    };

    if (reducedMotion) {
      render(0);
      return;
    }
    let frame = requestAnimationFrame(function loop(time) {
      render(time);
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedId, hoveredId, layout, layoutVersion, scene, size, sprites, starField, view]);

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
          </> : <p>节点亮度代表连接数。选择一个节点，展开它的局部标题网络。</p>}
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
          <label>
            <select
              aria-label="星系排列方式"
              onChange={(event) => setGalaxyMode(event.target.value as GalaxyLayoutMode)}
              value={galaxyMode}
            >
              {(Object.entries(GALAXY_LABELS) as [GalaxyLayoutMode, string][]).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <button aria-label="缩小星图" onClick={() => zoomAtCenter(0.8)} type="button">−</button>
          <span>{Math.round(view.scale * 100)}%</span>
          <button aria-label="放大星图" onClick={() => zoomAtCenter(1.25)} type="button">＋</button>
          <button aria-label="让全部节点适合画布" onClick={() => setView(fitView(layout, size.width, size.height))} type="button">适配</button>
        </div>
      </div>
      <footer className="creator-title-graph-footer">
        <span>{GALAXY_LABELS[galaxyMode]} · 拖拽平移 · 拖动节点 · 滚轮缩放 · 双击打开</span>
        <span>{graph.path}</span>
      </footer>
    </section>
  );
}
