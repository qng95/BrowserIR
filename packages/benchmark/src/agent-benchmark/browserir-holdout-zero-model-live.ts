import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import type {
  BrowserIrHoldoutZeroModelArmSession,
  BrowserIrHoldoutZeroModelPreflightDependencies,
  BrowserIrHoldoutZeroOracleSnapshot,
} from './browserir-holdout-zero-model-preflight.js';
import {
  startOfficialBrowserIrMcp,
  type OfficialBrowserIrMcpHandle,
} from './official-playwright-mcp-live.js';

const CHILD_PROTOCOL = 'browserir-holdout-zero-model-fixture-child/1' as const;
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureChildSource = fileURLToPath(new URL(
  './browserir-holdout-zero-model-fixture-process.ts',
  import.meta.url,
));
const localRequire = createRequire(import.meta.url);
const viteNodeCli = localRequire.resolve('vite-node/cli');

interface ChildMessage {
  readonly protocol: typeof CHILD_PROTOCOL;
  readonly kind: 'ready' | 'oracle' | 'closed' | 'fatal';
  readonly requestId?: string | undefined;
  readonly origin?: string | undefined;
  readonly pid?: number | undefined;
  readonly databaseInstanceAttestationId?: string | undefined;
  readonly oracle?: BrowserIrHoldoutZeroOracleSnapshot | undefined;
  readonly message?: string | undefined;
}

const childMessage = (value: unknown): value is ChildMessage => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record['protocol'] === CHILD_PROTOCOL &&
    typeof record['kind'] === 'string' &&
    ['ready', 'oracle', 'closed', 'fatal'].includes(record['kind']);
};

const boundedChildLog = (child: ChildProcess): (() => string) => {
  let retained = '';
  const append = (chunk: unknown): void => {
    retained = `${retained}${String(chunk)}`.slice(-8_192);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => retained;
};

const waitForChildMessage = (
  child: ChildProcess,
  predicate: (message: ChildMessage) => boolean,
  readLog: () => string,
  timeoutMs = 30_000,
): Promise<ChildMessage> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(
    new Error(`Fixture child timed out. ${readLog()}`),
  ), timeoutMs);
  const onMessage = (message: unknown): void => {
    if (!childMessage(message)) return;
    if (message.kind === 'fatal') {
      finish(new Error(`Fixture child failed: ${message.message ?? 'unknown failure'}.`));
      return;
    }
    if (predicate(message)) finish(undefined, message);
  };
  const onError = (error: Error): void => finish(error);
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
    finish(new Error(
      `Fixture child exited before its response (code=${String(code)}, signal=${String(signal)}). ` +
      readLog(),
    ));
  const finish = (error?: Error, message?: ChildMessage): void => {
    clearTimeout(timer);
    child.off('message', onMessage);
    child.off('error', onError);
    child.off('exit', onExit);
    if (error !== undefined) reject(error);
    else resolve(message!);
  };
  child.on('message', onMessage);
  child.once('error', onError);
  child.once('exit', onExit);
});

interface FixtureChildHandle {
  readonly origin: string;
  readonly pid: number;
  readonly databaseInstanceAttestationId: string;
  oracle(): Promise<BrowserIrHoldoutZeroOracleSnapshot>;
  close(): Promise<void>;
}

const childHasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const waitForChildExit = (
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> => {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once('exit', onExit);
    if (childHasExited(child)) finish(true);
  });
};

const terminateAndReapChild = async (child: ChildProcess): Promise<void> => {
  if (childHasExited(child)) return;
  try { child.kill('SIGTERM'); } catch { /* Continue to the observed exit check. */ }
  if (await waitForChildExit(child, 2_000)) return;
  try { child.kill('SIGKILL'); } catch { /* The final observed check decides. */ }
  if (!await waitForChildExit(child, 2_000)) {
    throw new Error(`Child process ${String(child.pid)} did not exit after SIGKILL.`);
  }
};

const combinedFailure = (
  label: string,
  primary: unknown,
  cleanupErrors: readonly unknown[],
): unknown => cleanupErrors.length === 0
  ? primary
  : new AggregateError([primary, ...cleanupErrors], label);

const selectProspectiveLoopbackPort = (): Promise<number> => new Promise((resolve, reject) => {
  const reservation = createServer();
  const onError = (error: Error): void => reject(error);
  reservation.once('error', onError);
  reservation.listen(0, '127.0.0.1', () => {
    reservation.off('error', onError);
    const address = reservation.address();
    if (address === null || typeof address === 'string') {
      reservation.close(() => reject(new Error('Prospective fixture port was not IPv4.')));
      return;
    }
    const port = address.port;
    reservation.close((error) => {
      if (error !== undefined) reject(error);
      else resolve(port);
    });
  });
});

const fixtureChildEnvironment = (
  caseId: string,
  worldId: string,
  port: number,
): NodeJS.ProcessEnv => ({
  ...(process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] }),
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  BROWSERIR_HOLDOUT_PREFLIGHT_CASE_ID: caseId,
  BROWSERIR_HOLDOUT_PREFLIGHT_WORLD_ID: worldId,
  BROWSERIR_HOLDOUT_PREFLIGHT_PORT: String(port),
});

