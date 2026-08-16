import type { OkfConceptFrontmatter, OkfStatus, OkfTrustTier } from '@oldfolio/domain';

export function deriveTrustTier(frontmatter: OkfConceptFrontmatter): OkfTrustTier {
  if (frontmatter.verified === undefined || frontmatter.verified.length === 0) return 'unverified';
  return frontmatter.verified.some((verification) => verification.by.startsWith('human:'))
    ? 'human-reviewed'
    : 'machine-confirmed';
}

export function getEffectiveStatus(frontmatter: OkfConceptFrontmatter): OkfStatus {
  return frontmatter.status ?? 'stable';
}

export function isStale(frontmatter: OkfConceptFrontmatter, today: string): boolean {
  return frontmatter.stale_after !== undefined && today >= frontmatter.stale_after;
}

