// The relational system of record: schema, deterministic seed, deterministic
// activity, durable switches and bookings, and the ground-truth report.
//
// The data is awkward on purpose: free-text status spellings, a nullable
// foreign key, one date column in two formats, and a soft-delete column.

import pg from "pg";
import type { Chaos } from "./chaos.ts";
import {
  CARRIER_COUNT,
  type Carrier,
  replayBooking,
  type Booking,
  type BookingRequest,
  type BookingResult,
} from "./portal.ts";
import { isoDate, rng } from "./rng.ts";

type Cell = string | number | null;
type ColumnType = "int" | "text" | "numeric";

interface TableSpec {
  name: string;
  columns: readonly { name: string; type: ColumnType; ddl: string }[];
  count(shipments: number): number;
  /** Row with primary key `id` (1-based). Pure in (seed, id). */
  row(seed: number, id: number, shipments: number): Cell[];
}

const STATUSES = ["DELIVERED", "delivered", "In Transit", "IN_TRANSIT", "DELAYED", "delayed ", "EXCEPTION"] as const;
const REASONS = ["weather", "address not found", "customs hold", "vehicle breakdown", "recipient absent"] as const;
const CITIES = ["Hamburg", "Rotterdam", "Gdansk", "Lyon", "Milano", "Wien", "Praha", "Antwerpen"] as const;

const customerCount = (n: number): number => Math.max(20, Math.floor(n / 50));
const orderCount = (n: number): number => Math.ceil(n / 2);

const TABLES: readonly TableSpec[] = [
  {
    name: "customers",
    columns: [
      { name: "id", type: "int", ddl: "integer PRIMARY KEY" },
      { name: "name", type: "text", ddl: "text NOT NULL" },
      { name: "city", type: "text", ddl: "text NOT NULL" },
      { name: "deleted_at", type: "text", ddl: "text" },
    ],
    count: customerCount,
    row: (seed, id) => {
      const r = rng(seed, 1, id);
      return [id, `${r.pick(["Kontor", "Werk", "Handel", "Atelier"])} ${r.pick(CITIES)} ${id}`, r.pick(CITIES), null];
    },
  },
  {
    name: "orders",
    columns: [
      { name: "id", type: "int", ddl: "integer PRIMARY KEY" },
      { name: "customer_id", type: "int", ddl: "integer NOT NULL REFERENCES customers(id)" },
      // Two formats in one column: 2026-03-14 and 14.03.2026.
      { name: "requested_delivery", type: "text", ddl: "text NOT NULL" },
      { name: "value_eur", type: "numeric", ddl: "numeric(12,2) NOT NULL" },
    ],
    count: orderCount,
    row: (seed, id, n) => {
      const r = rng(seed, 2, id);
      const iso = isoDate(r.int(180));
      const date = r.chance(0.3) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso;
      return [id, 1 + r.int(customerCount(n)), date, Math.round(r.next() * 500_000) / 100];
    },
  },
  {
    name: "shipments",
    columns: [
      { name: "id", type: "int", ddl: "integer PRIMARY KEY" },
      { name: "order_id", type: "int", ddl: "integer NOT NULL REFERENCES orders(id)" },
      // Nullable: about one shipment in twenty has no carrier assigned.
      { name: "carrier_id", type: "int", ddl: "integer" },
      { name: "status", type: "text", ddl: "text NOT NULL" },
      { name: "weight_kg", type: "numeric", ddl: "numeric(10,2) NOT NULL" },
    ],
    count: (n) => n,
    row: (seed, id) => {
      const r = rng(seed, 3, id);
      return [id, Math.ceil(id / 2), r.chance(0.05) ? null : 1 + r.int(CARRIER_COUNT), r.pick(STATUSES), Math.round(r.next() * 240_000) / 100];
    },
  },
  {
    name: "stops",
    columns: [
      { name: "id", type: "int", ddl: "integer PRIMARY KEY" },
      { name: "shipment_id", type: "int", ddl: "integer NOT NULL REFERENCES shipments(id)" },
      { name: "city", type: "text", ddl: "text NOT NULL" },
      { name: "planned_on", type: "text", ddl: "text NOT NULL" },
    ],
    count: (n) => n,
    row: (seed, id) => {
      const r = rng(seed, 4, id);
      return [id, id, r.pick(CITIES), isoDate(r.int(200))];
    },
  },
  {
    name: "exceptions",
    columns: [
      { name: "id", type: "int", ddl: "integer PRIMARY KEY" },
      { name: "shipment_id", type: "int", ddl: "integer NOT NULL REFERENCES shipments(id)" },
      { name: "reason", type: "text", ddl: "text NOT NULL" },
      { name: "raised_on", type: "text", ddl: "text NOT NULL" },
    ],
    count: (n) => Math.floor(n / 10),
    row: (seed, id, n) => {
      const r = rng(seed, 5, id);
      return [id, 1 + r.int(n), r.pick(REASONS), isoDate(r.int(200))];
    },
  },
  {
    name: "credits",
    columns: [
      { name: "id", type: "int", ddl: "integer PRIMARY KEY" },
      { name: "customer_id", type: "int", ddl: "integer NOT NULL REFERENCES customers(id)" },
      { name: "amount_eur", type: "numeric", ddl: "numeric(12,2) NOT NULL" },
    ],
    count: (n) => Math.floor(n / 100),
    row: (seed, id, n) => {
      const r = rng(seed, 6, id);
      return [id, 1 + r.int(customerCount(n)), Math.round(r.next() * 20_000) / 100];
    },
  },
];

