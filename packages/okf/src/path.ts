export type OkfReservedKind = 'index' | 'log';

export interface BundlePathIssue {
  readonly code:
    | 'empty_path'
    | 'absolute_path'
    | 'backslash'
    | 'empty_segment'
    | 'traversal_segment'
    | 'nul_byte';
  readonly message: string;
}

export interface BundlePathValidation {
  readonly valid: boolean;
  readonly path: string;
  readonly issues: readonly BundlePathIssue[];
}

/** Validate a bundle-relative path without normalizing it or touching the filesystem. */
export function validateBundlePath(path: string): BundlePathValidation {
  const issues: BundlePathIssue[] = [];

  if (path.length === 0) {
    issues.push({ code: 'empty_path', message: 'Bundle path must not be empty' });
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    issues.push({ code: 'absolute_path', message: 'Bundle path must be relative to the bundle root' });
  }
  if (path.includes('\\')) {
    issues.push({ code: 'backslash', message: 'Bundle paths must use `/` separators' });
  }
  if (path.includes('\0')) {
    issues.push({ code: 'nul_byte', message: 'Bundle path must not contain a NUL byte' });
  }

  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    issues.push({ code: 'empty_segment', message: 'Bundle path must not contain empty segments' });
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    issues.push({ code: 'traversal_segment', message: 'Bundle path must not contain `.` or `..` segments' });
  }
  return { valid: issues.length === 0, path, issues };
}

/** An OKF document is a safe bundle-relative path with a `.md` suffix. */
export function isOkfDocumentPath(path: string): boolean {
  return validateBundlePath(path).valid && path.endsWith('.md');
}

export function getReservedKind(path: string): OkfReservedKind | null {
  const filename = path.split('/').at(-1);
  if (filename === 'index.md') return 'index';
  if (filename === 'log.md') return 'log';
  return null;
}

export function isRootIndexPath(path: string): boolean {
  return path === 'index.md';
}
