import { createHash } from 'node:crypto';

export const TASK_ORACLE_CONTRACT_SCHEMA_VERSION = '1.0.0' as const;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Explicit semantic inputs to each database/audit oracle.
 *
 * These values are deliberately data rather than Function#toString output.
 * JavaScript transforms may rewrite whitespace, helper names, optional chains,
 * and method syntax without changing the contract the judge enforces.
 */
export const TASK_ORACLE_CONTRACTS = deepFreeze({
  'create-customer': {
    record: { table: 'customers', name: 'Steinweg Logistik GmbH', nameMatch: 'case-insensitive' },
    requiredFields: {
      city: { value: 'Leipzig', match: 'case-insensitive' },
      country: { value: 'Germany', match: 'case-insensitive' },
      credit_limit: 30_000,
      vat_id: 'DE145879632',
      status: 'Prospect',
    },
    audit: {
      action: 'customer.create',
      entityId: 'created-customer-id',
      entityIdMatch: 'sql-string-parameter',
      count: 1,
    },
  },
  'raise-credit-limit': {
    record: { table: 'customers', number: 'K-100042' },
    requiredFields: { credit_limit: 45_000 },
    audit: {
      action: 'customer.update',
      entityId: 'target-customer-id',
      entityIdMatch: 'sql-string-parameter',
      count: 1,
      detailSchema: {
        changed: 'required-string-array',
        before: 'required-non-null-object',
        after: 'required-non-null-object',
      },
      changedFields: ['credit_limit'],
      after: { credit_limit: 45_000 },
    },
  },
  'validation-recovery': {
    record: { table: 'customers', name: 'Nordlicht Spedition', nameMatch: 'case-insensitive' },
    requiredFields: { city: 'Bremen', country: 'Germany', credit_limit: 250_000 },
    creationAudit: {
      action: 'customer.create',
      entityId: 'created-customer-id',
      entityIdMatch: 'sql-string-parameter',
      count: 1,
    },
    priorRejectionAudit: {
      action: 'customer.create.rejected',
      before: 'creation-audit-id',
      entityId: { value: 'Nordlicht Spedition', match: 'case-insensitive' },
      entityIdMatch: 'case-folded-string',
      detail: {
        reason: 'credit_limit_above_ceiling',
        name: { value: 'Nordlicht Spedition', match: 'case-insensitive' },
        attemptedCreditLimit: 400_000,
        maximumCreditLimit: 250_000,
      },
    },
  },
  'mark-order-delivered': {
    record: { table: 'orders', number: 'A-2026-0007', requiredStatus: 'Delivered' },
    audit: {
      action: 'order.deliver',
      globalCount: 1,
      entityId: 'target-order-id',
      entityIdMatch: 'numeric',
      detailPattern: '<allowed-prior-status> -> Delivered',
      allowedPriorStatuses: [
        'Draft',
        'Awaiting deposit',
        'Confirmed',
        'In production',
        'Cancelled',
      ],
    },
  },
  'highest-revenue-poland': {
    targetQuery: {
      table: 'customers',
      where: { country: 'Poland' },
      orderBy: ['revenue DESC', 'id ASC'],
      limit: 1,
    },
    requiredFields: { status: 'Active' },
    audit: {
      action: 'customer.update',
      entityId: 'target-customer-id',
      entityIdMatch: 'sql-string-parameter',
      count: 1,
      changedFieldsIncludes: 'status',
      beforeStatusMustDifferFrom: 'Active',
      after: { status: 'Active' },
    },
  },
  'reserve-cheapest-in-stock': {
    targetQuery: {
      table: 'vehicles',
      initialStatus: 'In stock',
      reconstructFromAudit: {
        action: 'vehicle.status',
        entityIdMatch: 'sql-integer-cast',
        detailPrefix: 'In stock → ',
      },
      orderBy: ['price_cents ASC', 'id ASC'],
      limit: 1,
    },
    requiredFields: { status: 'Reserved' },
    audit: {
      action: 'vehicle.status',
      globalCount: 1,
      entityId: 'target-vehicle-id',
      entityIdMatch: 'numeric',
      detail: 'In stock → Reserved',
    },
  },
  'order-through-wizard': {
    customer: { table: 'customers', number: 'K-100032' },
    order: {
      creationAudit: {
        action: 'order.create',
        entity: 'order',
        entityIdMatch: 'sql-integer-cast',
        count: 1,
      },
      customerId: 'target-customer-id',
      delivery_on: '2026-09-30',
    },
    orderLines: { count: 1, vehicleId: 'selected-vehicle-id' },
    vehicle: { requiredStatus: 'Reserved' },
    reservationAudit: {
      action: 'vehicle.reserve',
      entity: 'vehicle',
      entityId: 'selected-vehicle-id',
      entityIdMatch: 'sql-string-parameter',
      detailPattern: 'In stock -> Reserved; order <created-order-number>',
    },
  },
  'find-vin-deep-in-inventory': {
    record: { table: 'vehicles', vin: 'WV1ZZZ0075000', requiredStatus: 'Demo' },
    unavailable: {
      when: 'target-record-missing',
      outcome: 'not_applicable',
      observedVehicleCount: 'diagnostic-evidence',
      messageMinimumVehicleCount: 7_501,
    },
    audit: {
      action: 'vehicle.status',
      entityId: 'target-vehicle-id',
      entityIdMatch: 'sql-string-parameter',
      count: 1,
      detailSuffix: '→ Demo',
    },
  },
  'bulk-cancel-drafts': {
    targetQuery: {
      table: 'orders',
      initialStatus: 'Draft',
      reconstructFromAudit: {
        action: 'order.cancel',
        entityIdMatch: 'sql-integer-cast',
        detail: 'Draft -> Cancelled',
      },
      orderBy: ['placed_on DESC', 'id DESC'],
      limit: 25,
    },
    rowAudits: {
      action: 'order.cancel',
      entityIdMatch: 'numeric',
      exactTargetSet: true,
      detail: 'Draft -> Cancelled',
    },
    bulkAudit: {
      action: 'order.bulk.cancel',
      count: 1,
      afterRowAudits: true,
      entityId: 'target-count',
      entityIdMatch: 'numeric',
      detail: {
        action: 'cancel',
        exactIds: true,
        exactTransitions: { before: 'Draft', after: 'Cancelled' },
      },
    },
    finalStatus: 'Cancelled',
  },
  'reschedule-appointment': {
    audit: {
      action: 'appointment.move',
      globalCount: 1,
      entityIdMatch: 'numeric',
      source: { bay: 'Bay 1', date: '2026-08-03', slotIndex: 2, displayTime: '13:00' },
      destination: {
        bay: 'Bay 4',
        allowedDates: [
          '2026-08-03',
          '2026-08-04',
          '2026-08-05',
          '2026-08-06',
          '2026-08-07',
        ],
        allowedSlots: [
          { index: 0, displayTime: '08:00' },
          { index: 1, displayTime: '10:30' },
          { index: 2, displayTime: '13:00' },
          { index: 3, displayTime: '15:30' },
        ],
        occupancy: 'post-move-count-exactly-one',
        finalRecordMatchesAudit: true,
      },
      acceptedRoutes: ['drag', 'keyboard'],
      detailPattern:
        'bay <source-bay-id>/2026-08-03/2 -> bay <destination-bay-id>/<allowed-date>/<allowed-slot> via <accepted-route>',
    },
    finalRecord: { table: 'appointments', id: 'moved-entity-id', bay: 'Bay 4' },
  },
  'restock-low-part': {
    audit: {
      action: 'part.restock',
      entityIdMatch: 'numeric',
      minimumCount: 1,
      uniqueEntityCount: 1,
      detailSuffixPattern: '+<positive-integer>',
    },
    reconstructedBefore: { stock: '<final-stock>-<sum-audit-quantities>', below: 'reorder_level' },
    finalRecord: { table: 'parts', stockAtLeast: '2*reorder_level' },
  },
  'settle-invoice': {
    record: { table: 'invoices', number: 'R-2026-0002' },
    unavailable: { outcome: 'not_applicable' },
    requiredFields: { status: 'Paid' },
    audit: {
      action: 'invoice.pay',
      entityId: 'target-invoice-id',
      entityIdMatch: 'sql-string-parameter',
      count: 1,
      detailSuffix: '-> Paid',
    },
  },
  'triage-ticket': {
    record: { table: 'tickets', number: 'T-1005' },
    unavailable: { outcome: 'not_applicable' },
    auditsFirst: true,
    audit: {
      action: 'ticket.update',
      entityId: 'target-ticket-id',
      entityIdMatch: 'sql-string-parameter',
      count: 2,
      details: ['priority: <prior> -> Urgent', 'assignee: <prior> -> M. Roth'],
    },
    requiredFields: { priority: 'Urgent', assignee: 'M. Roth' },
  },
  'query-three-conditions': {
    expectedResultQuery: {
      table: 'customers',
      conditions: [
        ['country', 'equals', 'Germany'],
        ['status', 'equals', 'Active'],
        ['credit_limit', '>', '30000'],
      ],
      match: 'all',
    },
    audit: {
      action: 'report.query',
      minimumCount: 1,
      entityId: '3',
      entityIdMatch: 'direct-string',
      exactConditionSet: true,
      resultCount: 'expected-query-count',
    },
  },
} as const);

