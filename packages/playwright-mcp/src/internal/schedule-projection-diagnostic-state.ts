import { types as nodeUtilTypes } from 'node:util';

import type { AdaptivePlaywrightPolicySet } from './policy-set.js';

export type ScheduleProjectionDiagnosticReason =
  | 'baseline-context'
  | 'enriched-context'
  | 'root-box'
  | 'resource-box'
  | 'slot-box'
  | 'candidate-box'
  | 'resource-bands'
  | 'slot-bands-overlap-material'
  | 'candidate-overlap'
  | 'resources-inside-root'
  | 'slots-inside-root'
  | 'candidates-inside-root'
  | 'resource-center-distance'
  | 'slot-center-distance'
  | 'candidate-height-spacing'
  | 'candidate-cross-slot'
  | 'fact-count'
  | 'unique-ref'
  | 'unique-coordinate'
  | 'resolved';

export interface ScheduleProjectionDiagnosticSnapshot {
  readonly schemaVersion: 'schedule-projection-diagnostic/1';
  readonly ordinal: number;
  readonly reason: ScheduleProjectionDiagnosticReason;
}

export interface ScheduleProjectionDiagnosticChannel {
  readonly bind: (policySet: AdaptivePlaywrightPolicySet) => boolean;
  readonly record: (reason: ScheduleProjectionDiagnosticReason) => void;
}

const reasons: ReadonlySet<ScheduleProjectionDiagnosticReason> = new Set([
  'baseline-context',
  'enriched-context',
  'root-box',
  'resource-box',
  'slot-box',
  'candidate-box',
  'resource-bands',
  'slot-bands-overlap-material',
  'candidate-overlap',
  'resources-inside-root',
  'slots-inside-root',
  'candidates-inside-root',
  'resource-center-distance',
  'slot-center-distance',
  'candidate-height-spacing',
  'candidate-cross-slot',
  'fact-count',
  'unique-ref',
  'unique-coordinate',
  'resolved',
]);

const snapshots = new WeakMap<object, ScheduleProjectionDiagnosticSnapshot>();
const registered = new WeakSet<object>();

const objectIdentity = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const snapshot = (
  ordinal: number,
  reason: ScheduleProjectionDiagnosticReason,
): ScheduleProjectionDiagnosticSnapshot => Object.freeze(Object.assign(
  Object.create(null) as ScheduleProjectionDiagnosticSnapshot,
  {
    schemaVersion: 'schedule-projection-diagnostic/1' as const,
    ordinal,
    reason,
  },
));

/** Internal write capability. It accepts only an opaque handle and a finite reason. */
export function createScheduleProjectionDiagnosticChannel(): ScheduleProjectionDiagnosticChannel {
  let handle: object | undefined;
  let ordinal = 0;

  const bind = (policySet: AdaptivePlaywrightPolicySet): boolean => {
    try {
      if (
        handle !== undefined || !objectIdentity(policySet) ||
        nodeUtilTypes.isProxy(policySet) || registered.has(policySet)
      ) return false;
      registered.add(policySet);
      handle = policySet;
      return true;
    } catch {
      return false;
    }
  };

  const record = (reason: ScheduleProjectionDiagnosticReason): void => {
    try {
      if (handle === undefined || !reasons.has(reason)) return;
      if (ordinal === Number.MAX_SAFE_INTEGER) return;
      ordinal += 1;
      snapshots.set(handle, snapshot(ordinal, reason));
    } catch {
      // Diagnostics are deliberately non-authoritative and cannot affect policy behavior.
    }
  };

  return Object.freeze(Object.assign(
    Object.create(null) as ScheduleProjectionDiagnosticChannel,
    { bind: Object.freeze(bind), record: Object.freeze(record) },
  ));
}

/** Internal destructive read used only by the exact packed-product diagnostic facade. */
export function takeScheduleProjectionDiagnosticState(
  policySet: unknown,
): ScheduleProjectionDiagnosticSnapshot | undefined {
  try {
    if (!objectIdentity(policySet) || nodeUtilTypes.isProxy(policySet)) return undefined;
    const retained = snapshots.get(policySet);
    if (retained !== undefined) snapshots.delete(policySet);
    return retained;
  } catch {
    return undefined;
  }
}
