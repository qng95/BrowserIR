import { afterEach, describe, expect, it } from 'vitest';

import { createDb } from '../src/db.js';
import { validateCustomer } from '../src/pages.js';

const openDatabases: ReturnType<typeof createDb>[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

const validValues = (name: string): Record<string, string> => ({
  name,
  city: 'Berlin',
  country: 'Germany',
  status: 'Prospect',
  credit_limit: '12000',
  vat_id: '',
});

describe('customer edit validation', () => {
  it('allows a seeded duplicate name to remain unchanged on its own record', () => {
    const db = createDb({ customers: 3, vehicles: 1 });
    openDatabases.push(db);
    const first = db
      .prepare('SELECT id, name FROM customers ORDER BY id LIMIT 1')
      .get() as { id: number; name: string };
    const second = db
      .prepare('SELECT id FROM customers ORDER BY id LIMIT 1 OFFSET 1')
      .get() as { id: number };
    db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(
      first.name,
      second.id,
    );

    expect(validateCustomer(validValues(first.name), db, first.id)).not.toHaveProperty(
      'name',
    );
  });

  it('still rejects changing a record to another customer name', () => {
    const db = createDb({ customers: 3, vehicles: 1 });
    openDatabases.push(db);
    const first = db
      .prepare('SELECT id, name FROM customers ORDER BY id LIMIT 1')
      .get() as { id: number; name: string };
    const second = db
      .prepare('SELECT id FROM customers ORDER BY id LIMIT 1 OFFSET 1')
      .get() as { id: number };

    expect(validateCustomer(validValues(first.name), db, second.id)).toMatchObject({
      name: 'A customer with this name already exists.',
    });
  });
});
