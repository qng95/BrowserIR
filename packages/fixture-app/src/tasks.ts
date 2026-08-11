import type { DatabaseSync } from 'node:sqlite';

import {
  TASK_ORACLE_CONTRACTS,
  TASK_ORACLE_CONTRACT_IDS,
  taskOracleVersion,
  type TaskOracleContractId,
} from './task-oracle-contracts.js';

type Row = Record<string, unknown>;

const rescheduleDestinationContract =
  TASK_ORACLE_CONTRACTS['reschedule-appointment'].audit.destination;

/**
 * Verifiable agent tasks.
 *
 * This is the part a static page cannot have. Representation benchmarks ask
 * "how much of the screen did you see"; this asks "did the job get done", and
 * grades it by reading the database rather than by looking at the page. An
 * agent that hallucinates success fails here, which is exactly the failure mode
 * worth catching.
 *
 * Each task checks the audit log as well as row state, so a task whose target
 * value happened to be true already cannot pass without the agent acting.
 */
export type TaskOutcome = 'passed' | 'failed' | 'not_applicable';

export interface TaskResult {
  outcome: TaskOutcome;
  passed: boolean;
  reason: string;
  evidence?: unknown;
}

export interface Task {
  id: string;
  /** Given to the agent verbatim. */
  prompt: string;
  /** What makes this hard, for slicing results. */
  skills: string[];
  /** Hash of the executable oracle contract used to bind benchmark evidence. */
  oracleVersion: string;
  verify(db: DatabaseSync): TaskResult;
}

interface TaskDefinitionResult {
  passed: boolean;
  reason: string;
  evidence?: unknown;
  notApplicable?: boolean;
}

interface TaskDefinition extends Omit<Task, 'id' | 'verify' | 'oracleVersion'> {
  id: TaskOracleContractId;
  verify(db: DatabaseSync): TaskDefinitionResult;
}

function classify(result: TaskDefinitionResult): TaskResult {
  const { notApplicable = false, ...publicResult } = result;
  return {
    outcome: notApplicable ? 'not_applicable' : result.passed ? 'passed' : 'failed',
    ...publicResult,
  };
}

function auditCount(db: DatabaseSync, action: string, entityId?: string | number): number {
  const sql = entityId
    ? 'SELECT COUNT(*) AS n FROM audit WHERE action = ? AND entity_id = ?'
    : 'SELECT COUNT(*) AS n FROM audit WHERE action = ?';
  const args = entityId ? [action, String(entityId)] : [action];
  return Number((db.prepare(sql).get(...(args as never[])) as Row).n);
}

function parseCustomerUpdate(detail: unknown):
  | { changed: string[]; before: Row; after: Row }
  | undefined {
  try {
    const parsed = JSON.parse(String(detail)) as Record<string, unknown>;
    if (
      !Array.isArray(parsed['changed']) ||
      !parsed['changed'].every((field) => typeof field === 'string') ||
      typeof parsed['before'] !== 'object' ||
      parsed['before'] === null ||
      typeof parsed['after'] !== 'object' ||
      parsed['after'] === null
    ) {
      return undefined;
    }
    return {
      changed: parsed['changed'] as string[],
      before: parsed['before'] as Row,
      after: parsed['after'] as Row,
    };
  } catch {
    return undefined;
  }
}

function parseJsonObject(detail: unknown): Row | undefined {
  try {
    const parsed = JSON.parse(String(detail)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Row)
      : undefined;
  } catch {
    return undefined;
  }
}

function sameNumberSet(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  );
}

