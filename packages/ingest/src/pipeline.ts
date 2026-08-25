import type {
  OperationContext,
  SourceConnector,
  SourceFetchRequest,
  SourceInput,
  SourceInvocationContext,
  SourceProbeResult,
  SourceSnapshot,
} from '@oldfolio/domain';

import { compileSourceDocument, type CompiledSourceDocument } from './source-document.js';

export interface IngestionResult {
  readonly snapshot: SourceSnapshot;
  readonly document: CompiledSourceDocument;
}

/** Small orchestration boundary; persistence and approval remain Vault responsibilities. */
export class IngestionPipeline {
  readonly #connectors = new Map<string, SourceConnector>();

  constructor(connectors: readonly SourceConnector[]) {
    for (const connector of connectors) {
      if (this.#connectors.has(connector.id)) throw new Error(`Duplicate connector id: ${connector.id}`);
      this.#connectors.set(connector.id, connector);
    }
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

  async ingest(
    connectorId: string,
    request: SourceFetchRequest,
    context?: SourceInvocationContext,
  ): Promise<IngestionResult> {
    const connector = this.#connectors.get(connectorId);
    if (!connector) throw new Error(`Unknown source connector: ${connectorId}`);
    const snapshot = await connector.fetch(request, context);
    return { snapshot, document: compileSourceDocument(snapshot) };
  }
}
