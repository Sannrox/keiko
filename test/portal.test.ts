import assert from "node:assert/strict";
import { test } from "node:test";
import { CARRIER_COUNT, Portal, carrier, carriersAt, pageBounds } from "../src/portal.ts";

test("the same seed gives the same carriers, a different seed does not", () => {
  assert.deepEqual(carrier(7, 3), carrier(7, 3));
  assert.notDeepEqual(carrier(7, 3), carrier(8, 3));
});

test("carriers are a pure function of seed and step, however they are reached", () => {
  const twenty = carriersAt(7, 20);
  assert.deepEqual(carriersAt(7, 20, { step: 10, carriers: carriersAt(7, 10) }), twenty);
  assert.notDeepEqual(carriersAt(8, 20), twenty);
  const revisions = twenty.reduce((sum, c) => sum + c.revision, 0);
  assert.equal(revisions, 20);
  const portal = new Portal(7);
  portal.carriersAt(30);
  assert.deepEqual(portal.carriersAt(20), twenty);
});

test("paging walks every carrier once", () => {
  const portal = new Portal(1);
  const seen: number[] = [];
  let cursor: string | null = "0";
  while (cursor !== null) {
    const page = portal.carriers(Number(cursor), 15, false, 0);
    seen.push(...page.items.map((c) => c.id));
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, Array.from({ length: CARRIER_COUNT }, (_, i) => i + 1));
});

test("overlapping pages repeat exactly the previous page's last row", () => {
  assert.deepEqual(pageBounds(40, 0, 15, true), { start: 0, end: 15, next: 15 });
  assert.deepEqual(pageBounds(40, 15, 15, true), { start: 14, end: 30, next: 30 });
  const portal = new Portal(1);
  const first = portal.carriers(0, 15, true, 0);
  const second = portal.carriers(15, 15, true, 0);
  assert.equal(second.items[0]?.id, first.items.at(-1)?.id);
});

test("a booking is accepted once per idempotency key", () => {
  const portal = new Portal(1);
  const first = portal.book("k1", { shipmentId: 10, carrierId: 2 }, 0);
  const replay = portal.book("k1", { shipmentId: 10, carrierId: 2 }, 4);
  assert.equal(first.kind, "created");
  assert.equal(replay.kind, "replayed");
  assert.equal(portal.book("k1", { shipmentId: 11, carrierId: 2 }, 4).kind, "key_reused");
  assert.equal(portal.book("k2", { shipmentId: 10, carrierId: 999 }, 4).kind, "unknown_carrier");
  assert.equal(portal.bookings().length, 1);
});