const TASK_DEFINITIONS: TaskDefinition[] = [
  {
    id: 'create-customer',
    prompt:
      'Sign in as test (password test) and create a new customer named ' +
      '"Steinweg Logistik GmbH" in Leipzig, Germany, with a credit limit of 30000 and ' +
      'VAT ID DE145879632. Status should be Prospect.',
    skills: ['login', 'navigate', 'form-fill', 'server-validation', 'post-redirect-get'],
    verify(db) {
      const c = db
        .prepare('SELECT * FROM customers WHERE lower(name) = lower(?)')
        .get('Steinweg Logistik GmbH') as Row | undefined;
      if (!c) return { passed: false, reason: 'No customer named "Steinweg Logistik GmbH" exists.' };

      const problems: string[] = [];
      if (String(c['city']).toLowerCase() !== 'leipzig') problems.push(`city is "${c['city']}"`);
      if (String(c['country']).toLowerCase() !== 'germany') problems.push(`country is "${c['country']}"`);
      if (Number(c['credit_limit']) !== 30000) problems.push(`credit limit is ${c['credit_limit']}`);
      if (String(c['vat_id']) !== 'DE145879632') problems.push(`VAT ID is "${c['vat_id']}"`);
      if (String(c['status']) !== 'Prospect') problems.push(`status is "${c['status']}"`);

      if (problems.length) {
        return { passed: false, reason: `Customer created but ${problems.join(', ')}.`, evidence: c };
      }
      if (auditCount(db, 'customer.create', Number(c['id'])) !== 1) {
        return { passed: false, reason: 'Customer values are correct, but no matching application creation was recorded.' };
      }
      return { passed: true, reason: 'Customer created with all fields correct.', evidence: c };
    },
  },

  {
    id: 'raise-credit-limit',
    prompt:
      'Find the customer with number K-100042 and change their credit limit to 45000. ' +
      'Leave every other field unchanged.',
    skills: ['search', 'navigate', 'form-edit', 'idempotence'],
    verify(db) {
      const c = db.prepare('SELECT * FROM customers WHERE number = ?').get('K-100042') as Row | undefined;
      if (!c) return { passed: false, reason: 'Customer K-100042 no longer exists — it should not have been deleted.' };
      if (Number(c['credit_limit']) !== 45000) {
        return { passed: false, reason: `Credit limit is ${c['credit_limit']}, expected 45000.`, evidence: c };
      }
      const updates = db
        .prepare("SELECT detail FROM audit WHERE action = 'customer.update' AND entity_id = ? ORDER BY id")
        .all(String(c['id'])) as Row[];
      if (updates.length !== 1) {
        return {
          passed: false,
          reason:
            updates.length === 0
              ? 'Value is correct but no update was ever recorded for this customer.'
              : `Expected one customer update, found ${updates.length}.`,
        };
      }
      const evidence = parseCustomerUpdate(updates[0]!['detail']);
      if (
        !evidence ||
        evidence.changed.length !== 1 ||
        evidence.changed[0] !== 'credit_limit' ||
        Number(evidence.after['credit_limit']) !== 45000
      ) {
        return {
          passed: false,
          reason: 'The recorded update changed fields other than the credit limit or lacks structured before/after evidence.',
          evidence: updates[0],
        };
      }
      return { passed: true, reason: 'Credit limit updated to 45000.', evidence: c };
    },
  },

  {
    id: 'validation-recovery',
    prompt:
      'Create a customer named "Nordlicht Spedition" in Bremen, Germany with a credit limit of 400000. ' +
      'If the system will not accept that limit, use the highest value it does accept instead.',
    skills: ['form-fill', 'read-error-message', 'recover-and-retry'],
    verify(db) {
      const c = db
        .prepare('SELECT * FROM customers WHERE lower(name) = lower(?)')
        .get('Nordlicht Spedition') as Row | undefined;
      if (!c) return { passed: false, reason: 'Customer "Nordlicht Spedition" was never created.' };
      if (String(c['city']) !== 'Bremen') {
        return {
          passed: false,
          reason: `City is "${c['city']}"; expected "Bremen".`,
          evidence: c,
        };
      }
      if (String(c['country']) !== 'Germany') {
        return {
          passed: false,
          reason: `Country is "${c['country']}"; expected "Germany".`,
          evidence: c,
        };
      }
      // 250000 is the documented ceiling; the rule is only discoverable by
      // submitting and reading the rendered validation error.
      if (Number(c['credit_limit']) !== 250000) {
        return {
          passed: false,
          reason: `Credit limit is ${c['credit_limit']}; the maximum the server accepts is 250000.`,
          evidence: c,
        };
      }
      const creations = db
        .prepare("SELECT id, detail FROM audit WHERE action = 'customer.create' AND entity_id = ? ORDER BY id")
        .all(String(c['id'])) as Row[];
      if (creations.length !== 1) {
        return { passed: false, reason: 'Customer values are correct, but no matching application creation was recorded.' };
      }
      const creationAuditId = Number(creations[0]!['id']);
      const rejectedAttempts = db
        .prepare(
          "SELECT id, entity_id, detail FROM audit WHERE action = 'customer.create.rejected' AND id < ? ORDER BY id",
        )
        .all(creationAuditId) as Row[];
      const matchingRejection = rejectedAttempts.find((row) => {
        const evidence = parseJsonObject(row['detail']);
        return (
          String(row['entity_id']).toLowerCase() === 'nordlicht spedition' &&
          evidence?.['reason'] === 'credit_limit_above_ceiling' &&
          String(evidence['name']).toLowerCase() === 'nordlicht spedition' &&
          Number(evidence['attemptedCreditLimit']) === 400000 &&
          Number(evidence['maximumCreditLimit']) === 250000
        );
      });
      if (!matchingRejection) {
        return {
          passed: false,
          reason: 'The customer was created at the ceiling, but no prior rejected 400000 attempt proves validation recovery.',
          evidence: { creationAuditId, rejectedAttempts },
        };
      }
      return { passed: true, reason: 'Recovered from validation failure and used the maximum accepted limit.', evidence: c };
    },
  },

  {
    id: 'mark-order-delivered',
    prompt: 'Find order A-2026-0007 and mark it as delivered.',
    skills: ['pagination', 'search-across-pages', 'mutating-action'],
    verify(db) {
      const o = db.prepare('SELECT * FROM orders WHERE number = ?').get('A-2026-0007') as Row | undefined;
      if (!o) return { passed: false, reason: 'Order A-2026-0007 not found.' };
      if (String(o['status']) !== 'Delivered') {
        return { passed: false, reason: `Order status is "${o['status']}", expected "Delivered".`, evidence: o };
      }
      const deliveries = db
        .prepare("SELECT entity_id, detail FROM audit WHERE action = 'order.deliver' ORDER BY id")
        .all() as Row[];
      if (deliveries.length !== 1) {
        return {
          passed: false,
          reason:
            deliveries.length === 0
              ? 'Order is delivered but no action was recorded.'
              : `Expected one delivery action with no collateral orders, found ${deliveries.length}.`,
          evidence: deliveries,
        };
      }
      const delivery = deliveries[0]!;
      const transition = /^(.*) -> Delivered$/.exec(String(delivery['detail']));
      if (
        Number(delivery['entity_id']) !== Number(o['id']) ||
        !transition ||
        !['Draft', 'Awaiting deposit', 'Confirmed', 'In production', 'Cancelled'].includes(transition[1]!)
      ) {
        return {
          passed: false,
          reason: 'The recorded action does not prove the target order transitioned from a non-delivered state.',
          evidence: delivery,
        };
      }
      return { passed: true, reason: 'Order marked delivered.', evidence: o };
    },
  },

  {
    id: 'highest-revenue-poland',
    prompt:
      'Among customers in Poland, find the one with the highest revenue and set their status to "Active". ' +
      'Report the customer number you changed.',
    skills: ['filter', 'sort', 'aggregate-reasoning', 'multi-step'],
    verify(db) {
      const target = db
        .prepare("SELECT * FROM customers WHERE country = 'Poland' ORDER BY revenue DESC, id ASC LIMIT 1")
        .get() as Row | undefined;
      if (!target) return { passed: false, reason: 'No Polish customers in the dataset.' };
      if (String(target['status']) !== 'Active') {
        return {
          passed: false,
          reason: `Highest-revenue Polish customer is ${target['number']} (${target['name']}); its status is "${target['status']}".`,
          evidence: { expected: target['number'] },
        };
      }
      const updates = db
        .prepare("SELECT detail FROM audit WHERE action = 'customer.update' AND entity_id = ? ORDER BY id")
        .all(String(target['id'])) as Row[];
      const statusUpdate = updates.length === 1 ? parseCustomerUpdate(updates[0]!['detail']) : undefined;
      if (
        !statusUpdate ||
        !statusUpdate.changed.includes('status') ||
        String(statusUpdate.before['status']) === 'Active' ||
        String(statusUpdate.after['status']) !== 'Active'
      ) {
        return {
          passed: false,
          reason: 'Correct customer is Active, but no single recorded update proves its status changed to Active.',
          evidence: updates,
        };
      }
      return { passed: true, reason: `Set ${target['number']} to Active.`, evidence: target };
    },
  },
];