export type TaskOracleContractId = keyof typeof TASK_ORACLE_CONTRACTS;

export const TASK_ORACLE_CONTRACT_IDS = Object.freeze(
  Object.keys(TASK_ORACLE_CONTRACTS).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  ) as TaskOracleContractId[],
);

export const TASK_ORACLE_RUNTIME_CONTRACT = deepFreeze({
  resultClassification: {
    notApplicable: 'not_applicable',
    passed: 'passed',
    otherwise: 'failed',
  },
  numericCoercion: 'Number',
  auditEntityIdMatching: {
    caseFoldedString: 'String(value).toLowerCase() equality',
    directString: 'String(value) equality',
    numeric: 'Number(value) equality',
    sqlIntegerCast: 'CAST(audit.entity_id AS INTEGER)',
    sqlStringParameter: 'String(value) bound to an entity_id SQL parameter',
  },
  jsonEvidence: 'JSON object only; arrays/null/malformed values are invalid',
  exactNumberSet:
    'equal length; unique on both sides; every left value occurs on the right',
});

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Task oracle contracts cannot contain non-finite numbers.');
  }
  return value;
};

export function taskOracleVersion(id: TaskOracleContractId): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          schemaVersion: TASK_ORACLE_CONTRACT_SCHEMA_VERSION,
          runtime: TASK_ORACLE_RUNTIME_CONTRACT,
          task: TASK_ORACLE_CONTRACTS[id],
        }),
      ),
      'utf8',
    )
    .digest('hex')}`;
}
