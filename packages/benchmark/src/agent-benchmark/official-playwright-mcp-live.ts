import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
  playwrightMcpChromiumExecutablePath,
  resolvePlaywrightMcpRuntimePackageInputs,
} from './playwright-mcp-runtime-boundary.js';

const playwrightMcpDirectory = resolvePlaywrightMcpRuntimePackageInputs().find(
  ({ name }) => name === '@playwright/mcp',
)!.packageDirectory;

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const waitForPidExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (pidIsAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !pidIsAlive(pid);
};

const observePidExit = async (pid: number): Promise<void> => {
  // StdioClientTransport owns the ChildProcess handle and performs its bounded
  // stdin -> TERM -> KILL sequence. Do not signal a bare PID after that handle
  // has reaped because the operating system may already have reused the PID.
  if (!await waitForPidExit(pid, 2_000)) {
    throw new Error(`Official MCP process ${pid} has no observed exit after transport close.`);
  }
};

const combinedFailure = (
  label: string,
  primary: unknown,
  cleanupErrors: readonly unknown[],
): unknown => cleanupErrors.length === 0
  ? primary
  : new AggregateError([primary, ...cleanupErrors], label);

export interface OfficialBrowserIrMcpHandle {
  readonly client: Client;
  readonly pid: number;
  close(): Promise<void>;
}

/** Start one isolated official Playwright MCP process for an exact fixture origin. */
export const startOfficialBrowserIrMcp = async (input: {
  origin: string;
  headless: boolean;
}): Promise<OfficialBrowserIrMcpHandle> => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'browserir-preflight-mcp-'));
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  let observedPid: number | undefined;
  try {
    const configPath = join(outputDirectory, 'playwright-mcp.config.json');
    await writeFile(configPath, `${JSON.stringify({
      browser: {
        contextOptions: {
          viewport: { width: 1_440, height: 900 },
          deviceScaleFactor: 1,
          locale: 'en-US',
          timezoneId: 'UTC',
          colorScheme: 'light',
          reducedMotion: 'reduce',
          acceptDownloads: false,
          serviceWorkers: 'block',
        },
      },
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(playwrightMcpDirectory, 'cli.js'),
        '--config', configPath,
        '--browser', 'chromium',
        '--executable-path', playwrightMcpChromiumExecutablePath(),
        '--isolated',
        '--codegen', 'none',
        '--image-responses', 'omit',
        '--snapshot-mode', 'full',
        '--viewport-size', '1440x900',
        '--allowed-origins', input.origin,
        '--console-level', 'error',
        '--output-dir', outputDirectory,
        '--output-mode', 'stdout',
        ...(input.headless ? ['--headless'] : []),
      ],
      cwd: outputDirectory,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    client = new Client({
      name: 'browserir-live-preflight',
      version: '1.0.0',
    });
    await client.connect(transport);
    observedPid = transport.pid ?? undefined;
    if (
      observedPid === undefined || !Number.isSafeInteger(observedPid) || observedPid <= 0
    ) throw new Error('Official MCP transport exposed no positive child PID.');
    let closePromise: Promise<void> | undefined;
    return {
      client,
      pid: observedPid,
      close() {
        closePromise ??= (async () => {
          const cleanupErrors: unknown[] = [];
          await client!.close().catch((error) => cleanupErrors.push(error));
          await transport!.close().catch((error) => cleanupErrors.push(error));
          await observePidExit(observedPid!)
            .catch((error) => cleanupErrors.push(error));
          await rm(outputDirectory, { recursive: true, force: true })
            .catch((error) => cleanupErrors.push(error));
          if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, 'Official MCP cleanup failed.');
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await client?.close().catch((cleanupError) => cleanupErrors.push(cleanupError));
    observedPid ??= transport?.pid ?? undefined;
    await transport?.close().catch((cleanupError) => cleanupErrors.push(cleanupError));
    if (observedPid !== undefined) {
      await observePidExit(observedPid)
        .catch((cleanupError) => cleanupErrors.push(cleanupError));
    }
    await rm(outputDirectory, { recursive: true, force: true })
      .catch((cleanupError) => cleanupErrors.push(cleanupError));
    throw combinedFailure('Official MCP startup and teardown failed.', error, cleanupErrors);
  }
};
