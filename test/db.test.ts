// Database tests. They run only when KEIKO_TEST_DATABASE_URL is set, so
// `pnpm test` stays green without a server. This file creates a database
// named with process id plus a random suffix and drops it at the end.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  advance,
  bookErp,
  compareTable,
  CompareRequestError,
  connect,
  erpTruth,
  listBookings,
  patchSwitches,
  readSwitches,
  seedErp,
  seedErpIfEmpty,
  setRenamed,
  upgradeSchema,
  type CompareScorecard,
  type ErpTruth,
} from "../src/erp.ts";
import { carriersAt, Portal } from "../src/portal.ts";
import { createBox } from "../src/server.ts";

const adminUrl = process.env.KEIKO_TEST_DATABASE_URL;
const SHIPMENTS = 80;
const STEPS = 14;

function uniqueName(): string {
  const name = `k${process.pid}_${randomBytes(4).toString("hex")}`;
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`refusing to create database ${name}`);
  return name;
}

function databaseUrl(name: string, user?: string): string {
  if (adminUrl === undefined) throw new Error("KEIKO_TEST_DATABASE_URL is required");
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${name}`;
  if (user !== undefined) {
    parsed.username = user;
    parsed.password = "keiko";
  }
  return parsed.href;
}

async function createDatabase(name: string): Promise<void> {
  if (adminUrl === undefined) throw new Error("KEIKO_TEST_DATABASE_URL is required");
  const admin = await connect(adminUrl);
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  if (adminUrl === undefined) return;
  const admin = await connect(adminUrl);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

function checksums(truth: ErpTruth): Record<string, string> {
  return Object.fromEntries(Object.entries(truth.tables).map(([name, table]) => [name, table.checksum]));
}

async function shipmentColumns(db: Awaited<ReturnType<typeof connect>>): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shipments' ORDER BY ordinal_position",
  );
  return rows.map((row) => row.column_name);
}

describe("database", { skip: adminUrl === undefined, concurrency: 1 }, () => {
  const name = uniqueName();
  let db: Awaited<ReturnType<typeof connect>>;

  before(async () => {
    await createDatabase(name);
    db = await connect(databaseUrl(name));
  });

  after(async () => {
    await db?.end();
    await dropDatabase(name);
  });

  test("same seed and steps give equal checksums across two fresh databases", async () => {
    const otherName = uniqueName();
    await createDatabase(otherName);
    const other = await connect(databaseUrl(otherName));
    try {
      await seedErp(db, 7, SHIPMENTS);
      await seedErp(other, 7, SHIPMENTS);
      await advance(db, STEPS);
      await advance(other, STEPS);
      const left = await erpTruth(db);
      const right = await erpTruth(other);
      assert.equal(left.step, STEPS);
      assert.equal(right.step, STEPS);
      assert.deepEqual(checksums(left), checksums(right));
    } finally {
      await other.end();
      await dropDatabase(otherName);
    }
  });

  test("a different seed gives different checksums", async () => {
    await seedErp(db, 7, SHIPMENTS);
    const first = checksums(await erpTruth(db));
    await seedErp(db, 8, SHIPMENTS);
    assert.notDeepEqual(checksums(await erpTruth(db)), first);
  });

  test("seeding if empty keeps a seeded box and finishes an interrupted seed", async () => {
    await db.query("DROP TABLE IF EXISTS keiko_meta");
    assert.equal(await seedErpIfEmpty(db, 7, SHIPMENTS), true);
    await advance(db, 2);
    assert.equal(await seedErpIfEmpty(db, 8, SHIPMENTS), false);
    assert.deepEqual([(await erpTruth(db)).seed, (await erpTruth(db)).step], [7, 2]);
    // A crash before the meta row leaves tables without it: the next start seeds again.
    await db.query("DELETE FROM keiko_meta");
    assert.equal(await seedErpIfEmpty(db, 8, SHIPMENTS), true);
    assert.deepEqual([(await erpTruth(db)).seed, (await erpTruth(db)).step], [8, 0]);
  });

  test("two seeders on separate connections do not overlap", async () => {
    const other = await connect(databaseUrl(name));
    try {
      await db.query("DROP TABLE IF EXISTS keiko_meta");
      const seeded = await Promise.all([seedErpIfEmpty(db, 7, SHIPMENTS), seedErpIfEmpty(other, 7, SHIPMENTS)]);
      assert.deepEqual(seeded.sort(), [false, true]);
      assert.equal((await erpTruth(db)).seed, 7);
    } finally {
      await other.end();
    }
  });

  test("the rename switch renames the column, is idempotent, and leaves checksums unchanged", async () => {
    await seedErp(db, 7, SHIPMENTS);
    const before = await erpTruth(db);
    assert.equal(before.renamed, false);
    assert.ok((await shipmentColumns(db)).includes("status"));

    await setRenamed(db, true);
    await setRenamed(db, true);
    const renamed = await erpTruth(db);
    assert.equal(renamed.renamed, true);
    assert.deepEqual(checksums(renamed), checksums(before));
    const columns = await shipmentColumns(db);
    assert.ok(columns.includes("shipment_status"));
    assert.ok(!columns.includes("status"));

    await setRenamed(db, false);
    await setRenamed(db, false);
    const restored = await erpTruth(db);
    assert.equal(restored.renamed, false);
    assert.deepEqual(checksums(restored), checksums(before));
    assert.ok((await shipmentColumns(db)).includes("status"));
  });

  test("activity still works while the column is renamed", async () => {
    const otherName = uniqueName();
    await createDatabase(otherName);
    const other = await connect(databaseUrl(otherName));
    try {
      await seedErp(db, 7, SHIPMENTS);
      await setRenamed(db, true);
      await advance(db, STEPS);
      await seedErp(other, 7, SHIPMENTS);
      await advance(other, STEPS);
      const renamed = await erpTruth(db);
      const plain = await erpTruth(other);
      assert.equal(renamed.step, STEPS);
      assert.equal(plain.step, STEPS);
      assert.equal(renamed.renamed, true);
      assert.deepEqual(checksums(renamed), checksums(plain));
    } finally {
      await other.end();
      await dropDatabase(otherName);
    }
  });

  test("two concurrent advance calls apply distinct steps in commit order", async () => {
    const peer = await connect(databaseUrl(name));
    const serialName = uniqueName();
    await createDatabase(serialName);
    const serial = await connect(databaseUrl(serialName));
    try {
      await seedErp(db, 7, SHIPMENTS);
      await seedErp(serial, 7, SHIPMENTS);
      const n = 7;
      await Promise.all([advance(db, n), advance(peer, n)]);
      await advance(serial, 2 * n);
      const concurrent = await erpTruth(db);
      const sequential = await erpTruth(serial);
      assert.equal(concurrent.step, 2 * n);
      assert.equal(sequential.step, 2 * n);
      assert.deepEqual(checksums(concurrent), checksums(sequential));
    } finally {
      await peer.end();
      await serial.end();
      await dropDatabase(serialName);
    }
  });

  test("a concurrent rename waits for advance instead of deadlocking", async () => {
    const peer = await connect(databaseUrl(name));
    try {
      await seedErp(db, 7, SHIPMENTS);
      await Promise.all([advance(db, STEPS), setRenamed(peer, true)]);
      const truth = await erpTruth(db);
      assert.equal(truth.step, STEPS);
      assert.equal(truth.renamed, true);
      assert.ok((await shipmentColumns(db)).includes("shipment_status"));
    } finally {
      await peer.end();
    }
  });

  test("two connections accept the same booking key once", async () => {
    const peer = await connect(databaseUrl(name));
    try {
      await seedErp(db, 7, SHIPMENTS);
      const request = { shipmentId: 5, carrierId: 3 };
      const created = await bookErp(db, "k1", request);
      const replay = await bookErp(db, "k1", request);
      const conflict = await bookErp(db, "k1", { shipmentId: 6, carrierId: 3 });
      assert.equal(created.kind, "created");
      assert.equal(replay.kind, "replayed");
      assert.equal(conflict.kind, "key_reused");
      if (created.kind === "created" && replay.kind === "replayed") {
        assert.equal(created.booking.step, 0);
        assert.deepEqual(replay.booking, created.booking);
      }

      const [left, right] = await Promise.all([bookErp(db, "k2", request), bookErp(peer, "k2", request)]);
      const kinds = [left.kind, right.kind].toSorted();
      assert.deepEqual(kinds, ["created", "replayed"]);
      const stored = await listBookings(db);
      assert.deepEqual(
        stored.map((booking) => booking.idempotencyKey),
        ["k1", "k2"],
      );
    } finally {
      await peer.end();
    }
  });

  test("the rate-limit switch is durable and an older database is upgraded to it", async () => {
    await seedErp(db, 7, SHIPMENTS);
    await db.query("ALTER TABLE keiko_meta DROP COLUMN rate_limit_seconds");
    await upgradeSchema(db);
    await upgradeSchema(db);
    assert.equal((await readSwitches(db)).rateLimitSeconds, 0);
    await patchSwitches(db, { rateLimitSeconds: 30 });
    const peer = await connect(databaseUrl(name));
    try {
      assert.equal((await readSwitches(peer)).rateLimitSeconds, 30);
    } finally {
      await peer.end();
    }
  });

  test("carriers follow the database's activity clock", async () => {
    await seedErp(db, 7, SHIPMENTS);
    await advance(db, 12);
    const server = createBox({ portal: new Portal(7), token: "test-token", db });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = (await (await fetch(`${base}/portal/v1/carriers?limit=100`, { headers: { authorization: "Bearer test-token" } })).json()) as {
        items: Record<string, unknown>[];
      };
      assert.deepEqual(page.items, carriersAt(7, 12));
      const scored = await fetch(`${base}/truth/compare/carriers`, { method: "POST", body: page.items.map((row) => JSON.stringify(row)).join("\n") });
      const score = (await scored.json()) as CompareScorecard;
      assert.deepEqual([score.step, score.missing, score.extra, score.different], [12, 0, 0, 0]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a dropped write survives a server restart", async () => {
    await seedErp(db, 7, SHIPMENTS);
    const token = "test-token";
    const body = { shipmentId: 5, carrierId: 3 };
    const book = (base: string, key: string): Promise<Response> =>
      fetch(`${base}/portal/v1/bookings`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const listen = async (client: typeof db) => {
      const server = createBox({ portal: new Portal(7), token, db: client });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      return { server, base: `http://127.0.0.1:${port}` };
    };

    const first = await listen(db);
    try {
      await fetch(`${first.base}/control/chaos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dropWriteResponse: true }),
      });
      await assert.rejects(book(first.base, "k1"));
    } finally {
      first.server.closeAllConnections();
      await new Promise<void>((resolve) => first.server.close(() => resolve()));
    }

    const peer = await connect(databaseUrl(name));
    const second = await listen(peer);
    try {
      const retry = await book(second.base, "k1");
      assert.equal(retry.status, 200);
      const payload = (await retry.json()) as { idempotencyKey: string; shipmentId: number };
      assert.equal(payload.idempotencyKey, "k1");
      assert.equal(payload.shipmentId, 5);
      const chaos = (await (await fetch(`${second.base}/control/chaos`)).json()) as { dropWriteResponse: boolean };
      assert.equal(chaos.dropWriteResponse, true);
      const truth = (await (await fetch(`${second.base}/truth`)).json()) as { portal: { bookings: { idempotencyKey: string }[] } };
      assert.deepEqual(truth.portal.bookings.map((booking) => booking.idempotencyKey), ["k1"]);
      const { rows } = await db.query<{ carrier_id: number }>("SELECT carrier_id FROM shipments WHERE id = 5");
      assert.equal(rows[0]?.carrier_id, 3);
    } finally {
      second.server.closeAllConnections();
      await new Promise<void>((resolve) => second.server.close(() => resolve()));
      await peer.end();
    }
  });

  test("an accepted booking reassigns the carrier where the connector re-reads it", async () => {
    await seedErp(db, 7, SHIPMENTS);
    const slot = `${name}_book`;
    const reader = await connect(databaseUrl(name, "connector"));
    const server = createBox({ portal: new Portal(7), token: "test-token", db });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const book = (key: string, shipmentId: number): Promise<Response> =>
      fetch(`${base}/portal/v1/bookings`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "idempotency-key": key, "content-type": "application/json" },
        body: JSON.stringify({ shipmentId, carrierId: 3 }),
      });
    try {
      await reader.query("SELECT pg_create_logical_replication_slot($1, 'test_decoding')", [slot]);
      const seeded = await reader.query<{ carrier_id: number }>("SELECT carrier_id FROM shipments WHERE id = 5");
      assert.notEqual(seeded.rows[0]?.carrier_id, 3);

      assert.equal((await book("k1", 5)).status, 201);
      assert.equal((await book("k2", 999_999)).status, 404);

      const reread = await reader.query<Record<string, unknown>>("SELECT * FROM shipments ORDER BY id");
      assert.equal(reread.rows.find((row) => row["id"] === 5)?.["carrier_id"], 3);
      const scored = await fetch(`${base}/truth/compare/shipments`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: reread.rows.map((row) => JSON.stringify(row)).join("\n"),
      });
      const score = (await scored.json()) as CompareScorecard;
      assert.deepEqual([score.missing, score.extra, score.different], [0, 0, 0]);
      const truth = (await (await fetch(`${base}/truth`)).json()) as { portal: { bookings: { idempotencyKey: string }[] } };
      assert.deepEqual(truth.portal.bookings.map((booking) => booking.idempotencyKey), ["k1"]);

      const { rows: changes } = await reader.query<{ data: string }>("SELECT data FROM pg_logical_slot_get_changes($1, NULL, NULL)", [slot]);
      // Rows only: the compare call adds an empty transaction of its own.
      const rowChanges = changes.map((row) => row.data).filter((data) => data.startsWith("table "));
      assert.equal(rowChanges.length, 2);
      assert.ok(rowChanges[0]?.startsWith("table public.bookings: INSERT:"));
      assert.match(rowChanges[1] ?? "", /^table public\.shipments: UPDATE: .*new-tuple: id\[integer\]:5 \S+ carrier_id\[integer\]:3 /);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await reader.query("SELECT pg_drop_replication_slot($1)", [slot]).catch(() => undefined);
      await reader.end();
    }
  });

  test("compare scores an exact export and reports drop, extra and alter", async () => {
    await seedErp(db, 7, SHIPMENTS);
    await advance(db, STEPS);
    const { rows } = await db.query<Record<string, unknown>>("SELECT id, name, city, deleted_at FROM customers ORDER BY id");
    const exact = await compareTable(db, "customers", asRows(rows));
    assert.equal(exact.missing, 0);
    assert.equal(exact.extra, 0);
    assert.equal(exact.different, 0);
    assert.equal(exact.expected, exact.received);
    assert.equal(exact.expected, rows.length);

    const dropped = await compareTable(db, "customers", asRows(rows.filter((row) => row["id"] !== 3)));
    assert.equal(dropped.missing, 1);
    assert.deepEqual(dropped.examples.missing, [3]);

    const extra = await compareTable(db, "customers", asRows([...rows, { id: 999_999, name: "x", city: "y", deleted_at: null }]));
    assert.equal(extra.extra, 1);
    assert.deepEqual(extra.examples.extra, [999_999]);

    const altered = await compareTable(
      db,
      "customers",
      asRows(rows.map((row) => (row["id"] === 4 ? { ...row, city: "XXXX" } : row))),
    );
    assert.equal(altered.different, 1);
    assert.equal(altered.examples.different[0]?.id, 4);
    assert.equal(altered.examples.different[0]?.column, "city");

    await assert.rejects(
      () => compareTable(db, "customers", asRows([{ id: 1 }, { id: 2, city: "XXXX" }])),
      (error: unknown) => error instanceof CompareRequestError && error.status === 400,
    );
    await assert.rejects(
      () => compareTable(db, "customers", asRows([{ id: 2_147_483_648, name: "x", city: "y", deleted_at: null }])),
      (error: unknown) => error instanceof CompareRequestError && error.status === 400,
    );
  });

  test("compare scores numeric columns sent as JSON numbers by value", async () => {
    await seedErp(db, 7, SHIPMENTS);
    const reader = await connect(databaseUrl(name, "connector"));
    try {
      const reread = async (table: string): Promise<Record<string, unknown>[]> =>
        (await reader.query<{ row: Record<string, unknown> }>(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY id`)).rows.map((r) => r.row);
      for (const table of ["shipments", "orders", "credits"]) {
        const score = await compareTable(db, table, asRows(await reread(table)));
        assert.deepEqual([table, score.missing, score.extra, score.different], [table, 0, 0, 0]);
      }
      const shipments = await reread("shipments");
      const weight = Number(shipments[0]?.["weight_kg"]);
      const nudged = await compareTable(db, "shipments", asRows(shipments.map((row, i) => (i === 0 ? { ...row, weight_kg: weight + 0.01 } : row))));
      assert.equal(nudged.different, 1);
      const garbled = await compareTable(db, "shipments", asRows(shipments.map((row, i) => (i === 0 ? { ...row, weight_kg: "heavy" } : row))));
      assert.equal(garbled.different, 1);
      assert.equal(garbled.examples.different[0]?.received, "heavy");
    } finally {
      await reader.end();
    }
  });

  test("compare accepts the renamed column under either name", async () => {
    await seedErp(db, 7, SHIPMENTS);
    await assert.rejects(
      () => compareTable(db, "shipments", asRows([{ id: 1, shipment_status: "delayed" }])),
      (error: unknown) => error instanceof CompareRequestError && error.status === 400,
    );
    await setRenamed(db, true);
    const { rows } = await db.query<{ id: number; shipment_status: string }>(
      "SELECT id, shipment_status FROM shipments ORDER BY id",
    );
    const renamed = await compareTable(db, "shipments", asRows(rows));
    assert.equal(renamed.missing, 0);
    assert.equal(renamed.different, 0);
    assert.equal(renamed.statusColumn, "shipment_status");

    const aliased = await compareTable(
      db,
      "shipments",
      asRows(rows.map((row) => ({ id: row.id, status: row.shipment_status }))),
    );
    assert.equal(aliased.missing, 0);
    assert.equal(aliased.different, 0);
    assert.equal(aliased.statusColumn, "status");

    await db.query("UPDATE shipments SET shipment_status = 'delayed' WHERE id = 1");
    const spaced = await compareTable(db, "shipments", asRows([{ id: 1, status: "delayed " }]));
    assert.equal(spaced.different, 1);
    assert.equal(spaced.examples.different[0]?.id, 1);
    assert.equal(spaced.examples.different[0]?.column, "status");
    assert.equal(spaced.examples.different[0]?.expected, "delayed");
    assert.equal(spaced.examples.different[0]?.received, "delayed ");
  });

  test("POST /truth/compare streams jsonl against the stored table", async () => {
    await seedErp(db, 7, SHIPMENTS);
    const { rows } = await db.query<Record<string, unknown>>("SELECT id, name, city, deleted_at FROM customers ORDER BY id");
    const server = createBox({ portal: new Portal(7), token: "test-token", db });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/truth/compare/customers`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: rows.map((row) => JSON.stringify(row)).join("\n"),
      });
      assert.equal(response.status, 200);
      const score = (await response.json()) as CompareScorecard;
      assert.equal(score.table, "customers");
      assert.equal(score.missing, 0);
      assert.equal(score.extra, 0);
      assert.equal(score.different, 0);

      const bad = await fetch(`http://127.0.0.1:${port}/truth/compare/customers`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: `${JSON.stringify(rows[0])}\n{not json\n`,
      });
      assert.equal(bad.status, 400);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("the connector role follows seven steps of changes and cannot write", async () => {
    await seedErp(db, 7, SHIPMENTS);
    const reader = await connect(databaseUrl(name, "connector"));
    try {
      await reader.query("SELECT pg_create_logical_replication_slot($1, 'test_decoding')", [`${name}_read`]);
      await advance(db, 7);
      const { rows } = await reader.query<{ data: string }>("SELECT data FROM pg_logical_slot_get_changes($1, NULL, NULL)", [
        `${name}_read`,
      ]);
      assert.equal(rows.filter((row) => row.data.startsWith("COMMIT")).length, 7);
      const seventh: string[] = [];
      let txn = 0;
      for (const row of rows) {
        if (row.data.startsWith("BEGIN")) txn += 1;
        if (txn === 7 && row.data.startsWith("table ")) seventh.push(row.data);
      }
      assert.ok(rows.some((row) => row.data.includes("shipments:") && row.data.includes("UPDATE:")));
      assert.ok(rows.some((row) => row.data.includes("exceptions:") && row.data.includes("INSERT:")));
      const deleted = seventh.find((line) => line.includes("exceptions:") && line.includes("DELETE:"));
      assert.ok(deleted);
      assert.ok(deleted.includes("reason"));
      await assert.rejects(
        () => reader.query("INSERT INTO credits (id, customer_id, amount_eur) VALUES (1, 1, 1)"),
        (error: unknown) => error instanceof Error && /permission denied/i.test(error.message),
      );
    } finally {
      await reader.end();
    }
  });

  test("a re-seed drops leftover slots and recreates the publication", async () => {
    await seedErp(db, 7, SHIPMENTS);
    await db.query("SELECT pg_create_logical_replication_slot($1, 'test_decoding')", [`${name}_stale`]);
    await seedErp(db, 7, SHIPMENTS);
    const { rows: slots } = await db.query<{ slot_name: string }>(
      "SELECT slot_name FROM pg_replication_slots WHERE database = current_database()",
    );
    assert.deepEqual(slots, []);
    const { rows: pubs } = await db.query<{ pubname: string; puballtables: boolean }>("SELECT pubname, puballtables FROM pg_publication");
    assert.equal(pubs.length, 1);
    assert.equal(pubs[0]?.pubname, "keiko");
    assert.equal(pubs[0]?.puballtables, true);
  });
});

async function* asRows(rows: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const row of rows) yield row;
}
