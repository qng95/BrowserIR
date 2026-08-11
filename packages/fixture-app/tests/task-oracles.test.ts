import { describe, expect, it } from 'vitest';

import { audit, createDb } from '../src/db.js';
import { taskById } from '../src/tasks.js';

type Row = Record<string, unknown>;

function task(id: string) {
  const found = taskById(id);
  if (!found) throw new Error(`Missing task ${id}`);
  return found;
}

function cancelIndividually(db: ReturnType<typeof createDb>, ids: number[]): void {
  for (const id of ids) {
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as Row;
    db.prepare("UPDATE orders SET status = 'Cancelled' WHERE id = ?").run(id);
    audit(db, {
      actor: 'test',
      action: 'order.cancel',
      entity: 'order',
      entityId: id,
      detail: `${String(order['status'])} -> Cancelled`,
    });
  }
}

function cancelInOneBulkOperation(db: ReturnType<typeof createDb>, ids: number[]): void {
  const transitions: Array<{ id: number; before: string; after: 'Cancelled' }> = [];
  for (const id of ids) {
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as Row;
    const before = String(order['status']);
    db.prepare("UPDATE orders SET status = 'Cancelled' WHERE id = ?").run(id);
    audit(db, {
      actor: 'test',
      action: 'order.cancel',
      entity: 'order',
      entityId: id,
      detail: `${before} -> Cancelled`,
    });
    transitions.push({ id, before, after: 'Cancelled' });
  }
  audit(db, {
    actor: 'test',
    action: 'order.bulk.cancel',
    entity: 'orders',
    entityId: ids.length,
    detail: JSON.stringify({ action: 'cancel', ids, transitions }),
  });
}

function recordRejectedCustomerCreate(
  db: ReturnType<typeof createDb>,
  name: string,
  attemptedCreditLimit: number,
): void {
  audit(db, {
    actor: 'test',
    action: 'customer.create.rejected',
    entity: 'customer',
    entityId: name,
    detail: JSON.stringify({
      reason: 'credit_limit_above_ceiling',
      name,
      attemptedCreditLimit,
      maximumCreditLimit: 250000,
    }),
  });
}

function recordCustomerCreate(db: ReturnType<typeof createDb>, id: number, name: string): void {
  audit(db, {
    actor: 'test',
    action: 'customer.create',
    entity: 'customer',
    entityId: id,
    detail: name,
  });
}

function recordQuery(
  db: ReturnType<typeof createDb>,
  filters: Array<{ field: string; op: string; value: string }>,
  resultCount: number,
  match: 'all' | 'any' = 'all',
): void {
  audit(db, {
    actor: 'test',
    action: 'report.query',
    entity: 'query',
    entityId: filters.length,
    detail: JSON.stringify({ match, filters, resultCount }),
  });
}

function deliver(
  db: ReturnType<typeof createDb>,
  number: string,
  detailBefore?: string,
): Row {
  const order = db.prepare('SELECT * FROM orders WHERE number = ?').get(number) as Row;
  db.prepare("UPDATE orders SET status = 'Delivered' WHERE id = ?").run(Number(order['id']));
  audit(db, {
    actor: 'test',
    action: 'order.deliver',
    entity: 'order',
    entityId: Number(order['id']),
    detail: `${detailBefore ?? String(order['status'])} -> Delivered`,
  });
  return order;
}

