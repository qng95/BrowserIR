import { DatabaseSync } from 'node:sqlite';

/**
 * A real relational database behind the fixture app.
 *
 * The generator package produces synthetic DOM to measure how much of a page a
 * reader can see. That is necessary and not sufficient: it cannot tell you
 * whether an agent can DO anything, because nothing it renders has state. An
 * agent benchmark needs a system where an action changes something you can
 * later check without looking at the page at all — which is what this is for.
 *
 * In-memory by default so every run starts from an identical, reproducible
 * state. `reset()` restores it without restarting the process.
 */

/** Deterministic PRNG — the seed data must be identical on every run. */
class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]!;
  }
}

const SCHEMA = `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL
);

CREATE TABLE customers (
  id            INTEGER PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL,
  city          TEXT NOT NULL,
  country       TEXT NOT NULL,
  owner         TEXT NOT NULL,
  segment       TEXT NOT NULL,
  credit_limit  INTEGER NOT NULL,
  revenue       INTEGER NOT NULL,
  vat_id        TEXT,
  street        TEXT,
  postal_code   TEXT,
  last_contact  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_customers_status ON customers(status);

CREATE TABLE contacts (
  id            INTEGER PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL
);
CREATE INDEX idx_contacts_customer ON contacts(customer_id);

CREATE TABLE orders (
  id            INTEGER PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  number        TEXT NOT NULL UNIQUE,
  placed_on     TEXT NOT NULL,
  delivery_on   TEXT,
  vehicle       TEXT NOT NULL,
  status        TEXT NOT NULL,
  total_cents   INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_orders_customer ON orders(customer_id);

/* Inventory is deliberately large. A 12,000-row table cannot be rendered at
   once, so the vehicles screen has to virtualise — which makes row recycling,
   and the node-identity churn that comes with it, a property of a real screen
   rather than of a synthetic fixture. */
CREATE TABLE vehicles (
  id            INTEGER PRIMARY KEY,
  vin           TEXT NOT NULL UNIQUE,
  make          TEXT NOT NULL,
  model         TEXT NOT NULL,
  variant       TEXT NOT NULL,
  year          INTEGER NOT NULL,
  mileage_km    INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  status        TEXT NOT NULL,
  location      TEXT NOT NULL,
  fuel          TEXT NOT NULL,
  gearbox       TEXT NOT NULL,
  colour        TEXT NOT NULL
);
CREATE INDEX idx_vehicles_status ON vehicles(status);
CREATE INDEX idx_vehicles_make ON vehicles(make, model);

CREATE TABLE order_lines (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vehicle_id    INTEGER REFERENCES vehicles(id),
  description   TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  unit_cents    INTEGER NOT NULL
);
CREATE INDEX idx_lines_order ON order_lines(order_id);

/* A category tree. Self-referencing rather than a flat list, because the
   master-detail screens that dominate ERP software navigate a hierarchy and
   collapsed branches are genuinely absent from the DOM. */
CREATE TABLE part_categories (
  id            INTEGER PRIMARY KEY,
  parent_id     INTEGER REFERENCES part_categories(id),
  name          TEXT NOT NULL
);

CREATE TABLE parts (
  id            INTEGER PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES part_categories(id),
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  stock         INTEGER NOT NULL,
  reorder_level INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  supplier      TEXT NOT NULL
);
CREATE INDEX idx_parts_category ON parts(category_id);

/* Workshop scheduling. Appointments occupy a (bay, day, slot) cell and are
   moved by dragging — the one common enterprise interaction that no existing
   agent benchmark exercises at all. */
CREATE TABLE bays (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL
);

CREATE TABLE appointments (
  id            INTEGER PRIMARY KEY,
  bay_id        INTEGER NOT NULL REFERENCES bays(id),
  day           TEXT NOT NULL,
  slot          INTEGER NOT NULL,
  customer_id   INTEGER REFERENCES customers(id),
  description   TEXT NOT NULL,
  status        TEXT NOT NULL,
  UNIQUE (bay_id, day, slot)
);

CREATE TABLE invoices (
  id            INTEGER PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  order_id      INTEGER REFERENCES orders(id),
  issued_on     TEXT NOT NULL,
  due_on        TEXT NOT NULL,
  total_cents   INTEGER NOT NULL,
  paid_cents    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);

/* Service tickets. Priority and assignee are edited in place by double-clicking
   the cell — the interaction that a single isInteractive boolean cannot
   express, because the same cell both selects on click and edits on dblclick. */
CREATE TABLE tickets (
  id            INTEGER PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  subject       TEXT NOT NULL,
  priority      TEXT NOT NULL,
  status        TEXT NOT NULL,
  assignee      TEXT NOT NULL,
  opened_on     TEXT NOT NULL
);
CREATE INDEX idx_tickets_status ON tickets(status);

/* Every mutation is recorded. Task verification reads this as well as the row
   state, so "did the agent do it" can be distinguished from "was it already
   true", which is the difference between a real pass and a lucky one. */
CREATE TABLE audit (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  entity        TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  detail        TEXT
);
`;