// ---- tasks that exercise the wizard and the virtualised inventory ---------

TASK_DEFINITIONS.push(
  {
    id: 'reserve-cheapest-in-stock',
    prompt:
      'In the vehicle inventory, find the cheapest vehicle whose status is "In stock" ' +
      'and change its status to "Reserved". Report its VIN.',
    skills: ['filter', 'sort', 'virtualised-grid', 'navigate-to-detail', 'mutating-action'],
    verify(db) {
      // Reconstruct the initial candidate set: currently in-stock rows plus
      // any row whose audit proves it started in stock before this task.
      const target = db
        .prepare(
          `SELECT * FROM vehicles
           WHERE status = 'In stock'
              OR id IN (
                SELECT CAST(entity_id AS INTEGER) FROM audit
                WHERE action = 'vehicle.status' AND detail LIKE 'In stock → %'
              )
           ORDER BY price_cents ASC, id ASC LIMIT 1`,
        )
        .get() as Row | undefined;
      if (!target) return { passed: false, reason: 'No candidate vehicles in the dataset.' };

      const changes = db
        .prepare("SELECT * FROM audit WHERE action = 'vehicle.status' ORDER BY id")
        .all() as Row[];
      const changed = changes.length === 1 ? changes[0] : undefined;

      if (
        !changed ||
        Number(changed['entity_id']) !== Number(target['id']) ||
        String(changed['detail']) !== 'In stock → Reserved'
      ) {
        return {
          passed: false,
          reason: `The cheapest in-stock vehicle is ${target['vin']} at ${Number(target['price_cents']) / 100} €; its status was never changed.`,
          evidence: { expectedVin: target['vin'] },
        };
      }
      if (String(target['status']) !== 'Reserved') {
        return { passed: false, reason: `${target['vin']} is "${target['status']}", expected "Reserved".` };
      }
      return { passed: true, reason: `Reserved ${target['vin']}.`, evidence: target };
    },
  },

  {
    id: 'order-through-wizard',
    prompt:
      'Create a new order for the customer with number K-100032. Choose any vehicle that is ' +
      'currently "In stock", set the delivery date to 2026-09-30, and complete the order.',
    skills: ['wizard', 'debounced-autocomplete', 'modal-picker', 'multi-step-state', 'server-validation'],
    verify(db) {
      const cust = db.prepare('SELECT * FROM customers WHERE number = ?').get('K-100032') as Row | undefined;
      if (!cust) return { passed: false, reason: 'Customer K-100032 is missing from the dataset.' };

      const createdOrders = db
        .prepare(
          `SELECT o.*, a.id AS create_audit_id
           FROM audit a
           JOIN orders o ON o.id = CAST(a.entity_id AS INTEGER)
           WHERE a.action = 'order.create' AND a.entity = 'order' AND o.customer_id = ?
           ORDER BY a.id`,
        )
        .all(Number(cust['id'])) as Row[];

      if (createdOrders.length === 0) {
        return { passed: false, reason: 'No order was created for K-100032 through the application.' };
      }
      if (createdOrders.length !== 1) {
        return {
          passed: false,
          reason: `${createdOrders.length} orders were created for K-100032; the task requested exactly one.`,
          evidence: { orderIds: createdOrders.map((row) => row['id']) },
        };
      }
      const order = createdOrders[0]!;
      if (String(order['delivery_on']) !== '2026-09-30') {
        return {
          passed: false,
          reason: `Delivery date is "${String(order['delivery_on'])}", expected "2026-09-30".`,
          evidence: order,
        };
      }
      // The wizard writes an order line linking the order to a vehicle, and
      // reserves it. Both must be true, or the flow was short-circuited.
      const lines = db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(Number(order['id'])) as Row[];
      if (lines.length !== 1) {
        return { passed: false, reason: `Order has ${lines.length} vehicle lines; expected exactly one.` };
      }
      const line = lines[0]!;

      const veh = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(line['vehicle_id'])) as Row;
      if (String(veh['status']) !== 'Reserved') {
        return { passed: false, reason: `Vehicle ${veh['vin']} should be Reserved, it is "${veh['status']}".` };
      }
      const reservation = db
        .prepare(
          `SELECT * FROM audit
           WHERE action = 'vehicle.reserve' AND entity = 'vehicle' AND entity_id = ?
             AND detail = ?`,
        )
        .get(String(veh['id']), `In stock -> Reserved; order ${String(order['number'])}`) as Row | undefined;
      if (!reservation) {
        return {
          passed: false,
          reason: `Vehicle ${String(veh['vin'])} is Reserved, but there is no linked audit proving it was in stock.`,
        };
      }
      return {
        passed: true,
        reason: `Order ${order['number']} created for K-100032 with ${veh['vin']} reserved.`,
        evidence: { order, vehicle: veh['vin'] },
      };
    },
  },

  {
    id: 'find-vin-deep-in-inventory',
    prompt:
      'The vehicle with VIN WV1ZZZ0075000 is somewhere in the inventory. Open it and set its ' +
      'status to "Demo".',
    skills: ['search', 'virtualised-grid', 'deep-record', 'mutating-action'],
    verify(db) {
      const v = db.prepare('SELECT * FROM vehicles WHERE vin = ?').get('WV1ZZZ0075000') as Row | undefined;
      if (!v) {
        // Distinguish "the agent did not do it" from "this dataset cannot host
        // the task". Reporting the latter as a failure would quietly deflate
        // any score measured on a reduced fixture.
        const n = Number((db.prepare('SELECT COUNT(*) AS n FROM vehicles').get() as Row).n);
        return {
          passed: false,
          notApplicable: true,
          reason: `This task needs at least 7,501 vehicles; the dataset has ${n}.`,
          evidence: { vehicles: n },
        };
      }
      if (String(v['status']) !== 'Demo') {
        return { passed: false, reason: `Status is "${v['status']}", expected "Demo".`, evidence: v };
      }
      const changes = db
        .prepare("SELECT detail FROM audit WHERE action = 'vehicle.status' AND entity_id = ? ORDER BY id")
        .all(String(v['id'])) as Row[];
      if (changes.length !== 1 || !String(changes[0]!['detail']).endsWith('→ Demo')) {
        return { passed: false, reason: 'Status is Demo but no single recorded change proves it was set through the app.' };
      }
      return { passed: true, reason: 'Vehicle set to Demo.', evidence: v };
    },
  },
);

