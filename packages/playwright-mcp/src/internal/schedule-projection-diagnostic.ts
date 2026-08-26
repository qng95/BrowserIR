import {
  takeScheduleProjectionDiagnosticState,
  type ScheduleProjectionDiagnosticSnapshot,
} from './schedule-projection-diagnostic-state.js';

/**
 * Consumes the latest actual schedule projection diagnostic for this opaque
 * first-party handle. This module is intentionally absent from package exports.
 */
export function takeScheduleProjectionDiagnostic(
  policySet: unknown,
): ScheduleProjectionDiagnosticSnapshot | undefined {
  return takeScheduleProjectionDiagnosticState(policySet);
}