const STATUSES = ['Active', 'Prospect', 'On hold', 'Churned'] as const;
const CITIES = ['München', 'Hamburg', 'Köln', 'Dresden', 'Essen', 'Bremen', 'Leipzig', 'Nürnberg'];
const COUNTRIES = ['Germany', 'Austria', 'Netherlands', 'Poland', 'France', 'Belgium'];
const OWNERS = ['S. Weber', 'A. Klein', 'M. Roth', 'J. Faber', 'L. Adler'];
const SEGMENTS = ['Fleet', 'Retail', 'Dealer', 'Key account'];
const STEMS = ['ACME', 'Nordwind', 'Bergmann', 'Vulkan', 'Rheinbau', 'Südpol', 'Kranich', 'Adler', 'Steinweg', 'Hanseat'];
const SUFFIXES = ['GmbH', 'AG', 'KG', 'SE', 'e.K.'];
const VEHICLES = ['Transporter 2.0 TDI', 'Caddy Cargo', 'Crafter 35 L3H3', 'Amarok Style', 'Multivan Life', 'ID. Buzz Cargo'];
const ORDER_STATUS = ['Draft', 'Awaiting deposit', 'Confirmed', 'In production', 'Delivered', 'Cancelled'] as const;
const CONTACT_ROLES = ['Managing director', 'Fleet manager', 'Accounts payable', 'Procurement', 'Workshop lead'];
const FIRST = ['Hans', 'Petra', 'Jonas', 'Sara', 'Mirko', 'Lena', 'Ulrich', 'Katrin'];
const LAST = ['Müller', 'Vogel', 'Beck', 'Lindqvist', 'Hoffmann', 'Krause', 'Sommer', 'Bauer'];

const MAKES: Array<[string, string[]]> = [
  ['Volkswagen', ['Transporter', 'Caddy', 'Crafter', 'Amarok', 'Multivan', 'ID. Buzz']],
  ['Mercedes-Benz', ['Sprinter', 'Vito', 'Citan', 'eVito']],
  ['Ford', ['Transit', 'Transit Custom', 'Ranger', 'Tourneo']],
  ['Renault', ['Master', 'Trafic', 'Kangoo']],
  ['Fiat', ['Ducato', 'Doblò', 'Scudo']],
  ['MAN', ['TGE', 'TGL']],
];
const VARIANTS = ['2.0 TDI', '2.0 TDI 4MOTION', '2.5 TDI L3H3', 'e-Drive 90 kW', '1.5 dCi', '2.2 HDi'];
const VEH_STATUS = ['In stock', 'Reserved', 'In transit', 'Sold', 'Demo'] as const;
const LOCATIONS = ['Hauptlager München', 'Filiale Hamburg', 'Filiale Köln', 'Aussenlager Essen', 'Werkstatt'];
const FUELS = ['Diesel', 'Petrol', 'Electric', 'Hybrid'];
const GEARBOXES = ['Manual', 'Automatic', 'DSG'];
const COLOURS = ['Candy White', 'Deep Black', 'Reflex Silver', 'Indium Grey', 'Cherry Red', 'Ravenna Blue'];

export const CUSTOMER_COUNT = 5000;
export const VEHICLE_COUNT = 12000;
export const DEFAULT_SEED = 20260728;

export interface SeedOptions {
  /** Fixed so two runs of the benchmark grade against identical data. */
  seed?: number;
  customers?: number;
  vehicles?: number;
}

