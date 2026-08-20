import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { validateAIEndpoint } from '@oldfolio/ai';

export type LocalAIProviderId = 'ollama' | 'openai-compatible';

export interface AIDeviceConfig {
  readonly version: 1;
  readonly providerId: LocalAIProviderId;
  readonly endpoint: string;
  readonly model: string;
  readonly contextWindow?: number;
}

export const DEFAULT_LOCAL_AI_CONTEXT_WINDOW = 8_192;

const DEFAULT_CONFIG: AIDeviceConfig = {
  version: 1,
  providerId: 'ollama',
  endpoint: 'http://127.0.0.1:11434/api/',
  model: '',
  contextWindow: DEFAULT_LOCAL_AI_CONTEXT_WINDOW,
};

export function normalizeAIContextWindow(value: unknown, fallback: number): number {
  const contextWindow = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) < 8_192 || (contextWindow as number) > 10_000_000) {
    throw new Error('模型上下文窗口必须是 8,192 到 10,000,000 之间的整数 Token 数。');
  }
  return contextWindow as number;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

export function normalizeLocalAIEndpoint(providerId: LocalAIProviderId, value: string): string {
  if (!value.trim() || value.length > 2_048 || value.includes('\0')) throw new Error('本地 AI 地址无效。');
  let candidate: URL;
  try {
    candidate = new URL(value.trim());
  } catch {
    throw new Error('本地 AI 地址无效。');
  }
  if (!isLoopback(candidate.hostname)) throw new Error('当前版本只允许连接本机 AI 服务。');
  const url = validateAIEndpoint(value.trim(), { allowLocalhostHttp: true });
  if (url.search) throw new Error('本地 AI 地址不能包含查询参数。');
  if (providerId === 'openai-compatible' && /^\/v1\/?$/u.test(url.pathname)) url.pathname = '/api/v1/';
  if (url.pathname === '/') url.pathname = providerId === 'ollama' ? '/api/' : '/api/v1/';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.href;
}

export function normalizeLocalOllamaEndpoint(value: string): string {
  return normalizeLocalAIEndpoint('ollama', value);
}

function parseConfig(source: string): AIDeviceConfig {
  const value = JSON.parse(source) as Partial<AIDeviceConfig>;
  if (
    value.version !== 1 ||
    (value.providerId !== 'ollama' && value.providerId !== 'openai-compatible')
  ) throw new Error('AI 设备配置无效。');
  if (typeof value.endpoint !== 'string' || typeof value.model !== 'string' || value.model.length > 256 || value.model.includes('\0')) {
    throw new Error('AI 设备配置无效。');
  }
  return {
    version: 1,
    providerId: value.providerId,
    endpoint: normalizeLocalAIEndpoint(value.providerId, value.endpoint),
    model: value.model.trim(),
    contextWindow: normalizeAIContextWindow(value.contextWindow, DEFAULT_LOCAL_AI_CONTEXT_WINDOW),
  };
}

export class AIDeviceConfigStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<AIDeviceConfig> {
    try {
      return parseConfig(await readFile(this.filePath, 'utf8'));
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return DEFAULT_CONFIG;
      throw error;
    }
  }

  async save(config: AIDeviceConfig): Promise<AIDeviceConfig> {
    const validated = parseConfig(JSON.stringify(config));
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    await rename(temporary, this.filePath);
    return validated;
  }
}
