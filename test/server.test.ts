// Portal-only server tests. Each test binds an ephemeral port and needs no
// database, so several agents can run them at once.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Portal } from "../src/portal.ts";
import { createBox } from "../src/server.ts";

const TOKEN = "test-token";

async function withBox(run: (base: string) => Promise<void>): Promise<void> {
  const server = createBox({ portal: new Portal(1), token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const auth = { authorization: `Bearer ${TOKEN}` };
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const book = (base: string, key: string, body: unknown): Promise<Response> =>
  fetch(`${base}/portal/v1/bookings`, { method: "POST", headers: { ...auth, "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });

test("the portal refuses a missing token and serves a page with one", async () => {
  await withBox(async (base) => {
    assert.equal((await fetch(`${base}/portal/v1/carriers`)).status, 401);
    const page = (await (await fetch(`${base}/portal/v1/carriers?limit=10`, { headers: auth })).json()) as { items: unknown[]; nextCursor: string };
    assert.equal(page.items.length, 10);
    assert.equal(page.nextCursor, "10");
  });
});

test("a dropped write response still stores the booking exactly once", async () => {
  await withBox(async (base) => {
    await fetch(`${base}/control/chaos`, json({ dropWriteResponse: true }));
    await assert.rejects(book(base, "k1", { shipmentId: 5, carrierId: 3 }));
    await fetch(`${base}/control/chaos`, json({ dropWriteResponse: false }));
    const retry = await book(base, "k1", { shipmentId: 5, carrierId: 3 });
    assert.equal(retry.status, 200);
    const truth = (await (await fetch(`${base}/truth`)).json()) as { erp: null; portal: { bookings: { idempotencyKey: string }[] } };
    assert.deepEqual(truth.portal.bookings.map((b) => b.idempotencyKey), ["k1"]);
  });
});

test("the slow-page switch delays only while it is on", async () => {
  await withBox(async (base) => {
    await fetch(`${base}/control/chaos`, json({ slowPageMs: 150 }));
    const started = performance.now();
    await fetch(`${base}/portal/v1/carriers`, { headers: auth });
    assert.ok(performance.now() - started >= 140);
    const state = (await (await fetch(`${base}/control/chaos`, json({ slowPageMs: 0 }))).json()) as { slowPageMs: number };
    assert.equal(state.slowPageMs, 0);
  });
});

test("the rate-limit switch refuses pages with Retry-After while it is on", async () => {
  await withBox(async (base) => {
    const page = (): Promise<Response> => fetch(`${base}/portal/v1/carriers?cursor=5&limit=3`, { headers: auth });
    const before = await (await page()).json();
    await fetch(`${base}/control/chaos`, json({ rateLimitSeconds: 7 }));
    const limited = await page();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "7");
    assert.equal("items" in ((await limited.json()) as object), false);
    await fetch(`${base}/control/chaos`, json({ rateLimitSeconds: 0 }));
    assert.deepEqual(await (await page()).json(), before);
  });
});

test("an advance changes carriers, and compare names each stale one", async () => {
  await withBox(async (base) => {
    type Carrier = { id: number; ratePerKm: number; revision: number };
    const readAll = async (): Promise<Carrier[]> =>
      ((await (await fetch(`${base}/portal/v1/carriers?limit=100`, { headers: auth })).json()) as { items: Carrier[] }).items;
    const score = async (rows: readonly Record<string, unknown>[]) =>
      (await (await fetch(`${base}/truth/compare/carriers`, { method: "POST", body: rows.map((row) => JSON.stringify(row)).join("\n") })).json()) as {
        step: number;
        missing: number;
        different: number;
        examples: { different: { id: number; column: string }[] };
      };
    const stale = await readAll();
    await fetch(`${base}/control/advance`, json({ steps: 20 }));
    const fresh = await readAll();
    const changed = fresh.filter((c) => c.revision > 0).map((c) => c.id);
    assert.ok(changed.length > 0);
    assert.ok(fresh.some((c, i) => c.ratePerKm !== stale[i]?.ratePerKm));

    const exact = await score(fresh);
    assert.deepEqual([exact.step, exact.missing, exact.different], [20, 0, 0]);
    const behind = await score(stale);
    assert.equal(behind.different, changed.length);
    const named = [...new Set(behind.examples.different.map((d) => d.id))];
    assert.deepEqual(named, changed.slice(0, named.length));
    assert.ok(behind.examples.different.every((d) => d.column === "ratePerKm" || d.column === "revision"));

    const rates = (spell: (rate: number) => string) => score(fresh.map((c) => ({ id: c.id, ratePerKm: spell(c.ratePerKm) })));
    assert.equal((await rates((rate) => `${rate.toFixed(4)}`)).different, 0);
    assert.equal((await rates((rate) => `${Math.round(rate * 100)}e-2`)).different, 0);
    assert.equal((await rates((rate) => `${rate.toFixed(2)}000000000000001`)).different, fresh.length);
  });
});

test("bad input is refused with a reason", async () => {
  await withBox(async (base) => {
    assert.equal((await fetch(`${base}/control/chaos`, json({ nope: true }))).status, 400);
    assert.equal((await fetch(`${base}/control/chaos`, json({ rateLimitSeconds: -1 }))).status, 400);
    assert.equal((await fetch(`${base}/control/chaos`, json({ renamedColumn: true }))).status, 503);
    assert.equal((await book(base, "k9", { shipmentId: "x", carrierId: 1 })).status, 400);
    assert.equal((await fetch(`${base}/control/advance`, json({ steps: 0 }))).status, 400);
    assert.equal((await fetch(`${base}/truth/compare/customers`, { method: "POST", body: "" })).status, 503);
    assert.equal((await fetch(`${base}/truth/compare/carriers`, { method: "POST", body: '{"id":1,"rate":1}' })).status, 400);
    const flood = Array.from({ length: 10_001 }, (_, i) => `{"id":${i + 1}}`).join("\n");
    assert.equal((await fetch(`${base}/truth/compare/carriers`, { method: "POST", body: flood })).status, 400);
  });
});
