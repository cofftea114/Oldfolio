import type {
  OperationContext,
  SourceAccessMethod,
  SourceConnector,
  SourceFetchRequest,
  SourceInput,
  SourceInvocationContext,
  SourceProbeResult,
  SourceSnapshot,
} from '@oldfolio/domain';

export type {
  SourceAccessMethod,
  SourceAuthorization,
  SourceCapability,
  SourceCapabilityState,
  SourceConnector,
  SourceDeletionPolicy,
  SourceFetchRequest,
  SourceInput,
  SourceInvocationContext,
  SourceProbeResult,
  SourceRetentionPolicy,
  SourceSnapshot,
} from '@oldfolio/domain';

const ACCESS_METHODS = new Set<SourceAccessMethod>([
  'local_file',
  'direct_url',
  'open_feed',
  'official_api',
  'user_import',
]);

function validateConnector(connector: SourceConnector): void {
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(connector.id)) {
    throw new Error(`Invalid source connector id: ${connector.id}`);
  }
  if (!connector.displayName.trim()) throw new Error('Source connector displayName is required.');
  if (connector.accessMethods.length === 0) {
    throw new Error(`Source connector "${connector.id}" must declare at least one legal access method.`);
  }
  for (const method of connector.accessMethods) {
    if (!ACCESS_METHODS.has(method)) {
      throw new Error(`Source connector "${connector.id}" contains an unsupported access method.`);
    }
  }
  const interval = connector.retentionPolicy.defaultRefreshIntervalMs;
  if (interval !== undefined && interval <= 0) {
    throw new Error('defaultRefreshIntervalMs must be positive when provided.');
  }
}

export class SourceConnectorRegistry {
  readonly #connectors = new Map<string, SourceConnector>();

  register(connector: SourceConnector): () => void {
    validateConnector(connector);
    if (this.#connectors.has(connector.id)) {
      throw new Error(`Source connector "${connector.id}" is already registered.`);
    }
    this.#connectors.set(connector.id, connector);
    return () => this.#connectors.delete(connector.id);
  }

  get(id: string): SourceConnector | undefined {
    return this.#connectors.get(id);
  }

  list(): readonly SourceConnector[] {
    return [...this.#connectors.values()];
  }

  async probe(
    input: SourceInput,
    context?: OperationContext,
  ): Promise<readonly { readonly connectorId: string; readonly result: SourceProbeResult }[]> {
    const results = await Promise.all(
      [...this.#connectors.values()].map(async (connector) => ({
        connectorId: connector.id,
        result: await connector.probe(input, context),
      })),
    );
    return results.filter(({ result }) => result.matched);
  }

  async fetch(
    connectorId: string,
    request: SourceFetchRequest,
    context?: SourceInvocationContext,
  ): Promise<SourceSnapshot> {
    const connector = this.#connectors.get(connectorId);
    if (!connector) throw new Error(`Unknown source connector: ${connectorId}`);
    return connector.fetch(request, context);
  }
}
