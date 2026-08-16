import type { OkfConceptFrontmatter } from '@oldfolio/domain';
import { stringify } from 'yaml';

import { okfConceptFrontmatterSchema } from './schemas.js';

export interface NewOkfConcept {
  readonly frontmatter: OkfConceptFrontmatter;
  /** Written verbatim after the closing frontmatter delimiter. */
  readonly body: string;
}

export interface SerializeOkfConceptOptions {
  readonly lineEnding?: '\n' | '\r\n';
}

export class OkfSerializationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Cannot serialize invalid OKF concept: ${issues.join('; ')}`);
    this.name = 'OkfSerializationError';
    this.issues = issues;
  }
}

/** Serialize a newly-created concept. Parsed documents deliberately have no rewrite API. */
export function serializeNewOkfConcept(
  concept: NewOkfConcept,
  options: SerializeOkfConceptOptions = {},
): string {
  const validated = okfConceptFrontmatterSchema.safeParse(concept.frontmatter);
  if (!validated.success) {
    throw new OkfSerializationError(validated.error.issues.map((issue) => issue.message));
  }

  const lineEnding = options.lineEnding ?? '\n';
  const yaml = stringify(validated.data, { lineWidth: 0 }).trimEnd().replaceAll('\n', lineEnding);
  return `---${lineEnding}${yaml}${lineEnding}---${lineEnding}${concept.body}`;
}