export function createDb(opts: SeedOptions = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  seed(db, opts);
  return db;
}

export function reset(db: DatabaseSync, opts: SeedOptions = {}): void {
  // No sqlite_sequence reset: these tables use plain INTEGER PRIMARY KEY
  // (a rowid alias) rather than AUTOINCREMENT, so the table does not exist and
  // ids restart from 1 on their own once the rows are gone.
  db.exec(
    'DELETE FROM audit; DELETE FROM tickets; DELETE FROM invoices; DELETE FROM appointments; ' +
      'DELETE FROM bays; DELETE FROM parts; DELETE FROM part_categories; DELETE FROM order_lines; ' +
      'DELETE FROM orders; DELETE FROM contacts; DELETE FROM vehicles; DELETE FROM customers; DELETE FROM users;',
  );
  seed(db, opts);
}

function seed(db: DatabaseSync, opts: SeedOptions): void {
  const rng = new Rng(opts.seed ?? DEFAULT_SEED);
  const total = opts.customers ?? CUSTOMER_COUNT;

  const users = db.prepare('INSERT INTO users (username,password,display_name,role) VALUES (?,?,?,?)');
  // Plain-text credentials on purpose: this is a disposable local fixture and
  // the agent is *meant* to be able to log in with published credentials.
  // `test/test` is the documented account — memorable, and one less thing for
  // a task prompt to have to carry.
  users.run('test', 'test', 'S. Weber', 'sales');
  users.run('admin', 'admin', 'Admin', 'admin');

  const insCustomer = db.prepare(`
    INSERT INTO customers (number,name,status,city,country,owner,segment,credit_limit,revenue,
                           vat_id,street,postal_code,last_contact,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  db.exec('BEGIN');
  for (let i = 0; i < total; i++) {
    const name = `${rng.pick(STEMS)} ${rng.pick(SUFFIXES)}`;
    insCustomer.run(
      `K-${100000 + i}`,
      // Disambiguate duplicates so a task like "open Vulkan AG" has one answer.
      `${name}${i >= STEMS.length * SUFFIXES.length ? ' ' + (Math.floor(i / 50) + 1) : ''}`,
      rng.pick(STATUSES),
      rng.pick(CITIES),
      rng.pick(COUNTRIES),
      rng.pick(OWNERS),
      rng.pick(SEGMENTS),
      (rng.int(40) + 5) * 1000,
      (rng.int(900) + 100) * 100,
      `DE${100000000 + rng.int(899999999)}`,
      `${rng.pick(['Haupt', 'Bahnhof', 'Garten', 'Ring', 'Feld'])}strasse ${rng.int(180) + 1}`,
      String(10000 + rng.int(89999)),
      `2026-${String(rng.int(7) + 1).padStart(2, '0')}-${String(rng.int(27) + 1).padStart(2, '0')}`,
      `20${18 + rng.int(8)}-${String(rng.int(12) + 1).padStart(2, '0')}-11`,
    );
  }
  db.exec('COMMIT');

  // ---- vehicles ----------------------------------------------------------
  const insVehicle = db.prepare(`
    INSERT INTO vehicles (vin,make,model,variant,year,mileage_km,price_cents,status,location,fuel,gearbox,colour)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const vehicleTotal = opts.vehicles ?? VEHICLE_COUNT;
  db.exec('BEGIN');
  for (let i = 0; i < vehicleTotal; i++) {
    const [make, models] = rng.pick(MAKES);
    const year = 2018 + rng.int(9);
    insVehicle.run(
      // Deterministic pseudo-VIN: unique, and searchable by suffix.
      `WV1ZZZ${String(i).padStart(6, '0')}${(i * 7919) % 10}`,
      make,
      rng.pick(models),
      rng.pick(VARIANTS),
      year,
      rng.int(240000),
      (rng.int(6500) + 900) * 1000,
      rng.pick(VEH_STATUS),
      rng.pick(LOCATIONS),
      rng.pick(FUELS),
      rng.pick(GEARBOXES),
      rng.pick(COLOURS),
    );
  }
  db.exec('COMMIT');

  const insContact = db.prepare('INSERT INTO contacts (customer_id,name,role,email,phone) VALUES (?,?,?,?,?)');
  const insOrder = db.prepare(
    'INSERT INTO orders (customer_id,number,placed_on,vehicle,status,total_cents) VALUES (?,?,?,?,?,?)',
  );

  db.exec('BEGIN');
  let orderSeq = 0;
  const detailed = Math.min(total, 400);
  for (let cid = 1; cid <= detailed; cid++) {
    for (let c = 0; c < 2 + rng.int(3); c++) {
      const fn = rng.pick(FIRST);
      const ln = rng.pick(LAST);
      insContact.run(
        cid,
        `${fn} ${ln}`,
        rng.pick(CONTACT_ROLES),
        `${fn[0]!.toLowerCase()}.${ln.toLowerCase().replace(/[^a-z]/g, '')}@example.de`,
        `+49 ${89 + rng.int(10)} ${1000 + rng.int(8999)} ${10 + rng.int(89)}`,
      );
    }
    for (let o = 0; o < 1 + rng.int(5); o++) {
      insOrder.run(
        cid,
        `A-2026-${String(++orderSeq).padStart(4, '0')}`,
        `2026-${String(rng.int(7) + 1).padStart(2, '0')}-${String(rng.int(27) + 1).padStart(2, '0')}`,
        rng.pick(VEHICLES),
        rng.pick(ORDER_STATUS),
        (rng.int(600) + 180) * 10000,
      );
    }
  }
  db.exec('COMMIT');

  seedWorkshopAndParts(db, rng);
  seedBillingAndTickets(db, rng);
}

/** Category tree, parts, workshop bays and a week of appointments. */
function seedWorkshopAndParts(db: DatabaseSync, rng: Rng): void {
  const insCat = db.prepare('INSERT INTO part_categories (parent_id,name) VALUES (?,?)');
  const tree: Array<[string, string[]]> = [
    ['Engine', ['Filters', 'Belts & chains', 'Cooling', 'Turbo']],
    ['Brakes', ['Pads', 'Discs', 'Hydraulics']],
    ['Electrical', ['Batteries', 'Sensors', 'Lighting']],
    ['Body', ['Mirrors', 'Glass', 'Trim']],
    ['Consumables', ['Oils', 'Fluids', 'Fasteners']],
  ];
  const leafIds: number[] = [];
  for (const [parent, children] of tree) {
    const pid = Number(insCat.run(null, parent).lastInsertRowid);
    for (const child of children) leafIds.push(Number(insCat.run(pid, child).lastInsertRowid));
  }

  const insPart = db.prepare(
    'INSERT INTO parts (category_id,sku,name,stock,reorder_level,price_cents,supplier) VALUES (?,?,?,?,?,?,?)',
  );
  const NOUNS = ['kit', 'set', 'assembly', 'element', 'cartridge', 'module', 'unit', 'pack'];
  const SUPPLIERS = ['Bosch', 'Mahle', 'Valeo', 'Hella', 'Febi', 'SKF'];
  db.exec('BEGIN');
  let sku = 0;
  for (const cid of leafIds) {
    for (let i = 0; i < 6 + rng.int(10); i++) {
      const stock = rng.int(120);
      insPart.run(
        cid,
        `P-${String(++sku).padStart(5, '0')}`,
        `${rng.pick(SUPPLIERS)} ${rng.pick(NOUNS)} ${1000 + rng.int(8999)}`,
        stock,
        // Some parts sit below their reorder level; a task can ask for those.
        Math.max(5, Math.floor(stock * (rng.next() < 0.25 ? 1.6 : 0.4))),
        (rng.int(400) + 8) * 100,
        rng.pick(SUPPLIERS),
      );
    }
  }
  db.exec('COMMIT');

  const insBay = db.prepare('INSERT INTO bays (name) VALUES (?)');
  const bayIds = ['Bay 1', 'Bay 2', 'Bay 3', 'Bay 4'].map((n) => Number(insBay.run(n).lastInsertRowid));

  const insAppt = db.prepare(
    'INSERT INTO appointments (bay_id,day,slot,customer_id,description,status) VALUES (?,?,?,?,?,?)',
  );
  const JOBS = ['Service A', 'Service B', 'Brake inspection', 'Tyre change', 'Diagnostics', 'MOT prep', 'Warranty repair'];
  const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'];
  // Bounded by the customers that actually exist. Hardcoding a range broke the
  // foreign key on any reduced fixture, which is exactly the configuration the
  // faster test suites use.
  const maxCustomer = Number(
    (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM customers').get() as Record<string, unknown>).n,
  );
  db.exec('BEGIN');
  for (const bay of bayIds) {
    for (const day of days) {
      for (let slot = 0; slot < 4; slot++) {
        // Leave gaps: a drag target has to be an empty cell.
        if (rng.next() < 0.45) continue;
        insAppt.run(bay, day, slot, maxCustomer ? 1 + rng.int(maxCustomer) : null, rng.pick(JOBS), 'Scheduled');
      }
    }
  }
  db.exec('COMMIT');
}

/** Invoices derived from existing orders, plus a backlog of service tickets. */
function seedBillingAndTickets(db: DatabaseSync, rng: Rng): void {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id').all() as Array<Record<string, unknown>>;
  const insInv = db.prepare(
    `INSERT INTO invoices (number,customer_id,order_id,issued_on,due_on,total_cents,paid_cents,status)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  db.exec('BEGIN');
  let n = 0;
  for (const o of orders) {
    // Only invoiced once an order has progressed past draft.
    if (o['status'] === 'Draft' || o['status'] === 'Cancelled') continue;
    n++;
    const total = Number(o['total_cents']);
    const roll = rng.next();
    // A deliberate mix: some paid, some partially paid, some overdue and unpaid.
    const paid = roll < 0.45 ? total : roll < 0.65 ? Math.floor(total * 0.3) : 0;
    const status = paid >= total ? 'Paid' : paid > 0 ? 'Part paid' : rng.next() < 0.5 ? 'Overdue' : 'Open';
    const issued = String(o['placed_on']);
    const due = `${issued.slice(0, 8)}${String(Math.min(28, Number(issued.slice(8)) + 14)).padStart(2, '0')}`;
    insInv.run(
      `R-2026-${String(n).padStart(4, '0')}`,
      Number(o['customer_id']),
      Number(o['id']),
      issued,
      due,
      total,
      paid,
      status,
    );
  }
  db.exec('COMMIT');

  const insTicket = db.prepare(
    'INSERT INTO tickets (number,customer_id,subject,priority,status,assignee,opened_on) VALUES (?,?,?,?,?,?,?)',
  );
  const SUBJECTS = [
    'Warning light on dashboard', 'Air conditioning not cooling', 'Noise from front axle',
    'Infotainment reboot loop', 'Tailgate will not close', 'Requesting service quote',
    'Brake pedal travel', 'Key fob unresponsive', 'Oil leak reported',
  ];
  const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
  const TICKET_STATUS = ['New', 'In progress', 'Waiting for parts', 'Resolved'];
  const ASSIGNEES = ['S. Weber', 'A. Klein', 'M. Roth', 'Unassigned'];
  const maxCustomer = Number(
    (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM customers').get() as Record<string, unknown>).n,
  );

  db.exec('BEGIN');
  for (let i = 0; i < 140 && maxCustomer > 0; i++) {
    insTicket.run(
      `T-${String(1000 + i)}`,
      1 + rng.int(maxCustomer),
      rng.pick(SUBJECTS),
      rng.pick(PRIORITIES),
      rng.pick(TICKET_STATUS),
      rng.pick(ASSIGNEES),
      `2026-0${1 + rng.int(7)}-${String(1 + rng.int(27)).padStart(2, '0')}`,
    );
  }
  // Keep the inline-edit qualification actionable. Its oracle requires one
  // audited transition for each requested target, while the UI correctly
  // declines to submit a same-value edit. Apply this after generation so the
  // seeded RNG sequence—and every unrelated record—stays unchanged.
  db.prepare(
    "UPDATE tickets SET priority = 'Normal', assignee = 'Unassigned' WHERE number = 'T-1005'",
  ).run();
  db.exec('COMMIT');
}

export function audit(
  db: DatabaseSync,
  entry: { actor: string; action: string; entity: string; entityId: string | number; detail?: string },
): void {
  db.prepare('INSERT INTO audit (at,actor,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?)').run(
    new Date().toISOString(),
    entry.actor,
    entry.action,
    entry.entity,
    String(entry.entityId),
    entry.detail ?? null,
  );
}

export function money(cents: number): string {
  return `${String(Math.round(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;
}