const startFixtureChild = async (
  caseId: string,
  worldId: string,
  port: number,
): Promise<FixtureChildHandle> => {
  const child = fork(viteNodeCli, [fixtureChildSource], {
    cwd: workspaceRoot,
    env: fixtureChildEnvironment(caseId, worldId, port),
    execArgv: [],
    silent: true,
  });
  const readLog = boundedChildLog(child);
  let requestOrdinal = 0;
  let closePromise: Promise<void> | undefined;
  try {
    const ready = await waitForChildMessage(
      child,
      (message) => message.kind === 'ready',
      readLog,
    );
    if (
      typeof ready.origin !== 'string' || typeof ready.pid !== 'number' ||
      ready.pid !== child.pid || ready.origin !== `http://127.0.0.1:${port}` ||
      typeof ready.databaseInstanceAttestationId !== 'string' ||
      !/^fixture-db:[0-9a-f-]{36}$/u.test(ready.databaseInstanceAttestationId)
    ) throw new Error('Fixture child returned an invalid runtime identity.');
    const request = async (
      kind: 'oracle' | 'close',
      timeoutMs = 30_000,
    ): Promise<ChildMessage> => {
      if (!child.connected) throw new Error('Fixture child IPC channel is closed.');
      const requestId = `fixture-request-${++requestOrdinal}`;
      const response = waitForChildMessage(
        child,
        (message) => message.requestId === requestId &&
          message.kind === (kind === 'oracle' ? 'oracle' : 'closed'),
        readLog,
        timeoutMs,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          child.send({ kind, requestId }, (error) => {
            if (error === null) resolve();
            else reject(error);
          });
        });
      } catch (error) {
        void response.catch(() => {});
        throw error;
      }
      return response;
    };
    return {
      origin: ready.origin,
      pid: ready.pid,
      databaseInstanceAttestationId: ready.databaseInstanceAttestationId,
      async oracle() {
        const response = await request('oracle');
        if (response.oracle === undefined) {
          throw new Error('Fixture child returned no zero-oracle snapshot.');
        }
        return response.oracle;
      },
      close() {
        closePromise ??= (async () => {
          let gracefulError: unknown;
          if (child.connected) {
            await request('close', 5_000).catch((error) => gracefulError = error);
          } else {
            gracefulError = new Error('Fixture child disconnected before graceful close.');
          }
          if (!await waitForChildExit(child, 2_000)) {
            await terminateAndReapChild(child).catch((error) => {
              gracefulError = gracefulError === undefined
                ? error
                : new AggregateError([gracefulError, error], 'Fixture child teardown failed.');
            });
          }
          if (!childHasExited(child)) {
            throw new Error('Fixture child teardown returned without an observed exit.');
          }
          if (gracefulError !== undefined) throw gracefulError;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await terminateAndReapChild(child).catch((cleanupError) => cleanupErrors.push(cleanupError));
    throw combinedFailure('Fixture child startup and teardown failed.', error, cleanupErrors);
  }
};

export interface OfficialBrowserIrHoldoutZeroModelDependenciesOptions {
  readonly headless?: boolean | undefined;
}

/**
 * Opt-in live dependency factory. Each call creates a fresh fixture process
 * (and in-memory DB) plus a fresh official Client/stdio MCP/browser context/page.
 * One loopback port is selected prospectively and every sequential arm must
 * rebind it exactly. The preflight observes official MCP page-request logs;
 * this is not a process-wide or OS-level network-sandbox claim.
 */
export function createOfficialBrowserIrHoldoutZeroModelDependencies(
  options: OfficialBrowserIrHoldoutZeroModelDependenciesOptions = {},
): BrowserIrHoldoutZeroModelPreflightDependencies {
  const prospectivePort = selectProspectiveLoopbackPort();
  return {
    async openArm(input): Promise<BrowserIrHoldoutZeroModelArmSession> {
      const fixture = await startFixtureChild(
        input.caseId,
        input.worldId,
        await prospectivePort,
      );
      let mcp: OfficialBrowserIrMcpHandle | undefined;
      try {
        mcp = await startOfficialBrowserIrMcp({
          origin: fixture.origin,
          headless: options.headless ?? true,
        });
        let closePromise: Promise<void> | undefined;
        return {
          origin: fixture.origin,
          rawClient: mcp.client,
          runtimeIdentity: Object.freeze({
            fixtureProcessPid: fixture.pid,
            mcpProcessPid: mcp.pid,
            databaseInstanceAttestationId: fixture.databaseInstanceAttestationId,
            browserContextConstructionAttestationId:
              `isolated-browser-context-in-mcp-process:${mcp.pid}`,
            initialPageConstructionAttestationId:
              `initial-page-in-mcp-process:${mcp.pid}`,
          }),
          verifyZeroOracle: () => fixture.oracle(),
          close() {
            closePromise ??= (async () => {
              const cleanupErrors: unknown[] = [];
              await mcp!.close().catch((error) => cleanupErrors.push(error));
              await fixture.close().catch((error) => cleanupErrors.push(error));
              if (cleanupErrors.length > 0) {
                throw new AggregateError(cleanupErrors, 'Holdout arm cleanup failed.');
              }
            })();
            return closePromise;
          },
        };
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        await mcp?.close().catch((cleanupError) => cleanupErrors.push(cleanupError));
        await fixture.close().catch((cleanupError) => cleanupErrors.push(cleanupError));
        throw combinedFailure('Holdout arm startup and cleanup failed.', error, cleanupErrors);
      }
    },
  };
}
