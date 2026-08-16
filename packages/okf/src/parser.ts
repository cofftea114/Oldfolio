import {
  OKF_VERSION,
  type OkfConceptFrontmatter,
  type OkfIndexFrontmatter,
} from '@oldfolio/domain';
import { parseDocument } from 'yaml';
import type { ZodError } from 'zod';

import {
  getReservedKind,
  isOkfDocumentPath,
  isRootIndexPath,
  validateBundlePath,
  type OkfReservedKind,
} from './path.js';
import { okfConceptFrontmatterSchema, okfIndexFrontmatterSchema } from './schemas.js';

export type OkfValidationSeverity = 'error' | 'warning';

export type OkfValidationCode =
  | 'invalid_bundle_path'
  | 'missing_frontmatter'
  | 'invalid_yaml'
  | 'invalid_frontmatter'
  | 'missing_type'
  | 'invalid_type'
  | 'reserved_frontmatter'
  | 'unsupported_okf_version'
  | 'invalid_log_heading';

export interface OkfValidationIssue {
  readonly code: OkfValidationCode;
  readonly severity: OkfValidationSeverity;
  readonly message: string;
  readonly path: readonly (string | number)[];
}

interface ParsedBase {
  readonly path: string;
  /** The complete input, byte-for-byte at the JavaScript string level. */
  readonly source: string;
  /** Everything after the closing delimiter. It is never normalized. */
  readonly body: string;
  /** YAML text between delimiters. It is never regenerated. */
  readonly frontmatterSource: string | null;
  /** Parsed YAML before canonical OKF normalization, including unknown fields. */
  readonly rawFrontmatter: Readonly<Record<string, unknown>> | null;
  readonly issues: readonly OkfValidationIssue[];
  readonly valid: boolean;
}

export interface ParsedOkfConcept extends ParsedBase {
  readonly kind: 'concept';
  /** Validated canonical metadata; bare `verified` mappings are normalized to arrays. */
  readonly frontmatter: OkfConceptFrontmatter | null;
}

export interface ParsedOkfReservedDocument extends ParsedBase {
  readonly kind: OkfReservedKind;
  readonly frontmatter: OkfIndexFrontmatter | null;
}

export type ParsedOkfDocument = ParsedOkfConcept | ParsedOkfReservedDocument;

interface FrontmatterSlice {
  readonly source: string;
  readonly body: string;
}

export function parseOkfDocument(source: string, path: string): ParsedOkfDocument {
  const reservedKind = getReservedKind(path);
  const pathValidation = validateBundlePath(path);
  const issues: OkfValidationIssue[] = pathValidation.issues.map((issue) => ({
    code: 'invalid_bundle_path',
    severity: 'error',
    message: issue.message,
    path: [],
  }));
  if (pathValidation.valid && !isOkfDocumentPath(path)) {
    issues.push({
      code: 'invalid_bundle_path',
      severity: 'error',
      message: 'OKF document paths must end in `.md`',
      path: [],
    });
  }
  const slice = extractFrontmatter(source);
  const parsedYaml = slice === null ? null : parseYamlMapping(slice.source, issues);

  if (reservedKind !== null) {
    const frontmatter = validateReservedFrontmatter(reservedKind, path, slice, parsedYaml, issues);
    validateReservedBody(reservedKind, slice?.body ?? source, issues);
    return {
      kind: reservedKind,
      path,
      source,
      body: slice?.body ?? source,
      frontmatterSource: slice?.source ?? null,
      rawFrontmatter: parsedYaml,
      frontmatter,
      issues,
      valid: !issues.some((issue) => issue.severity === 'error'),
    };
  }

  if (slice === null) {
    issues.push({
      code: 'missing_frontmatter',
      severity: 'error',
      message: 'Concept documents require a YAML frontmatter block',
      path: [],
    });
  }

  const validated = parsedYaml === null ? null : okfConceptFrontmatterSchema.safeParse(parsedYaml);
  if (validated !== null && !validated.success) addZodIssues(validated.error, issues);

  return {
    kind: 'concept',
    path,
    source,
    body: slice?.body ?? source,
    frontmatterSource: slice?.source ?? null,
    rawFrontmatter: parsedYaml,
    frontmatter: validated?.success === true ? validated.data : null,
    issues,
    valid: !issues.some((issue) => issue.severity === 'error'),
  };
}

