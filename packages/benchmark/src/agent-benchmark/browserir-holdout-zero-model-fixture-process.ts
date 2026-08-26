import { randomUUID } from 'node:crypto';

import {
  resolveAdaptiveAccuracyHoldoutBinding,
  startAppServer,
  verifyAdaptiveAccuracyHoldoutSelection,
} from '@think-dom/fixture-app';

const CHILD_PROTOCOL = 'browserir-holdout-zero-model-fixture-child/1' as const;

const caseId = process.env['BROWSERIR_HOLDOUT_PREFLIGHT_CASE_ID'];
const worldId = process.env['BROWSERIR_HOLDOUT_PREFLIGHT_WORLD_ID'];
const portSource = process.env['BROWSERIR_HOLDOUT_PREFLIGHT_PORT'];
const port = portSource === undefined ? Number.NaN : Number(portSource);
if (
  caseId === undefined || worldId === undefined || process.send === undefined ||
  !Number.isSafeInteger(port) || port < 1 || port > 65_535 || String(port) !== portSource
) {
  throw new Error('Holdout fixture child requires an IPC parent and exact binding.');
}

const binding = resolveAdaptiveAccuracyHoldoutBinding({ caseId, worldId } as never);
const app = await startAppServer({
  apiLatencyMs: 0,
  pageLatencyMs: 0,
  customers: 5,
  vehicles: 5,
  port,
  enableControlApi: false,
  adaptiveAccuracyHoldout: binding,
});
const databaseInstanceAttestationId = `fixture-db:${randomUUID()}`;

let closed = false;
let closePromise: Promise<void> | undefined;
const close = (): Promise<void> => {
  closePromise ??= (async () => {
    if (closed) return;
    closed = true;
    const cleanupErrors: unknown[] = [];
    await app.close().catch((error) => cleanupErrors.push(error));
    try { app.db.close(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Fixture app cleanup failed.');
    }
  })();
  return closePromise;
};

const send = (message: Readonly<Record<string, unknown>>): void => {
  if (process.send === undefined || !process.connected) return;
  process.send({ protocol: CHILD_PROTOCOL, ...message });
};

process.on('message', (message: unknown) => {
  void (async () => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Fixture child received a malformed command.');
    }
    const command = message as Record<string, unknown>;
    const requestId = command['requestId'];
    if (typeof requestId !== 'string') throw new Error('Fixture child command lacks requestId.');
    if (command['kind'] === 'oracle') {
      const result = verifyAdaptiveAccuracyHoldoutSelection(app.db, binding);
      send({
        kind: 'oracle',
        requestId,
        oracle: {
          exactSuccess: result.passed,
          mutationCount: result.mutationCount,
          collateralMutationCount: result.collateralMutationCount,
          totalHoldoutMutationCount: result.totalHoldoutMutationCount,
          otherAuditMutationCount: result.otherAuditMutationCount,
          totalAuditMutationCount: result.totalAuditMutationCount,
        },
      });
      return;
    }
    if (command['kind'] === 'close') {
      await close();
      send({ kind: 'closed', requestId });
      process.disconnect();
      return;
    }
    throw new Error('Fixture child command kind is unsupported.');
  })().catch((error: unknown) => {
    send({ kind: 'fatal', message: error instanceof Error ? error.message : String(error) });
    void close().catch(() => {}).finally(() => {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  });
});

process.once('disconnect', () => void close().catch(() => {}).finally(() => {
  process.exitCode ??= 0;
}));
process.once('SIGTERM', () => void close().catch(() => {}).finally(() => process.exit(0)));
send({
  kind: 'ready',
  origin: app.origin,
  pid: process.pid,
  databaseInstanceAttestationId,
});
