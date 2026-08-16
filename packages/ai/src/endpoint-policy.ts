export interface EndpointPolicy {
  readonly allowLocalhostHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly requireHostConfirmation?: boolean;
  readonly confirmedHosts?: readonly string[];
}

export class EndpointPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointPolicyError';
  }
}

const isLocalhost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
};

const isPrivateIpv4 = (hostname: string): boolean => {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  if (first === undefined || second === undefined) return false;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
};

const isPrivateHost = (hostname: string): boolean =>
  isPrivateIpv4(hostname) || hostname.toLowerCase().endsWith('.local');

/** Validates a user-configurable model endpoint before any network request. */
export function validateAIEndpoint(endpoint: string | URL, policy: EndpointPolicy = {}): URL {
  let url: URL;
  try {
    url = endpoint instanceof URL ? new URL(endpoint) : new URL(endpoint);
  } catch {
    throw new EndpointPolicyError('The AI endpoint is not a valid absolute URL.');
  }

  if (url.username || url.password) {
    throw new EndpointPolicyError('Credentials must not be embedded in an AI endpoint URL.');
  }
  if (url.hash) {
    throw new EndpointPolicyError('AI endpoint URLs cannot contain fragments.');
  }

  const local = isLocalhost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && policy.allowLocalhostHttp)) {
    throw new EndpointPolicyError('AI endpoints must use HTTPS; HTTP is allowed only for explicitly enabled localhost services.');
  }
  if (isPrivateHost(url.hostname) && !local && !policy.allowPrivateNetwork) {
    throw new EndpointPolicyError('Private-network AI endpoints require explicit opt-in.');
  }

  const requireConfirmation = policy.requireHostConfirmation ?? true;
  const confirmed = new Set((policy.confirmedHosts ?? []).map((host) => host.toLowerCase()));
  if (requireConfirmation && !local && !confirmed.has(url.hostname.toLowerCase())) {
    throw new EndpointPolicyError(`The endpoint host "${url.hostname}" has not been explicitly confirmed.`);
  }
  return url;
}

export function resolveEndpoint(base: URL, suffix: string): URL {
  const normalizedBase = base.href.endsWith('/') ? base : new URL(`${base.href}/`);
  return new URL(suffix.replace(/^\//, ''), normalizedBase);
}