const BATCH = 5_000;
const STREAM_STEP = 50;

export interface Meta {
  seed: number;
  shipments: number;
  step: number;
  renamed: boolean;
}

export interface TableTruth {
  rows: number;
  /** md5 over every row in primary-key order. Unaffected by a column rename. */
  checksum: string;
}

export type ErpTruth = Meta & { tables: Record<string, TableTruth> };

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

const clientTurn = new WeakMap<pg.Client, Promise<unknown>>();

/** One call owns `db` until it returns. Two clients still race at SQL. */
async function exclusive<T>(db: pg.Client, work: () => Promise<T>): Promise<T> {
  const previous = clientTurn.get(db) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  clientTurn.set(
    db,
    previous.then(
      () => done,
      () => done,
    ),
  );
  await previous.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * Drop everything and load a fresh company. The same (seed, shipments) always
 * loads the same rows. Leftover change-stream slots are dropped and the
 * publication is recreated, so a reader must start over after a re-seed.
 */
export async function seedErp(db: pg.Client, seed: number, shipments: number): Promise<void> {
  return exclusive(db, () => seedLocked(db, () => seedErpUnlocked(db, seed, shipments)));
}

/** Advisory lock key held while seeding; any number unique to keiko's seeders. */
const SEED_LOCK = 0x6b65696b;

/**
 * Hold the database-wide seed lock around `work`, so seeders in separate
 * processes never overlap. A session lock: a crashed seeder releases it.
 */
async function seedLocked<T>(db: pg.Client, work: () => Promise<T>): Promise<T> {
  await db.query("SELECT pg_advisory_lock($1)", [SEED_LOCK]);
  try {
    return await work();
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [SEED_LOCK]);
  }
}

