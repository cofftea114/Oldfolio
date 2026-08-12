export type WikiRiskLevel = 'L1' | 'L2' | 'L3';

export interface WikiCitation {
  readonly sourceId: string;
  readonly locator: string;
  readonly quoteHash?: string;
}

interface BaseOperation {
  readonly path: string;
}

export type WikiFileOperation =
  | (BaseOperation & { readonly kind: 'create'; readonly content: string })
  | (BaseOperation & { readonly kind: 'update'; readonly beforeHash: string; readonly content: string })
  | (BaseOperation & { readonly kind: 'delete'; readonly beforeHash: string })
  | (BaseOperation & { readonly kind: 'rename'; readonly beforeHash: string; readonly toPath: string });

export interface WikiChangeSet {
  readonly id: string;
  readonly baseRevision: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: string;
  readonly riskLevel: WikiRiskLevel;
  readonly operations: readonly WikiFileOperation[];
  readonly citations: readonly WikiCitation[];
}

export interface CreateWikiChangeSetInput extends Omit<WikiChangeSet, 'id' | 'createdAt'> {
  readonly createdAt?: string;
}

const RISK_ORDER: Readonly<Record<WikiRiskLevel, number>> = { L1: 1, L2: 2, L3: 3 };

const validateRelativePath = (path: string): void => {
  const normalized = path.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Unsafe WikiChangeSet path: ${path}`);
  }
};

export function inferOperationRisk(operation: WikiFileOperation): WikiRiskLevel {
  const path = operation.path.replaceAll('\\', '/');
  if (operation.kind === 'delete' || operation.kind === 'rename') return 'L3';
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

/** Creates an immutable change set that cannot be applied to another revision. */
export async function createWikiChangeSet(input: CreateWikiChangeSetInput): Promise<WikiChangeSet> {
  if (!input.baseRevision.trim()) throw new Error('baseRevision is required.');
  if (!input.model.trim() || !input.promptVersion.trim()) throw new Error('Model and prompt version are required.');
  if (input.operations.length === 0) throw new Error('A WikiChangeSet must contain at least one operation.');
  if (Object.keys(input.sourceHashes).length === 0) throw new Error('A WikiChangeSet must bind at least one source hash.');

  for (const operation of input.operations) {
    validateRelativePath(operation.path);
    if (operation.kind === 'rename') validateRelativePath(operation.toPath);
    if (RISK_ORDER[inferOperationRisk(operation)] > RISK_ORDER[input.riskLevel]) {
      throw new Error(`Operation on "${operation.path}" requires a higher risk level.`);
    }
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const payload = {
    ...input,
    createdAt,
    operations: [...input.operations],
    citations: [...input.citations],
    sourceHashes: { ...input.sourceHashes },
  };
  const id = await sha256Hex(JSON.stringify(canonicalize(payload)));
  return Object.freeze({ ...payload, id });
}

export function assertChangeSetRevision(changeSet: WikiChangeSet, currentRevision: string): void {
  if (changeSet.baseRevision !== currentRevision) {
    throw new Error(
      `Stale WikiChangeSet: expected base revision "${changeSet.baseRevision}", received "${currentRevision}".`,
    );
  }
}