export function validateOkfDocument(source: string, path: string): readonly OkfValidationIssue[] {
  return parseOkfDocument(source, path).issues;
}

function extractFrontmatter(source: string): FrontmatterSlice | null {
  const bomLength = source.startsWith('\uFEFF') ? 1 : 0;
  const openingEnd = lineEndAfter(source, bomLength);
  if (source.slice(bomLength, openingEnd.contentEnd) !== '---') return null;

  let cursor = openingEnd.nextStart;
  while (cursor <= source.length) {
    const lineEnd = lineEndAfter(source, cursor);
    if (source.slice(cursor, lineEnd.contentEnd) === '---') {
      return {
        source: source.slice(openingEnd.nextStart, cursor),
        body: source.slice(lineEnd.nextStart),
      };
    }
    if (lineEnd.nextStart === cursor || lineEnd.nextStart > source.length) break;
    cursor = lineEnd.nextStart;
  }
  return null;
}

function lineEndAfter(source: string, start: number): { contentEnd: number; nextStart: number } {
  const lf = source.indexOf('\n', start);
  if (lf === -1) return { contentEnd: source.length, nextStart: source.length };
  const contentEnd = lf > start && source[lf - 1] === '\r' ? lf - 1 : lf;
  return { contentEnd, nextStart: lf + 1 };
}

function parseYamlMapping(
  frontmatterSource: string,
  issues: OkfValidationIssue[],
): Readonly<Record<string, unknown>> | null {
  const document = parseDocument(frontmatterSource, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      issues.push({ code: 'invalid_yaml', severity: 'error', message: error.message, path: [] });
    }
    return null;
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error: unknown) {
    issues.push({
      code: 'invalid_yaml',
      severity: 'error',
      message: error instanceof Error ? error.message : 'Could not materialize YAML frontmatter',
      path: [],
    });
    return null;
  }
  if (!isRecord(value)) {
    issues.push({
      code: 'invalid_frontmatter',
      severity: 'error',
      message: 'Frontmatter must be a YAML mapping',
      path: [],
    });
    return null;
  }
  return value;
}

function validateReservedFrontmatter(
  kind: OkfReservedKind,
  path: string,
  slice: FrontmatterSlice | null,
  parsedYaml: Readonly<Record<string, unknown>> | null,
  issues: OkfValidationIssue[],
): OkfIndexFrontmatter | null {
  if (slice === null) return null;
  if (kind !== 'index' || !isRootIndexPath(path)) {
    issues.push({
      code: 'reserved_frontmatter',
      severity: 'error',
      message: 'Only a bundle-root `index.md` may contain frontmatter',
      path: [],
    });
    return null;
  }
  if (parsedYaml === null) return null;

  const validated = okfIndexFrontmatterSchema.safeParse(parsedYaml);
  if (!validated.success) {
    addZodIssues(validated.error, issues);
    return null;
  }
  if (validated.data.okf_version !== OKF_VERSION) {
    issues.push({
      code: 'unsupported_okf_version',
      severity: 'warning',
      message: `Bundle declares OKF ${validated.data.okf_version}; this consumer targets ${OKF_VERSION}`,
      path: ['okf_version'],
    });
  }
  return validated.data;
}

function validateReservedBody(
  kind: OkfReservedKind,
  body: string,
  issues: OkfValidationIssue[],
): void {
  if (kind !== 'log') return;
  const headings = body.matchAll(/^##\s+(.+)\s*$/gm);
  for (const heading of headings) {
    const label = heading[1]?.trim() ?? '';
    if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(label)) {
      issues.push({
        code: 'invalid_log_heading',
        severity: 'error',
        message: 'Level-two log headings must be ISO dates (YYYY-MM-DD)',
        path: [],
      });
    }
  }
}

function addZodIssues(error: ZodError, issues: OkfValidationIssue[]): void {
  for (const issue of error.issues) {
    const isTypeIssue = issue.path[0] === 'type';
    const code = isTypeIssue
      ? issue.code === 'invalid_type'
        ? 'missing_type'
        : 'invalid_type'
      : 'invalid_frontmatter';
    issues.push({
      code,
      severity: 'error',
      message: issue.message,
      path: issue.path.map((segment) => (typeof segment === 'symbol' ? segment.description ?? '' : segment)),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