async function seedErpUnlocked(db: pg.Client, seed: number, shipments: number): Promise<void> {
  await dropChangeSlots(db);
  await db.query("DROP PUBLICATION IF EXISTS keiko");
  await db.query(`DROP TABLE IF EXISTS bookings, keiko_meta, ${TABLES.map((t) => t.name).reverse().join(", ")} CASCADE`);
  for (const table of TABLES) {
    await db.query(`CREATE TABLE ${table.name} (${table.columns.map((c) => `${c.name} ${c.ddl}`).join(", ")})`);
    const total = table.count(shipments);
    const names = table.columns.map((c) => c.name).join(", ");
    const params = table.columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(", ");
    for (let first = 1; first <= total; first += BATCH) {
      const columns: Cell[][] = table.columns.map(() => []);
      for (let id = first; id < first + BATCH && id <= total; id++) {
        table.row(seed, id, shipments).forEach((cell, i) => columns[i]?.push(cell));
      }
      await db.query(`INSERT INTO ${table.name} (${names}) SELECT * FROM unnest(${params})`, columns);
    }
  }
  await db.query(
    "CREATE TABLE bookings (idempotency_key text PRIMARY KEY, shipment_id integer NOT NULL, carrier_id integer NOT NULL, seq integer GENERATED ALWAYS AS IDENTITY, step integer NOT NULL)",
  );
  for (const table of [...TABLES.map((t) => t.name), "bookings"]) {
    await db.query(`ALTER TABLE ${table} REPLICA IDENTITY FULL`);
  }
  await db.query("CREATE PUBLICATION keiko FOR ALL TABLES");
  await ensureConnector(db);
  // The meta row is written last: it marks a complete seed, so a crash before
  // it leaves a database that seedErpIfEmpty seeds again.
  await db.query(
    "CREATE TABLE keiko_meta (seed integer NOT NULL, shipments integer NOT NULL, step integer NOT NULL, renamed boolean NOT NULL, slow_page_ms integer NOT NULL, overlap_pages boolean NOT NULL, drop_write_response boolean NOT NULL, rate_limit_seconds integer NOT NULL DEFAULT 0)",
  );
  await db.query("ALTER TABLE keiko_meta REPLICA IDENTITY FULL");
  await db.query("GRANT SELECT ON keiko_meta TO connector");
  await db.query("INSERT INTO keiko_meta VALUES ($1, $2, 0, false, 0, false, false, 0)", [seed, shipments]);
}

/**
 * Seed only a database without a complete seed. Returns whether it seeded.
 * Compose runs this on every start, so a restarted box keeps its rows.
 */
export async function seedErpIfEmpty(db: pg.Client, seed: number, shipments: number): Promise<boolean> {
  return exclusive(db, () => seedLocked(db, async () => {
    const { rows } = await db.query<{ meta: boolean }>("SELECT to_regclass('keiko_meta') IS NOT NULL AS meta");
    if (rows[0]?.meta && (await db.query("SELECT FROM keiko_meta")).rowCount) return false;
    await seedErpUnlocked(db, seed, shipments);
    return true;
  }));
}

