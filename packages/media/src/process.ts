import { spawn } from 'node:child_process';

export interface ControlledProcessRequest {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ControlledProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ControlledProcessError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_request' | 'spawn_failed' | 'timeout' | 'cancelled' | 'output_limit' | 'nonzero_exit',
    readonly result?: ControlledProcessResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ControlledProcessError';
  }
}

function validateRequest(request: ControlledProcessRequest): void {
  if (!request.executablePath.trim() || request.executablePath.includes('\0')) {
    throw new ControlledProcessError('Executable path is invalid.', 'invalid_request');
  }
  if (request.args.some((argument) => argument.includes('\0'))) {
    throw new ControlledProcessError('Process arguments may not contain NUL bytes.', 'invalid_request');
  }
  if ((request.timeoutMs ?? 1) <= 0 || (request.maxOutputBytes ?? 1) <= 0) {
    throw new ControlledProcessError('Process limits must be positive.', 'invalid_request');
  }
}

/** Executes a known binary directly. Shell interpretation is intentionally unavailable. */
export async function runControlledProcess(request: ControlledProcessRequest): Promise<ControlledProcessResult> {
  validateRequest(request);
  const maxOutputBytes = request.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const child = spawn(request.executablePath, [...request.args], {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill();
      finishError(new ControlledProcessError('Process timed out.', 'timeout'));
    }, request.timeoutMs ?? 2 * 60 * 60 * 1_000);
    const finishError = (error: ControlledProcessError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      reject(error);
    };
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finishError(new ControlledProcessError('Process output exceeded its limit.', 'output_limit'));
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', (error) => finishError(new ControlledProcessError('Could not start process.', 'spawn_failed', undefined, { cause: error })));
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      const result = { exitCode: code ?? -1, stdout, stderr };
      if (code !== 0) reject(new ControlledProcessError(`Process exited with code ${String(code)}.`, 'nonzero_exit', result));
      else resolve(result);
    });
    const abort = () => {
      child.kill();
      finishError(new ControlledProcessError('Process was cancelled.', 'cancelled'));
    };
    if (request.signal?.aborted === true) abort();
    else request.signal?.addEventListener('abort', abort, { once: true });
  });
}