function createWizardOrder(db: ReturnType<typeof createDb>, deliveryOn: string): void {
  const customer = db.prepare("SELECT id FROM customers WHERE number = 'K-100032'").get() as Row;
  const vehicle = db.prepare("SELECT * FROM vehicles WHERE status = 'In stock' ORDER BY id LIMIT 1").get() as Row;
  const number = `A-TASK-${deliveryOn.replaceAll('-', '')}`;
  const created = db
    .prepare(
      `INSERT INTO orders
       (customer_id,number,placed_on,delivery_on,vehicle,status,total_cents)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      Number(customer['id']),
      number,
      '2026-08-10',
      deliveryOn,
      `${String(vehicle['make'])} ${String(vehicle['model'])}`,
      'Confirmed',
      Number(vehicle['price_cents']),
    );
  const orderId = Number(created.lastInsertRowid);
  db.prepare(
    'INSERT INTO order_lines (order_id,vehicle_id,description,qty,unit_cents) VALUES (?,?,?,?,?)',
  ).run(orderId, Number(vehicle['id']), String(vehicle['vin']), 1, Number(vehicle['price_cents']));
  db.prepare("UPDATE vehicles SET status = 'Reserved' WHERE id = ?").run(Number(vehicle['id']));
  audit(db, { actor: 'test', action: 'order.create', entity: 'order', entityId: orderId, detail: number });
  audit(db, {
    actor: 'test',
    action: 'vehicle.reserve',
    entity: 'vehicle',
    entityId: Number(vehicle['id']),
    detail: `In stock -> Reserved; order ${number}`,
  });
}

function insertTaskCustomer(
  db: ReturnType<typeof createDb>,
  name: string,
  creditLimit: number,
  city: string,
  vatId: string | null,
): number {
  const count = Number((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as Row)['n']);
  const result = db
    .prepare(
      `INSERT INTO customers
       (number,name,status,city,country,owner,segment,credit_limit,revenue,vat_id,street,postal_code,last_contact,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `K-TASK-${count}`,
      name,
      'Prospect',
      city,
      'Germany',
      'test',
      'Retail',
      creditLimit,
      0,
      vatId,
      null,
      null,
      '2026-08-10',
      '2026-08-10',
    );
  return Number(result.lastInsertRowid);
}

describe('task oracle contracts', () => {
  it('uses a structured not-applicable outcome instead of encoding it in a failure reason', () => {
    const db = createDb({ customers: 100, vehicles: 100 });
    const result = task('find-vin-deep-in-inventory').verify(db);

    expect(result).toMatchObject({ outcome: 'not_applicable', passed: false });
    db.close();
  });

  it('requires the wizard order to persist the requested delivery date and linked audits', () => {
    const wrong = createDb({ customers: 100, vehicles: 100 });
    createWizardOrder(wrong, '2026-09-29');
    expect(task('order-through-wizard').verify(wrong).passed).toBe(false);
    wrong.close();

    const correct = createDb({ customers: 100, vehicles: 100 });
    createWizardOrder(correct, '2026-09-30');
    expect(task('order-through-wizard').verify(correct)).toMatchObject({ outcome: 'passed', passed: true });
    correct.close();
  });

  it('accepts exactly the first filtered Draft page, not an arbitrary set of cancellations', () => {
    const wrong = createDb({ customers: 100, vehicles: 100 });
    const unrelated = wrong
      .prepare("SELECT id FROM orders WHERE status != 'Draft' ORDER BY id LIMIT 5")
      .all()
      .map((row) => Number((row as Row)['id']));
    cancelInOneBulkOperation(wrong, unrelated);
    expect(task('bulk-cancel-drafts').verify(wrong).passed).toBe(false);
    wrong.close();

    const perRow = createDb({ customers: 100, vehicles: 100 });
    const perRowFirstPage = perRow
      .prepare("SELECT id FROM orders WHERE status = 'Draft' ORDER BY placed_on DESC, id DESC LIMIT 25")
      .all()
      .map((row) => Number((row as Row)['id']));
    cancelIndividually(perRow, perRowFirstPage);
    expect(task('bulk-cancel-drafts').verify(perRow).passed).toBe(false);
    perRow.close();

    const correct = createDb({ customers: 100, vehicles: 100 });
    const firstPage = correct
      .prepare("SELECT id FROM orders WHERE status = 'Draft' ORDER BY placed_on DESC, id DESC LIMIT 25")
      .all()
      .map((row) => Number((row as Row)['id']));
    cancelInOneBulkOperation(correct, firstPage);
    expect(task('bulk-cancel-drafts').verify(correct)).toMatchObject({ outcome: 'passed', passed: true });
    correct.close();
  });

  it('requires validation recovery to prove the requested over-limit rejection preceded creation', () => {
    const noRejection = createDb({ customers: 100, vehicles: 100 });
    const noRejectionId = insertTaskCustomer(noRejection, 'Nordlicht Spedition', 250000, 'Bremen', null);
    recordCustomerCreate(noRejection, noRejectionId, 'Nordlicht Spedition');
    expect(task('validation-recovery').verify(noRejection).passed).toBe(false);
    noRejection.close();

    const rejectionAfterCreation = createDb({ customers: 100, vehicles: 100 });
    const lateId = insertTaskCustomer(rejectionAfterCreation, 'Nordlicht Spedition', 250000, 'Bremen', null);
    recordCustomerCreate(rejectionAfterCreation, lateId, 'Nordlicht Spedition');
    recordRejectedCustomerCreate(rejectionAfterCreation, 'Nordlicht Spedition', 400000);
    expect(task('validation-recovery').verify(rejectionAfterCreation).passed).toBe(false);
    rejectionAfterCreation.close();

    const wrongAttempt = createDb({ customers: 100, vehicles: 100 });
    recordRejectedCustomerCreate(wrongAttempt, 'Nordlicht Spedition', 300000);
    const wrongAttemptId = insertTaskCustomer(wrongAttempt, 'Nordlicht Spedition', 250000, 'Bremen', null);
    recordCustomerCreate(wrongAttempt, wrongAttemptId, 'Nordlicht Spedition');
    expect(task('validation-recovery').verify(wrongAttempt).passed).toBe(false);
    wrongAttempt.close();

    const correct = createDb({ customers: 100, vehicles: 100 });
    recordRejectedCustomerCreate(correct, 'Nordlicht Spedition', 400000);
    const id = insertTaskCustomer(correct, 'Nordlicht Spedition', 250000, 'Bremen', null);
    recordCustomerCreate(correct, id, 'Nordlicht Spedition');
    expect(task('validation-recovery').verify(correct)).toMatchObject({ outcome: 'passed', passed: true });
    correct.close();
  });

  it('requires one genuine target delivery and rejects near misses or collateral deliveries', () => {
    const untouched = createDb({ customers: 100, vehicles: 100 });
    expect(task('mark-order-delivered').verify(untouched).passed).toBe(false);
    untouched.close();

    const sameState = createDb({ customers: 100, vehicles: 100 });
    deliver(sameState, 'A-2026-0007', 'Delivered');
    expect(task('mark-order-delivered').verify(sameState).passed).toBe(false);
    sameState.close();

    const wrongOrder = createDb({ customers: 100, vehicles: 100 });
    wrongOrder.prepare("UPDATE orders SET status = 'Delivered' WHERE number = 'A-2026-0007'").run();
    const other = wrongOrder
      .prepare("SELECT number FROM orders WHERE number != 'A-2026-0007' AND status != 'Delivered' ORDER BY id LIMIT 1")
      .get() as Row;
    deliver(wrongOrder, String(other['number']));
    expect(task('mark-order-delivered').verify(wrongOrder).passed).toBe(false);
    wrongOrder.close();

    const collateral = createDb({ customers: 100, vehicles: 100 });
    deliver(collateral, 'A-2026-0007');
    const collateralOrder = collateral
      .prepare("SELECT number FROM orders WHERE number != 'A-2026-0007' AND status != 'Delivered' ORDER BY id LIMIT 1")
      .get() as Row;
    deliver(collateral, String(collateralOrder['number']));
    expect(task('mark-order-delivered').verify(collateral).passed).toBe(false);
    collateral.close();

    const correct = createDb({ customers: 100, vehicles: 100 });
    deliver(correct, 'A-2026-0007');
    expect(task('mark-order-delivered').verify(correct)).toMatchObject({ outcome: 'passed', passed: true });
    correct.close();
  });

  it('requires the exact 13:00 Bay 1 appointment to be moved into Bay 4', () => {
    const db = createDb({ customers: 100, vehicles: 100 });
    const bay1 = Number((db.prepare("SELECT id FROM bays WHERE name = 'Bay 1'").get() as Row)['id']);
    const bay4 = Number((db.prepare("SELECT id FROM bays WHERE name = 'Bay 4'").get() as Row)['id']);
    const source = db
      .prepare("SELECT id FROM appointments WHERE bay_id = ? AND day = '2026-08-03' AND slot = 2")
      .get(bay1) as Row | undefined;
    if (!source) {
      db.prepare(
        "INSERT INTO appointments (bay_id,day,slot,customer_id,description,status) VALUES (?,'2026-08-03',2,1,'Task target','Scheduled')",
      ).run(bay1);
    }
    const wrongAppointment = db
      .prepare('SELECT * FROM appointments WHERE NOT (bay_id = ? AND day = ? AND slot = ?) ORDER BY id LIMIT 1')
      .get(bay1, '2026-08-03', 2) as Row;
    const free = db
      .prepare(
        `SELECT d.day, s.slot FROM
         (SELECT '2026-08-03' AS day UNION ALL SELECT '2026-08-04' UNION ALL SELECT '2026-08-05') d
         CROSS JOIN (SELECT 0 AS slot UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) s
         WHERE NOT EXISTS (
           SELECT 1 FROM appointments a WHERE a.bay_id = ? AND a.day = d.day AND a.slot = s.slot
         ) LIMIT 1`,
      )
      .get(bay4) as Row;
    db.prepare('UPDATE appointments SET bay_id = ?, day = ?, slot = ? WHERE id = ?').run(
      bay4,
      String(free['day']),
      Number(free['slot']),
      Number(wrongAppointment['id']),
    );
    audit(db, {
      actor: 'test',
      action: 'appointment.move',
      entity: 'appointment',
      entityId: Number(wrongAppointment['id']),
      detail: `bay ${String(wrongAppointment['bay_id'])}/${String(wrongAppointment['day'])}/${String(wrongAppointment['slot'])} -> bay ${bay4}/${String(free['day'])}/${String(free['slot'])} via drag`,
    });

    expect(task('reschedule-appointment').verify(db).passed).toBe(false);
    db.close();
  });

  it('only credits a restock when the chosen part was initially below its reorder level', () => {
    const db = createDb({ customers: 100, vehicles: 100 });
    const part = db
      .prepare('SELECT * FROM parts WHERE stock >= reorder_level ORDER BY id LIMIT 1')
      .get() as Row;
    const qty = Math.max(1, Number(part['reorder_level']) * 2 - Number(part['stock']));
    db.prepare('UPDATE parts SET stock = stock + ? WHERE id = ?').run(qty, Number(part['id']));
    audit(db, {
      actor: 'test',
      action: 'part.restock',
      entity: 'part',
      entityId: Number(part['id']),
      detail: `${String(part['sku'])} +${qty}`,
    });

    expect(task('restock-low-part').verify(db).passed).toBe(false);
    db.close();
  });

  it('requires customer creation tasks to have a matching application audit', () => {
    const db = createDb({ customers: 100, vehicles: 100 });
    insertTaskCustomer(db, 'Steinweg Logistik GmbH', 30000, 'Leipzig', 'DE145879632');
    insertTaskCustomer(db, 'Nordlicht Spedition', 250000, 'Bremen', null);

    expect(task('create-customer').verify(db).passed).toBe(false);
    expect(task('validation-recovery').verify(db).passed).toBe(false);
    db.close();
  });

  it('rejects a credit-limit edit that also changes another field', () => {
    const db = createDb({ customers: 100, vehicles: 100 });
    const customer = db.prepare("SELECT * FROM customers WHERE number = 'K-100042'").get() as Row;
    db.prepare("UPDATE customers SET credit_limit = 45000, city = 'Wrong city' WHERE id = ?").run(Number(customer['id']));
    audit(db, {
      actor: 'test',
      action: 'customer.update',
      entity: 'customer',
      entityId: Number(customer['id']),
      detail: JSON.stringify({
        changed: ['city', 'credit_limit'],
        before: { city: customer['city'], credit_limit: customer['credit_limit'] },
        after: { city: 'Wrong city', credit_limit: 45000 },
      }),
    });

    expect(task('raise-credit-limit').verify(db).passed).toBe(false);
    db.close();
  });

  it('requires the highest-revenue status change itself to be audited', () => {
    const db = createDb({ customers: 100, vehicles: 100 });
    const target = db
      .prepare("SELECT * FROM customers WHERE country = 'Poland' ORDER BY revenue DESC, id ASC LIMIT 1")
      .get() as Row;
    db.prepare("UPDATE customers SET status = 'Active' WHERE id = ?").run(Number(target['id']));
    audit(db, {
      actor: 'test',
      action: 'customer.update',
      entity: 'customer',
      entityId: Number(target['id']),
      detail: JSON.stringify({
        changed: ['city'],
        before: { city: target['city'] },
        after: { city: target['city'] },
      }),
    });

    expect(task('highest-revenue-poland').verify(db).passed).toBe(false);
    db.close();
  });

  it('reconstructs the initially cheapest in-stock vehicle instead of comparing seeded Reserved vehicles', () => {
    const wrong = createDb({ customers: 100, vehicles: 100 });
    const candidates = wrong
      .prepare("SELECT * FROM vehicles WHERE status = 'In stock' ORDER BY price_cents, id LIMIT 2")
      .all() as Row[];
    const nonCheapest = candidates[1]!;
    wrong.prepare("UPDATE vehicles SET status = 'Reserved' WHERE id = ?").run(Number(nonCheapest['id']));
    audit(wrong, {
      actor: 'test',
      action: 'vehicle.status',
      entity: 'vehicle',
      entityId: Number(nonCheapest['id']),
      detail: 'In stock → Reserved',
    });
    expect(task('reserve-cheapest-in-stock').verify(wrong).passed).toBe(false);
    wrong.close();

    const correct = createDb({ customers: 100, vehicles: 100 });
    const cheapest = correct
      .prepare("SELECT * FROM vehicles WHERE status = 'In stock' ORDER BY price_cents, id LIMIT 1")
      .get() as Row;
    // A vehicle that was already Reserved is irrelevant to the prompt, even
    // when its price is lower than every initially in-stock vehicle.
    correct.prepare("UPDATE vehicles SET price_cents = 1 WHERE status = 'Reserved'").run();
    correct.prepare("UPDATE vehicles SET status = 'Reserved' WHERE id = ?").run(Number(cheapest['id']));
    audit(correct, {
      actor: 'test',
      action: 'vehicle.status',
      entity: 'vehicle',
      entityId: Number(cheapest['id']),
      detail: 'In stock → Reserved',
    });
    expect(task('reserve-cheapest-in-stock').verify(correct)).toMatchObject({ outcome: 'passed', passed: true });
    correct.close();
  });

  it('starts the inline ticket task away from both targets and requires both audited edits', () => {
    const db = createDb({ customers: 100, vehicles: 100 });
    const ticket = db.prepare("SELECT * FROM tickets WHERE number = 'T-1005'").get() as Row;
    expect(ticket['priority']).not.toBe('Urgent');
    expect(ticket['assignee']).not.toBe('M. Roth');
    db.prepare("UPDATE tickets SET priority = 'Urgent', assignee = 'M. Roth' WHERE id = ?").run(Number(ticket['id']));
    audit(db, {
      actor: 'test',
      action: 'ticket.update',
      entity: 'ticket',
      entityId: Number(ticket['id']),
      detail: `priority: ${String(ticket['priority'])} -> Urgent`,
    });

    expect(task('triage-ticket').verify(db).passed).toBe(false);
    audit(db, {
      actor: 'test',
      action: 'ticket.update',
      entity: 'ticket',
      entityId: Number(ticket['id']),
      detail: `assignee: ${String(ticket['assignee'])} -> M. Roth`,
    });
    expect(task('triage-ticket').verify(db)).toMatchObject({ outcome: 'passed', passed: true });
    db.close();
  });

  it('requires exactly the requested query conditions even when another query has the same count', () => {
    const queryDb = createDb({ customers: 100, vehicles: 100 });
    const expected = Number(
      (queryDb
        .prepare(
          "SELECT COUNT(*) AS n FROM customers WHERE country = 'Germany' AND status = 'Active' AND credit_limit > 30000",
        )
        .get() as Row)['n'],
    );
    const required = [
      { field: 'country', op: 'equals', value: 'Germany' },
      { field: 'status', op: 'equals', value: 'Active' },
      { field: 'credit_limit', op: '>', value: '30000' },
    ];
    recordQuery(queryDb, [...required, { field: 'city', op: 'equals', value: 'Berlin' }], expected);
    expect(task('query-three-conditions').verify(queryDb).passed).toBe(false);
    queryDb.close();

    const differentDb = createDb({ customers: 100, vehicles: 100 });
    recordQuery(
      differentDb,
      [
        { field: 'country', op: 'equals', value: 'Germany' },
        { field: 'status', op: 'equals', value: 'Active' },
        { field: 'revenue', op: '>', value: '30000' },
      ],
      expected,
    );
    expect(task('query-three-conditions').verify(differentDb).passed).toBe(false);
    differentDb.close();

    const wrongCountDb = createDb({ customers: 100, vehicles: 100 });
    recordQuery(wrongCountDb, required, expected + 1);
    expect(task('query-three-conditions').verify(wrongCountDb).passed).toBe(false);
    wrongCountDb.close();

    const correctDb = createDb({ customers: 100, vehicles: 100 });
    recordQuery(correctDb, [required[2]!, required[0]!, required[1]!], expected);
    expect(task('query-three-conditions').verify(correctDb)).toMatchObject({ outcome: 'passed', passed: true });
    correctDb.close();
  });

  it('rejects multi-payment settlement', () => {
    const invoiceDb = createDb({ customers: 100, vehicles: 100 });
    const invoice = invoiceDb.prepare("SELECT * FROM invoices WHERE number = 'R-2026-0002'").get() as Row;
    invoiceDb.prepare("UPDATE invoices SET paid_cents = total_cents, status = 'Paid' WHERE id = ?").run(Number(invoice['id']));
    for (const amount of ['1.000 € -> Part paid', '1.000 € -> Paid']) {
      audit(invoiceDb, {
        actor: 'test',
        action: 'invoice.pay',
        entity: 'invoice',
        entityId: Number(invoice['id']),
        detail: amount,
      });
    }
    expect(task('settle-invoice').verify(invoiceDb).passed).toBe(false);
    invoiceDb.close();
  });
});
