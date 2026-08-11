import { describe, expect, it } from 'vitest';

import {
  TASK_ORACLE_CONTRACTS,
  TASK_ORACLE_RUNTIME_CONTRACT,
  taskOracleVersion,
} from '../src/task-oracle-contracts.js';
import { DAYS, SLOTS } from '../src/workshop.js';

describe('explicit task oracle contracts', () => {
  it('binds every entity-id comparison mode instead of claiming one global coercion', () => {
    expect(TASK_ORACLE_RUNTIME_CONTRACT.auditEntityIdMatching).toEqual({
      caseFoldedString: 'String(value).toLowerCase() equality',
      directString: 'String(value) equality',
      numeric: 'Number(value) equality',
      sqlIntegerCast: 'CAST(audit.entity_id AS INTEGER)',
      sqlStringParameter: 'String(value) bound to an entity_id SQL parameter',
    });

    expect(TASK_ORACLE_CONTRACTS['create-customer'].audit.entityIdMatch).toBe(
      'sql-string-parameter',
    );
    expect(TASK_ORACLE_CONTRACTS['validation-recovery'].priorRejectionAudit.entityIdMatch).toBe(
      'case-folded-string',
    );
    expect(TASK_ORACLE_CONTRACTS['mark-order-delivered'].audit.entityIdMatch).toBe('numeric');
    expect(
      TASK_ORACLE_CONTRACTS['reserve-cheapest-in-stock'].targetQuery.reconstructFromAudit
        .entityIdMatch,
    ).toBe('sql-integer-cast');
    expect(
      TASK_ORACLE_CONTRACTS['order-through-wizard'].order.creationAudit.entityIdMatch,
    ).toBe('sql-integer-cast');
    expect(TASK_ORACLE_CONTRACTS['query-three-conditions'].audit.entityIdMatch).toBe(
      'direct-string',
    );
  });

  it('binds the otherwise-unused required before object in customer-update evidence', () => {
    expect(TASK_ORACLE_CONTRACTS['raise-credit-limit'].audit.detailSchema).toEqual({
      changed: 'required-string-array',
      before: 'required-non-null-object',
      after: 'required-non-null-object',
    });
  });

  it('describes the actual missing-record not-applicable rule for the deep VIN task', () => {
    expect(TASK_ORACLE_CONTRACTS['find-vin-deep-in-inventory'].unavailable).toEqual({
      when: 'target-record-missing',
      outcome: 'not_applicable',
      observedVehicleCount: 'diagnostic-evidence',
      messageMinimumVehicleCount: 7_501,
    });
  });

  it('binds appointment destinations to the visible schedule', () => {
    const destination = TASK_ORACLE_CONTRACTS['reschedule-appointment'].audit.destination;
    expect(destination.allowedDates).toEqual(DAYS);
    expect(destination.allowedSlots.map(({ displayTime }) => displayTime)).toEqual(SLOTS);
    expect(destination.allowedSlots.map(({ index }) => index)).toEqual([0, 1, 2, 3]);
    expect(destination.occupancy).toBe('post-move-count-exactly-one');
  });

  it('recursively freezes every nested contract value', () => {
    const contract = TASK_ORACLE_CONTRACTS['create-customer'];
    const mutableView = contract.requiredFields as unknown as { credit_limit: number };
    const original = mutableView.credit_limit;
    const version = taskOracleVersion('create-customer');
    let mutationError: unknown;

    try {
      mutableView.credit_limit = original + 1;
    } catch (error) {
      mutationError = error;
    } finally {
      if (!Object.isFrozen(mutableView)) mutableView.credit_limit = original;
    }

    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.requiredFields)).toBe(true);
    expect(mutationError).toBeInstanceOf(TypeError);
    expect(taskOracleVersion('create-customer')).toBe(version);
  });
});