// ---- tasks for the remaining screens --------------------------------------

TASK_DEFINITIONS.push(
  {
    id: 'bulk-cancel-drafts',
    prompt:
      'On the orders screen, filter to status "Draft", select every order on the first page ' +
      'and cancel them all in one action.',
    skills: ['filter', 'bulk-selection', 'hidden-until-selected', 'multi-entity-mutation'],
    verify(db) {
      const cancelled = db
        .prepare("SELECT id, entity_id, detail FROM audit WHERE action = 'order.cancel' ORDER BY id")
        .all() as Row[];
      const expected = db
        .prepare(
          `SELECT id FROM orders
           WHERE status = 'Draft'
              OR id IN (
                SELECT CAST(entity_id AS INTEGER) FROM audit
                WHERE action = 'order.cancel' AND detail = 'Draft -> Cancelled'
              )
           ORDER BY placed_on DESC, id DESC LIMIT 25`,
        )
        .all() as Row[];
      const expectedIds = expected.map((row) => Number(row['id']));
      const actualIds = cancelled.map((row) => Number(row['entity_id']));
      const exactIds = sameNumberSet(actualIds, expectedIds);
      const allWereDrafts = cancelled.every((row) => String(row['detail']) === 'Draft -> Cancelled');
      if (!exactIds || !allWereDrafts) {
        return {
          passed: false,
          reason: `Cancelled order IDs do not exactly match the ${expectedIds.length} Draft orders on the first filtered page.`,
          evidence: { expectedIds, actualIds },
        };
      }
      const bulkOperations = db
        .prepare("SELECT id, entity_id, detail FROM audit WHERE action = 'order.bulk.cancel' ORDER BY id")
        .all() as Row[];
      if (bulkOperations.length !== 1) {
        return {
          passed: false,
          reason:
            bulkOperations.length === 0
              ? 'The correct rows were cancelled, but no single bulk operation was recorded.'
              : `Expected one bulk cancellation operation, found ${bulkOperations.length}.`,
          evidence: bulkOperations,
        };
      }
      const bulkOperation = bulkOperations[0]!;
      const bulkEvidence = parseJsonObject(bulkOperation['detail']);
      const bulkIds = Array.isArray(bulkEvidence?.['ids'])
        ? bulkEvidence['ids'].map(Number)
        : [];
      const transitions = Array.isArray(bulkEvidence?.['transitions'])
        ? bulkEvidence['transitions']
        : [];
      const transitionIds = transitions.map((transition) =>
        typeof transition === 'object' && transition !== null && !Array.isArray(transition)
          ? Number((transition as Row)['id'])
          : Number.NaN,
      );
      const exactTransitions =
        sameNumberSet(transitionIds, expectedIds) &&
        transitions.every((transition) => {
          if (typeof transition !== 'object' || transition === null || Array.isArray(transition)) return false;
          const row = transition as Row;
          return (
            expectedIds.includes(Number(row['id'])) &&
            row['before'] === 'Draft' &&
            row['after'] === 'Cancelled'
          );
        });
      const operationFollowedRows = cancelled.every(
        (row) => Number(row['id']) < Number(bulkOperation['id']),
      );
      if (
        bulkEvidence?.['action'] !== 'cancel' ||
        Number(bulkOperation['entity_id']) !== expectedIds.length ||
        !sameNumberSet(bulkIds, expectedIds) ||
        !exactTransitions ||
        !operationFollowedRows
      ) {
        return {
          passed: false,
          reason: 'The bulk-operation evidence does not exactly cover the first filtered Draft page.',
          evidence: { expectedIds, bulkOperation },
        };
      }
      const stillOpen = db
        .prepare(`SELECT COUNT(*) AS n FROM orders WHERE id IN (${expectedIds.join(',')}) AND status != 'Cancelled'`)
        .get() as Row;
      if (Number(stillOpen.n) > 0) {
        return { passed: false, reason: 'Some orders were recorded as cancelled but are not in that state.' };
      }
      return { passed: true, reason: `${expectedIds.length} orders cancelled in bulk.` };
    },
  },

  {
    id: 'reschedule-appointment',
    prompt:
      'In the workshop schedule, move the appointment in Bay 1 at 13:00 on 2026-08-03 to any ' +
      'free slot in Bay 4. Dragging or the keyboard route are both acceptable.',
    skills: ['drag-and-drop', 'keyboard-alternative', 'spatial-grid', 'occupancy-constraint'],
    verify(db) {
      const moves = db
        .prepare("SELECT * FROM audit WHERE action = 'appointment.move' ORDER BY id")
        .all() as Row[];
      if (moves.length === 0) return { passed: false, reason: 'No appointment was ever moved.' };

      if (moves.length !== 1) {
        return { passed: false, reason: `${moves.length} appointments were moved; the task requested one.` };
      }

      const bay1 = db.prepare("SELECT id FROM bays WHERE name = 'Bay 1'").get() as Row | undefined;
      const bay4 = db.prepare("SELECT id FROM bays WHERE name = 'Bay 4'").get() as Row | undefined;
      if (!bay1 || !bay4) return { passed: false, reason: 'Bay 1 or Bay 4 is missing from this dataset.' };

      const move = moves[0]!;
      const transition =
        /^bay (\d+)\/([^/]+)\/(\d+) -> bay (\d+)\/([^/]+)\/(\d+) via (drag|keyboard)$/.exec(
          String(move['detail']),
        );
      const destinationDay = transition?.[5];
      const destinationSlot = Number(transition?.[6]);
      if (
        !transition ||
        Number(transition[1]) !== Number(bay1['id']) ||
        transition[2] !== '2026-08-03' ||
        Number(transition[3]) !== 2 ||
        Number(transition[4]) !== Number(bay4['id']) ||
        destinationDay === undefined ||
        !(rescheduleDestinationContract.allowedDates as readonly string[]).includes(
          destinationDay,
        ) ||
        !Number.isInteger(destinationSlot) ||
        !rescheduleDestinationContract.allowedSlots.some(
          ({ index }) => index === destinationSlot,
        )
      ) {
        return {
          passed: false,
          reason:
            'The move audit does not prove the requested source, a visible Bay 4 destination, and an accepted input route.',
          evidence: { move: move['detail'] },
        };
      }

      const landed = db
        .prepare('SELECT * FROM appointments WHERE id = ?')
        .get(Number(move['entity_id'])) as Row | undefined;
      if (
        !landed ||
        Number(landed['bay_id']) !== Number(bay4['id']) ||
        String(landed['day']) !== destinationDay ||
        Number(landed['slot']) !== destinationSlot
      ) {
        return {
          passed: false,
          reason: 'The target appointment did not end up in the audited Bay 4 date and slot.',
          evidence: { move: move['detail'], landed },
        };
      }
      const destinationOccupancy = Number(
        (
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM appointments WHERE bay_id = ? AND day = ? AND slot = ?',
            )
            .get(Number(bay4['id']), destinationDay, destinationSlot) as Row
        )['n'],
      );
      if (destinationOccupancy !== 1) {
        return {
          passed: false,
          reason: 'The audited Bay 4 destination is occupied by another appointment.',
          evidence: { move: move['detail'], destinationOccupancy },
        };
      }
      // Which input route was used is recorded, so drag and keyboard can be
      // reported separately even though either satisfies the task.
      const via = transition[7]!;
      return { passed: true, reason: `Appointment moved into Bay 4 via ${via}.`, evidence: { via } };
    },
  },

  {
    id: 'restock-low-part',
    prompt:
      'In Parts, find any part whose stock has fallen below its reorder level and restock it ' +
      'so that stock is at least double the reorder level.',
    skills: ['category-tree', 'master-detail', 'read-derived-condition', 'form-submit'],
    verify(db) {
      const restocks = db.prepare("SELECT * FROM audit WHERE action = 'part.restock' ORDER BY id").all() as Row[];
      if (restocks.length === 0) return { passed: false, reason: 'No part was restocked.' };

      const ids = [...new Set(restocks.map((row) => Number(row['entity_id'])))];
      if (ids.length !== 1) {
        return { passed: false, reason: `${ids.length} parts were restocked; the task requested one.`, evidence: { ids } };
      }
      const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(ids[0]!) as Row | undefined;
      const quantities = restocks.map((row) => /\+(\d+)$/.exec(String(row['detail']))?.[1]).map(Number);
      if (
        !part ||
        quantities.some((quantity) => !Number.isInteger(quantity) || quantity < 1)
      ) {
        return { passed: false, reason: 'The restock audit did not contain enough evidence to reconstruct prior stock.' };
      }
      const before = Number(part['stock']) - quantities.reduce((sum, quantity) => sum + quantity, 0);
      if (before >= Number(part['reorder_level'])) {
        return {
          passed: false,
          reason: `${String(part['sku'])} was not below its reorder level before the restock.`,
          evidence: { before, reorderLevel: part['reorder_level'] },
        };
      }
      if (Number(part['stock']) < Number(part['reorder_level']) * 2) {
        return {
          passed: false,
          reason: 'The restocked part did not reach twice its reorder level.',
          evidence: { id: ids[0], stock: part['stock'], reorderLevel: part['reorder_level'] },
        };
      }
      return { passed: true, reason: `${String(part['sku'])} restocked to ${String(part['stock'])}.` };
    },
  },

  {
    id: 'settle-invoice',
    prompt:
      'Find invoice R-2026-0002 and record a payment that settles it in full. ' +
      'The system will not accept more than the outstanding amount.',
    skills: ['navigate', 'read-derived-amount', 'server-validation', 'recover-and-retry'],
    verify(db) {
      const inv = db.prepare('SELECT * FROM invoices WHERE number = ?').get('R-2026-0002') as Row | undefined;
      if (!inv) return { passed: false, notApplicable: true,
                         reason: 'Invoice R-2026-0002 is not in this dataset.' };
      if (String(inv['status']) !== 'Paid') {
        return {
          passed: false,
          reason: `Invoice status is "${inv['status']}"; outstanding is ${
            (Number(inv['total_cents']) - Number(inv['paid_cents'])) / 100
          } €.`,
        };
      }
      if (auditCount(db, 'invoice.pay', Number(inv['id'])) === 0) {
        return { passed: false, reason: 'Invoice is Paid but no payment was recorded through the app.' };
      }
      const payments = db
        .prepare("SELECT detail FROM audit WHERE action = 'invoice.pay' AND entity_id = ? ORDER BY id")
        .all(String(inv['id'])) as Row[];
      if (payments.length !== 1 || !String(payments[0]!['detail']).endsWith('-> Paid')) {
        return { passed: false, reason: `Expected one settling payment, found ${payments.length}.`, evidence: payments };
      }
      return { passed: true, reason: 'Invoice settled in full.', evidence: inv };
    },
  },

  {
    id: 'triage-ticket',
    prompt:
      'On the Tickets screen, set ticket T-1005 to priority "Urgent" and assign it to "M. Roth". ' +
      'Both fields are edited in place.',
    skills: ['inline-edit', 'double-click-to-edit', 'editor-absent-until-opened'],
    verify(db) {
      const t = db.prepare('SELECT * FROM tickets WHERE number = ?').get('T-1005') as Row | undefined;
      if (!t) return { passed: false, notApplicable: true,
                       reason: 'Ticket T-1005 is not in this dataset.' };
      // Audit is checked FIRST. The seed can land on the target values by
      // chance, and reporting "values are correct but…" in that case reads as
      // though the agent nearly succeeded when it has not started.
      const edits = db
        .prepare("SELECT detail FROM audit WHERE action = 'ticket.update' AND entity_id = ? ORDER BY id")
        .all(String(t['id'])) as Row[];
      const editedPriority = edits.some((row) => /^priority: .* -> Urgent$/.test(String(row['detail'])));
      const editedAssignee = edits.some((row) => /^assignee: .* -> M\. Roth$/.test(String(row['detail'])));
      if (edits.length !== 2 || !editedPriority || !editedAssignee) {
        return {
          passed: false,
          reason: `Both requested in-place edits were not recorded for T-1005 (currently ${String(t['priority'])} / ${String(t['assignee'])}).`,
          evidence: { ticket: t, edits },
        };
      }
      const problems: string[] = [];
      if (String(t['priority']) !== 'Urgent') problems.push(`priority is "${t['priority']}"`);
      if (String(t['assignee']) !== 'M. Roth') problems.push(`assignee is "${t['assignee']}"`);
      if (problems.length) return { passed: false, reason: problems.join(', ') + '.', evidence: t };
      return { passed: true, reason: 'Ticket triaged.', evidence: t };
    },
  },

  {
    id: 'query-three-conditions',
    prompt:
      'Use the report query builder to find customers that are in Germany, have status "Active", ' +
      'and a credit limit above 30000. Run the query.',
    skills: ['dynamic-form-rows', 'add-controls-that-do-not-exist-yet', 'compound-query'],
    verify(db) {
      const expected = Number(
        (db
          .prepare(
            "SELECT COUNT(*) AS n FROM customers WHERE country = 'Germany' AND status = 'Active' AND credit_limit > 30000",
          )
          .get() as Row).n,
      );
      const runs = db
        .prepare("SELECT entity_id, detail FROM audit WHERE action = 'report.query' ORDER BY id DESC")
        .all() as Row[];
      if (runs.length === 0) return { passed: false, reason: 'No query was ever run.' };

      const match = runs.find((r) => {
        const evidence = parseJsonObject(r['detail']);
        const filters = Array.isArray(evidence?.['filters']) ? evidence['filters'] : [];
        const actualConditions = filters
          .map((filter) => {
            if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return '';
            const row = filter as Row;
            return `${String(row['field'])}\u0000${String(row['op'])}\u0000${String(row['value'])}`;
          })
          .sort();
        const expectedConditions = [
          'country\u0000equals\u0000Germany',
          'status\u0000equals\u0000Active',
          'credit_limit\u0000>\u000030000',
        ].sort();
        return (
          String(r['entity_id']) === '3' &&
          evidence?.['match'] === 'all' &&
          Number(evidence['resultCount']) === expected &&
          actualConditions.length === expectedConditions.length &&
          actualConditions.every((condition, index) => condition === expectedConditions[index])
        );
      });
      if (!match) {
        return {
          passed: false,
          reason: 'A query ran, but not one combining country=Germany, status=Active and credit_limit>30000.',
          evidence: { lastRun: runs[0]?.['detail'], expectedCount: expected },
        };
      }
      return { passed: true, reason: `Query ran and matched ${expected} customers.`, evidence: { expected } };
    },
  },
);

const definitionIds = [...TASK_DEFINITIONS.map(({ id }) => id)].sort();
if (
  definitionIds.length !== TASK_ORACLE_CONTRACT_IDS.length ||
  definitionIds.some((id, index) => id !== TASK_ORACLE_CONTRACT_IDS[index])
) {
  throw new Error('Task definitions and explicit oracle contracts must have identical IDs.');
}

export const TASKS: Task[] = TASK_DEFINITIONS.map((definition) => ({
  id: definition.id,
  prompt: definition.prompt,
  skills: definition.skills,
  oracleVersion: taskOracleVersion(definition.id),
  verify(db) {
    return classify(definition.verify(db));
  },
}));

export function taskById(id: string): Task | undefined {
  return TASKS.find((t) => t.id === id);
}

export function verifyAll(db: DatabaseSync): Array<{ id: string; skills: string[] } & TaskResult> {
  return TASKS.map((t) => ({ id: t.id, skills: t.skills, ...t.verify(db) }));
}