/** Terminate any reader, then drop this database's slots so a re-seed does not retain WAL. */
async function dropChangeSlots(db: pg.Client): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    await db.query(
      "SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE active AND active_pid IS NOT NULL AND database = current_database()",
    );
    try {
      await db.query("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = current_database()");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/is active/i.test(message) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Read-only login with replication rights. The `keiko` role stays the owner. */
async function ensureConnector(db: pg.Client): Promise<void> {
  await db.query(`
    DO $$
    BEGIN
      CREATE ROLE connector LOGIN PASSWORD 'keiko' REPLICATION;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        ALTER ROLE connector WITH LOGIN REPLICATION;
    END $$
  `);
  await db.query(`
    DO $$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO connector', current_database());
    END $$
  `);
  await db.query("GRANT USAGE ON SCHEMA public TO connector");
  await db.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO connector");
}

/**
 * Bring a database seeded by an older keiko up to this schema. Idempotent, and
 * safe while an older box still serves: new columns default to "off".
 */
export async function upgradeSchema(db: pg.Client): Promise<void> {
  await exclusive(db, () => db.query("ALTER TABLE keiko_meta ADD COLUMN IF NOT EXISTS rate_limit_seconds integer NOT NULL DEFAULT 0"));
}

export async function readMeta(db: pg.Client): Promise<Meta> {
  return exclusive(db, () => queryMeta(db));
}

async function queryMeta(db: pg.Client): Promise<Meta> {
  const { rows } = await db.query<Meta>("SELECT seed, shipments, step, renamed FROM keiko_meta");
  const meta = rows[0];
  if (!meta) throw new Error("database is not seeded: run `pnpm seed` first");
  return meta;
}

/** Lock the meta row. Must run inside an open transaction. */
async function lockMeta(db: pg.Client): Promise<Meta> {
  const { rows } = await db.query<Meta>("SELECT seed, shipments, step, renamed FROM keiko_meta FOR UPDATE");
  const meta = rows[0];
  if (!meta) throw new Error("database is not seeded: run `pnpm seed` first");
  return meta;
}

/**
 * Apply `steps` rounds of activity. Each step is one transaction and is a pure
 * function of (seed, step number), so replaying from a fresh seed converges on
 * the same data. A step changes some shipment statuses, raises exceptions,
 * hard-deletes one exception every 7th step, and soft-deletes a customer every 5th.
 *
 * The meta row is locked first in the transaction, so two connections serialize
 * and a concurrent rename waits. Calls on one client are queued; two clients
 * still race at SQL. A crash rolls the open step back.
 */
export async function advance(db: pg.Client, steps: number): Promise<Meta> {
  return exclusive(db, () => advanceUnlocked(db, steps));
}

async function advanceUnlocked(db: pg.Client, steps: number): Promise<Meta> {
  let meta: Meta | undefined;
  for (let i = 0; i < steps; i++) {
    await db.query("BEGIN");
    try {
      const locked = await lockMeta(db);
      const step = locked.step + 1;
      const r = rng(locked.seed, STREAM_STEP, step);
      const status = locked.renamed ? "shipment_status" : "status";
      const changes = Math.max(1, Math.floor(locked.shipments / 1000));
      for (let c = 0; c < changes; c++) {
        const shipment = 1 + r.int(locked.shipments);
        await db.query(`UPDATE shipments SET ${status} = $1 WHERE id = $2`, [r.pick(STATUSES), shipment]);
        if (c % 10 === 0) {
          await db.query(
            "INSERT INTO exceptions (id, shipment_id, reason, raised_on) SELECT coalesce(max(id), 0) + 1, $1, $2, $3 FROM exceptions",
            [shipment, r.pick(REASONS), isoDate(200 + step)],
          );
        }
      }
      if (step % 7 === 0) await db.query("DELETE FROM exceptions WHERE id = (SELECT min(id) FROM exceptions)");
      if (step % 5 === 0) {
        await db.query("UPDATE customers SET deleted_at = $1 WHERE id = $2", [isoDate(200 + step), 1 + r.int(customerCount(locked.shipments))]);
      }
      await db.query("UPDATE keiko_meta SET step = $1", [step]);
      await db.query("COMMIT");
      meta = { ...locked, step };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
  return meta ?? (await queryMeta(db));
}

interface SwitchRow {
  slow_page_ms: number;
  overlap_pages: boolean;
  drop_write_response: boolean;
  renamed: boolean;
  rate_limit_seconds: number;
}

function chaosFromRow(row: SwitchRow): Chaos {
  return {
    slowPageMs: row.slow_page_ms,
    overlapPages: row.overlap_pages,
    dropWriteResponse: row.drop_write_response,
    renamedColumn: row.renamed,
    rateLimitSeconds: row.rate_limit_seconds,
  };
}

export async function readSwitches(db: pg.Client): Promise<Chaos> {
  return exclusive(db, async () => {
    const { rows } = await db.query<SwitchRow>("SELECT slow_page_ms, overlap_pages, drop_write_response, renamed, rate_limit_seconds FROM keiko_meta");
    const row = rows[0];
    if (!row) throw new Error("database is not seeded: run `pnpm seed` first");
    return chaosFromRow(row);
  });
}

/** Patch durable switch state. Rename takes the meta lock first, same order as advance. */
export async function patchSwitches(db: pg.Client, patch: Partial<Chaos>): Promise<Chaos> {
  return exclusive(db, () => patchSwitchesUnlocked(db, patch));
}

async function patchSwitchesUnlocked(db: pg.Client, patch: Partial<Chaos>): Promise<Chaos> {
  await db.query("BEGIN");
  try {
    const { rows } = await db.query<SwitchRow>(
      "SELECT slow_page_ms, overlap_pages, drop_write_response, renamed, rate_limit_seconds FROM keiko_meta FOR UPDATE",
    );
    const row = rows[0];
    if (!row) throw new Error("database is not seeded: run `pnpm seed` first");
    const next: Chaos = {
      slowPageMs: patch.slowPageMs ?? row.slow_page_ms,
      overlapPages: patch.overlapPages ?? row.overlap_pages,
      dropWriteResponse: patch.dropWriteResponse ?? row.drop_write_response,
      renamedColumn: patch.renamedColumn ?? row.renamed,
      rateLimitSeconds: patch.rateLimitSeconds ?? row.rate_limit_seconds,
    };
    if (next.renamedColumn !== row.renamed) {
      const [from, to] = next.renamedColumn ? ["status", "shipment_status"] : ["shipment_status", "status"];
      await db.query(`ALTER TABLE shipments RENAME COLUMN ${from} TO ${to}`);
    }
    await db.query("UPDATE keiko_meta SET slow_page_ms = $1, overlap_pages = $2, drop_write_response = $3, renamed = $4, rate_limit_seconds = $5", [
      next.slowPageMs,
      next.overlapPages,
      next.dropWriteResponse,
      next.renamedColumn,
      next.rateLimitSeconds,
    ]);
    await db.query("COMMIT");
    return next;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/** Rename `shipments.status` to `shipment_status`, or back. Idempotent. */
export async function setRenamed(db: pg.Client, renamed: boolean): Promise<void> {
  await patchSwitches(db, { renamedColumn: renamed });
}

interface BookingRow {
  idempotency_key: string;
  shipment_id: number;
  carrier_id: number;
  seq: number;
  step: number;
}

function bookingFromRow(row: BookingRow): Booking {
  return {
    shipmentId: row.shipment_id,
    carrierId: row.carrier_id,
    bookingId: `bk-${row.seq}`,
    idempotencyKey: row.idempotency_key,
    step: row.step,
  };
}

/**
 * Accept a booking once per idempotency key. Insert with ON CONFLICT DO NOTHING,
 * then read back, so a replay and a race both resolve to the stored row.
 * The activity step is taken from keiko_meta in the same statement.
 * A new booking assigns its carrier to the shipment in the same transaction; a
 * replay assigns nothing. An unknown shipment rolls the booking back.
 */
export async function bookErp(db: pg.Client, idempotencyKey: string, request: BookingRequest): Promise<BookingResult> {
  if (request.carrierId < 1 || request.carrierId > CARRIER_COUNT) return { kind: "unknown_carrier", message: `no carrier ${request.carrierId}` };
  return exclusive(db, () => bookErpUnlocked(db, idempotencyKey, request));
}

async function bookErpUnlocked(db: pg.Client, idempotencyKey: string, request: BookingRequest): Promise<BookingResult> {
  await db.query("BEGIN");
  try {
    const inserted = await db.query<BookingRow>(
      "INSERT INTO bookings (idempotency_key, shipment_id, carrier_id, step) SELECT $1, $2, $3, step FROM keiko_meta ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key, shipment_id, carrier_id, seq, step",
      [idempotencyKey, request.shipmentId, request.carrierId],
    );
    if (inserted.rows[0]) {
      const assigned = await db.query("UPDATE shipments SET carrier_id = $1 WHERE id = $2", [request.carrierId, request.shipmentId]);
      if (assigned.rowCount === 0) {
        await db.query("ROLLBACK");
        return { kind: "unknown_shipment", message: `no shipment ${request.shipmentId}` };
      }
      await db.query("COMMIT");
      return { kind: "created", booking: bookingFromRow(inserted.rows[0]) };
    }
    const { rows } = await db.query<BookingRow>(
      "SELECT idempotency_key, shipment_id, carrier_id, seq, step FROM bookings WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    const existing = rows[0];
    if (!existing) throw new Error("booking insert conflicted but the row is missing");
    await db.query("COMMIT");
    return replayBooking(bookingFromRow(existing), request);
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/** Every stored booking, in acceptance order. */
export async function listBookings(db: pg.Client): Promise<Booking[]> {
  return exclusive(db, async () => {
    const { rows } = await db.query<BookingRow>(
      "SELECT idempotency_key, shipment_id, carrier_id, seq, step FROM bookings ORDER BY seq",
    );
    return rows.map(bookingFromRow);
  });
}

export async function erpTruth(db: pg.Client): Promise<ErpTruth> {
  return exclusive(db, async () => {
    const meta = await queryMeta(db);
    const tables: Record<string, TableTruth> = {};
    for (const table of TABLES) {
      const { rows } = await db.query<TableTruth>(
        `SELECT count(*)::int AS rows, coalesce(md5(string_agg(md5(t::text), '' ORDER BY t.id)), '') AS checksum FROM ${table.name} t`,
      );
      tables[table.name] = rows[0] ?? { rows: 0, checksum: "" };
    }
    return { ...meta, tables };
  });
}

const EXAMPLE_CAP = 20;

export class CompareRequestError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.name = "CompareRequestError";
    this.status = status;
  }
}

export interface CompareScorecard {
  table: string;
  step: number;
  expected: number;
  received: number;
  missing: number;
  extra: number;
  different: number;
  examples: {
    missing: number[];
    extra: number[];
    different: { id: number; column: string; expected: string | null; received: string | null }[];
  };
  /** Present when the consumer sent `status` or `shipment_status`. */
  statusColumn?: string;
}

/**
 * Score a consumer's JSON-object rows against one ERP table. The body is
 * streamed into a temp table and compared in one query. Only claimed columns
 * are compared, as text after the database's own cast.
 */
export async function compareTable(
  db: pg.Client,
  tableName: string,
  rows: AsyncIterable<Record<string, unknown>>,
): Promise<CompareScorecard> {
  return exclusive(db, () => compareTableUnlocked(db, tableName, rows));
}

async function compareTableUnlocked(
  db: pg.Client,
  tableName: string,
  rows: AsyncIterable<Record<string, unknown>>,
): Promise<CompareScorecard> {
  const spec = TABLES.find((table) => table.name === tableName);
  if (!spec) throw new CompareRequestError(404, `no table ${tableName}`);

  let claimed: string[] | undefined;
  let statusColumn: string | undefined;
  const batchIds: number[] = [];
  const batchCells: (string | null)[][] = [];

  const flush = async (): Promise<void> => {
    if (claimed === undefined || batchIds.length === 0) return;
    const names = ["id", ...claimed];
    const params = names.map((_, i) => `$${i + 1}::${i === 0 ? "int" : "text"}[]`).join(", ");
    try {
      await db.query(`INSERT INTO keiko_compare (${names.join(", ")}) SELECT * FROM unnest(${params})`, [batchIds, ...batchCells]);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "23505") throw new CompareRequestError(400, "duplicate id");
      throw error;
    }
    batchIds.length = 0;
    for (const column of batchCells) column.length = 0;
  };

  await db.query("BEGIN");
  try {
    const known = new Map(spec.columns.map((column) => [column.name, column]));
    if (tableName === "shipments") {
      known.set("shipment_status", { name: "shipment_status", type: "text", ddl: "text NOT NULL" });
    }
    await db.query("DROP TABLE IF EXISTS pg_temp.keiko_compare");
    for await (const row of rows) {
      const id = claimedId(row["id"]);
      const keys = Object.keys(row).filter((key) => key !== "id");
      if (claimed === undefined) {
        if (keys.includes("status") && keys.includes("shipment_status")) {
          throw new CompareRequestError(400, "send status under one name");
        }
        claimed = [];
        for (const key of keys) {
          const column = known.get(key);
          if (!column) throw new CompareRequestError(400, `unknown column ${key}`);
          claimed.push(key);
          if (key === "status" || key === "shipment_status") statusColumn = key;
        }
        const ddl = ["id integer PRIMARY KEY", ...claimed.map((key) => `${key} text`)].join(", ");
        await db.query(`CREATE TEMP TABLE keiko_compare (${ddl}) ON COMMIT DROP`);
        for (const _ of claimed) batchCells.push([]);
      } else {
        const required = claimed;
        if (keys.length !== required.length || keys.some((key) => !required.includes(key))) {
          throw new CompareRequestError(400, "rows must claim the same columns");
        }
      }
      batchIds.push(id);
      for (const [i, key] of claimed.entries()) {
        const cell = claimedText(row[key]);
        batchCells[i]?.push(cell);
      }
      if (batchIds.length >= BATCH) await flush();
    }
    if (claimed === undefined) {
      claimed = [];
      await db.query("CREATE TEMP TABLE keiko_compare (id integer PRIMARY KEY) ON COMMIT DROP");
    }
    await flush();
    // Load first so a slow upload does not hold keiko_meta. Exclusive still owns this client for the inserts.
    const meta = await lockMeta(db);
    if (statusColumn === "shipment_status" && !meta.renamed) {
      throw new CompareRequestError(400, "unknown column shipment_status");
    }

    const actual = (claimedName: string): string => {
      if (tableName === "shipments" && (claimedName === "status" || claimedName === "shipment_status")) {
        return meta.renamed ? "shipment_status" : "status";
      }
      return claimedName;
    };
    // Numeric columns compare by value, so 2247.8 matches a stored 2247.80;
    // a claimed value that is not a number differs. Everything else compares as text.
    const same = (key: string): string => {
      const stored = `s.${actual(key)}`;
      const received = `c.${key}`;
      return spec.columns.find((column) => column.name === key)?.type === "numeric"
        ? `CASE WHEN ${received} IS NULL THEN ${stored} IS NULL
             WHEN pg_input_is_valid(${received}, 'numeric') THEN coalesce(${stored} = ${received}::numeric, false)
             ELSE false END`
        : `${stored}::text IS NOT DISTINCT FROM ${received}`;
    };
    const diffsSql =
      claimed.length === 0
        ? "SELECT 0::int AS id, ''::text AS col, NULL::text AS expected, NULL::text AS received WHERE false"
        : `SELECT s.id, d.col, d.expected, d.received
           FROM ${spec.name} s
           JOIN keiko_compare c ON c.id = s.id
           CROSS JOIN LATERAL (VALUES ${claimed
             .map((key, i) => `($${i + 1}::text, s.${actual(key)}::text, c.${key}::text, ${same(key)})`)
             .join(", ")}) d(col, expected, received, same)
           WHERE NOT d.same`;
    const { rows: score } = await db.query<{
      step: number;
      expected: number;
      received: number;
      missing: number;
      extra: number;
      different: number;
      missing_examples: number[];
      extra_examples: number[];
      different_examples: { id: number; column: string; expected: string | null; received: string | null }[];
    }>(
      `WITH missing AS (
         SELECT s.id FROM ${spec.name} s LEFT JOIN keiko_compare c ON c.id = s.id WHERE c.id IS NULL
       ), extra AS (
         SELECT c.id FROM keiko_compare c LEFT JOIN ${spec.name} s ON s.id = c.id WHERE s.id IS NULL
       ), diffs AS (${diffsSql})
       SELECT
         (SELECT step FROM keiko_meta) AS step,
         (SELECT count(*)::int FROM ${spec.name}) AS expected,
         (SELECT count(*)::int FROM keiko_compare) AS received,
         (SELECT count(*)::int FROM missing) AS missing,
         (SELECT count(*)::int FROM extra) AS extra,
         (SELECT count(*)::int FROM (SELECT DISTINCT id FROM diffs) d) AS different,
         (SELECT coalesce(json_agg(id ORDER BY id), '[]'::json) FROM (SELECT id FROM missing ORDER BY id LIMIT ${EXAMPLE_CAP}) m) AS missing_examples,
         (SELECT coalesce(json_agg(id ORDER BY id), '[]'::json) FROM (SELECT id FROM extra ORDER BY id LIMIT ${EXAMPLE_CAP}) e) AS extra_examples,
         (SELECT coalesce(json_agg(json_build_object('id', id, 'column', col, 'expected', expected, 'received', received) ORDER BY id, col), '[]'::json)
          FROM (SELECT id, col, expected, received FROM diffs ORDER BY id, col LIMIT ${EXAMPLE_CAP}) x) AS different_examples`,
      claimed,
    );
    const row = score[0];
    if (!row) throw new Error("compare returned no scorecard");
    const card: CompareScorecard = {
      table: spec.name,
      step: row.step,
      expected: row.expected,
      received: row.received,
      missing: row.missing,
      extra: row.extra,
      different: row.different,
      examples: {
        missing: row.missing_examples,
        extra: row.extra_examples,
        different: row.different_examples,
      },
    };
    if (statusColumn !== undefined) card.statusColumn = statusColumn;
    await db.query("COMMIT");
    return card;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

const CARRIER_COLUMNS = {
  name: "text",
  code: "text",
  serviceLevel: "text",
  ratePerKm: "numeric",
  revision: "int",
} as const satisfies Record<Exclude<keyof Carrier, "id">, ColumnType>;

const isCarrierColumn = (key: string): key is keyof typeof CARRIER_COLUMNS => Object.hasOwn(CARRIER_COLUMNS, key);
/** Carrier compare holds rows in memory, so an upload may claim at most this many. */
const CARRIER_COMPARE_ROW_CAP = 10_000;

const NUMBER_TEXT = /^\s*([-+]?)(\d*)\.?(\d*)(?:[eE]([-+]?\d+))?\s*$/;

/**
 * The exact decimal a numeric text names, in one canonical spelling, or
 * undefined when it is not a number. Compares by value without rounding
 * through a float, as the database's numeric type does.
 */
function decimalText(text: string): string | undefined {
  const match = NUMBER_TEXT.exec(text);
  if (!match) return undefined;
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  if (whole === "" && fraction === "") return undefined;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const first = digits.search(/[1-9]/);
  if (first === -1) return "0";
  const last = digits.length - [...digits].reverse().findIndex((d) => d !== "0");
  return `${sign === "-" ? "-" : ""}${digits.slice(first, last)}e${point - first}`;
}

/**
 * Score a consumer's carriers against `expected`, the list at `step`, with the
 * rules compareTable uses: claimed columns only, numeric by value, text exact.
 * Carriers are generated, so this needs no database.
 */
export async function compareCarriers(
  expected: readonly Carrier[],
  step: number,
  rows: AsyncIterable<Record<string, unknown>>,
): Promise<CompareScorecard> {
  let claimed: (keyof typeof CARRIER_COLUMNS)[] | undefined;
  const known = new Set(expected.map((carrier) => carrier.id));
  // Cells are kept for listed carriers only; other ids are kept as numbers for
  // the extra count, and the row cap bounds the whole upload.
  const received = new Map<number, (string | null)[]>();
  const unknown = new Set<number>();
  for await (const row of rows) {
    if (received.size + unknown.size >= CARRIER_COMPARE_ROW_CAP) {
      throw new CompareRequestError(400, `at most ${CARRIER_COMPARE_ROW_CAP} rows`);
    }
    const id = claimedId(row["id"]);
    const keys = Object.keys(row).filter((key) => key !== "id");
    if (claimed === undefined) {
      claimed = keys.map((key) => {
        if (!isCarrierColumn(key)) throw new CompareRequestError(400, `unknown column ${key}`);
        return key;
      });
    } else {
      const required = claimed;
      if (keys.length !== required.length || keys.some((key) => !required.some((name) => name === key))) {
        throw new CompareRequestError(400, "rows must claim the same columns");
      }
    }
    if (received.has(id) || unknown.has(id)) throw new CompareRequestError(400, "duplicate id");
    const cells = claimed.map((key) => claimedText(row[key]));
    if (known.has(id)) received.set(id, cells);
    else unknown.add(id);
  }
  const columns = claimed ?? [];

  const missing: number[] = [];
  const different: CompareScorecard["examples"]["different"] = [];
  let differentIds = 0;
  for (const carrier of expected) {
    const cells = received.get(carrier.id);
    if (!cells) {
      missing.push(carrier.id);
      continue;
    }
    let differs = false;
    for (const [i, key] of columns.entries()) {
      const stored = carrier[key];
      const cell = cells[i] ?? null;
      const same =
        CARRIER_COLUMNS[key] === "numeric"
          ? cell !== null && decimalText(cell) === decimalText(String(stored))
          : cell === String(stored);
      if (same) continue;
      differs = true;
      different.push({ id: carrier.id, column: key, expected: String(stored), received: cell });
    }
    if (differs) differentIds += 1;
  }
  const extra = [...unknown].sort((a, b) => a - b);
  different.sort((a, b) => a.id - b.id || a.column.localeCompare(b.column));

  return {
    table: "carriers",
    step,
    expected: expected.length,
    received: received.size + unknown.size,
    missing: missing.length,
    extra: extra.length,
    different: differentIds,
    examples: {
      missing: missing.slice(0, EXAMPLE_CAP),
      extra: extra.slice(0, EXAMPLE_CAP),
      different: different.slice(0, EXAMPLE_CAP),
    },
  };
}

function claimedId(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647) return value;
  throw new CompareRequestError(400, "id must be a positive integer");
}

function claimedText(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new CompareRequestError(400, "values must be string, number, boolean or null");
}
