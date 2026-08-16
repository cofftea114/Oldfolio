import type {
  ContentHash,
  DocumentRevision,
  RiskLevel,
  WikiChangeItem,
  WikiChangeSet,
  WikiCitation,
  WikiFileOperation,
  WikiRollback,
} from '@oldfolio/domain';

export type {
  DocumentRevision,
  RiskLevel,
  WikiChangeItem,
  WikiChangeSet,
  WikiCitation,
  WikiFileOperation,
} from '@oldfolio/domain';

export interface CreateWikiChangeSetInput {
  readonly baseRevisions: readonly DocumentRevision[];
  readonly sourceHashes: Readonly<Record<string, ContentHash>>;
  readonly generator: WikiChangeSet['generator'];
  readonly riskLevel: Exclude<RiskLevel, 'L0' | 'L4'>;
  readonly items: readonly WikiChangeItem[];
  readonly citations: readonly WikiCitation[];
  readonly rollback?: WikiRollback;
  readonly createdAt?: string;
}

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

const validateRelativePath = (path: string): void => {
  const normalized = path.replaceAll('\\', '/').normalize('NFC');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.split('/').includes('..') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Unsafe WikiChangeSet path: ${path}`);
  }
};

export function inferOperationRisk(operation: WikiFileOperation): Exclude<RiskLevel, 'L0' | 'L4'> {
  const path = (operation.kind === 'move' ? operation.fromPath : operation.path).replaceAll('\\', '/');
  if (operation.kind === 'delete' || operation.kind === 'move') return 'L3';
  if (path.startsWith('notes/') || path.includes('/raw/')) return operation.kind === 'create' ? 'L1' : 'L3';
  if (path.includes('/wiki/') && operation.kind === 'update') return 'L2';
  return 'L1';
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Creates the shared, immutable change-set contract consumed directly by VaultRepository. */
export async function createWikiChangeSet(input: CreateWikiChangeSetInput): Promise<WikiChangeSet> {
  if (!input.generator.providerId.trim() || !input.generator.model.trim() || !input.generator.promptVersion.trim()) {
    throw new Error('Provider, model, and prompt version are required.');
  }
  if (input.items.length === 0) throw new Error('A WikiChangeSet must contain at least one item.');
  if (Object.keys(input.sourceHashes).length === 0) {
    throw new Error('A WikiChangeSet must bind at least one source hash.');
  }

  const basePaths = new Set(input.baseRevisions.map((revision) => revision.path));
  for (const item of input.items) {
    const operation = item.operation;
    const path = operation.kind === 'move' ? operation.fromPath : operation.path;
    validateRelativePath(path);
    if (operation.kind === 'move') validateRelativePath(operation.toPath);
    const requiredRisk = inferOperationRisk(operation);
    if (RISK_ORDER[item.riskLevel] < RISK_ORDER[requiredRisk]) {
      throw new Error(`Operation on "${path}" requires risk level ${requiredRisk} or higher.`);
    }
    if (RISK_ORDER[input.riskLevel] < RISK_ORDER[item.riskLevel]) {
      throw new Error(`Change item "${item.id}" exceeds the change-set risk level.`);
    }
    if (operation.kind !== 'create' && !basePaths.has(operation.baseRevision.path)) {
      throw new Error(`Operation on "${path}" is missing its bound base revision.`);
    }
    for (const citationId of item.citationIds) {
      if (!input.citations.some((citation) => citation.id === citationId)) {
        throw new Error(`Change item "${item.id}" references unknown citation "${citationId}".`);
      }
    }
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const payload = {
    createdAt,
    baseRevisions: [...input.baseRevisions],
    sourceHashes: { ...input.sourceHashes },
    generator: { ...input.generator },
    riskLevel: input.riskLevel,
    items: [...input.items],
    citations: [...input.citations],
    rollback: input.rollback ?? { operations: [] },
  };
  const id = await sha256Hex(JSON.stringify(canonicalize(payload)));
  return Object.freeze({ ...payload, id });
}

/** Rejects a change set if any bound file revision is no longer current. */
export function assertChangeSetRevisions(
  changeSet: WikiChangeSet,
  currentRevisions: Readonly<Record<string, ContentHash | undefined>>,
): void {
  for (const revision of changeSet.baseRevisions) {
    if (currentRevisions[revision.path] !== revision.contentHash) {
      throw new Error(`Stale WikiChangeSet base revision for "${revision.path}".`);
    }
  }
}
