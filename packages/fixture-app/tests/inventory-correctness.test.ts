import { describe, expect, it } from 'vitest';

import { createDb } from '../src/db.js';
import { csvCell, customerExportCsv } from '../src/jobs.js';
import { filterBuilderPage } from '../src/reports.js';
import { parseDepositCents } from '../src/wizard.js';

describe('customer CSV export', () => {
  it('escapes every CSV metacharacter and includes every database row', () => {
    const db = createDb({ customers: 7, vehicles: 10 });
    db.prepare('UPDATE customers SET name = ?, city = ? WHERE id = 1')
      .run('ACME, "North"\nDepot', 'Paris\r\nCentre');

    const csv = customerExportCsv(db);
    const numbers = db.prepare('SELECT number FROM customers ORDER BY id').all() as Array<{ number: string }>;
    expect(csv.startsWith('number,name,status,city,country\r\n')).toBe(true);
    expect(csv).toContain('"ACME, ""North""\nDepot"');
    expect(csv).toContain('"Paris\r\nCentre"');
    for (const { number } of numbers) expect(csv).toContain(`${number},`);
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('=HYPERLINK("https://example.invalid")')).toBe(
      '"\'=HYPERLINK(""https://example.invalid"")"',
    );
    expect(csvCell('+SUM(1,2)')).toBe('"\'+SUM(1,2)"');
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('@payload')).toBe("'@payload");
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    db.close();
  });
});

describe('wizard amount persistence contract', () => {
  it('parses euro amounts into exact cents and rejects ambiguous precision', () => {
    expect(parseDepositCents(undefined)).toBe(0);
    expect(parseDepositCents('5000')).toBe(500_000);
    expect(parseDepositCents('12.34')).toBe(1_234);
    expect(parseDepositCents('-1')).toBeUndefined();
    expect(parseDepositCents('1.234')).toBeUndefined();
    expect(parseDepositCents('Infinity')).toBeUndefined();
  });
});

describe('query builder server rerender', () => {
  it('renders submitted enum rows as selects and numeric rows as number inputs', () => {
    const db = createDb({ customers: 10, vehicles: 10 });
    const submitted = new URLSearchParams();
    submitted.set('run', '1');
    submitted.set('match', 'all');
    submitted.append('f_field', 'status');
    submitted.append('f_op', 'equals');
    submitted.append('f_value', 'Active');
    submitted.append('f_field', 'credit_limit');
    submitted.append('f_op', '>');
    submitted.append('f_value', '30000');

    const html = filterBuilderPage(
      { db, path: '/app/reports/query', url: new URL('http://localhost/app/reports/query') },
      submitted,
    );
    expect(html).toMatch(/<select name="f_value" aria-label="Value 1">[\s\S]*value="Active" selected/);
    expect(html).toContain('name="f_value" type="number" value="30000" aria-label="Value 2"');
    db.close();
  });
});
