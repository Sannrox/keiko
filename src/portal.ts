// The carrier portal: a paged carrier list and idempotent bookings.
// Carriers are generated from the seed, and each activity step changes one
// carrier's rate, so the list is a pure function of (seed, step). Bookings are
// in memory here; with a database the server stores them in the bookings table.

import { rng } from "./rng.ts";

const STREAM_CARRIER = 101;
const STREAM_CARRIER_STEP = 102;
const SERVICE_LEVELS = ["standard", "express", "overnight"] as const;

export interface Carrier {
  id: number;
  name: string;
  code: string;
  serviceLevel: (typeof SERVICE_LEVELS)[number];
  ratePerKm: number;
  /** 0 as seeded; moves each time an activity step changes this carrier. */
  revision: number;
}

export interface BookingRequest {
  shipmentId: number;
  carrierId: number;
}

export interface Booking extends BookingRequest {
  bookingId: string;
  idempotencyKey: string;
  /** Activity step at which the booking was accepted. */
  step: number;
}

export type BookingResult =
  | { kind: "created"; booking: Booking }
  | { kind: "replayed"; booking: Booking }
  | { kind: "key_reused"; message: string }
  | { kind: "unknown_carrier"; message: string }
  /** Only with a database: portal-only mode has no shipments. */
  | { kind: "unknown_shipment"; message: string };

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const CARRIER_COUNT = 40;

/** Replay the stored booking, or refuse a different body for the same key. */
export function replayBooking(existing: Booking, request: BookingRequest): BookingResult {
  const same = existing.shipmentId === request.shipmentId && existing.carrierId === request.carrierId;
  return same
    ? { kind: "replayed", booking: existing }
    : { kind: "key_reused", message: "idempotency key was used with a different body" };
}

export function carrier(seed: number, id: number): Carrier {
  const r = rng(seed, STREAM_CARRIER, id);
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const code = Array.from({ length: 4 }, () => letters[r.int(letters.length)]).join("");
  return {
    id,
    name: `${r.pick(["Nord", "Hansa", "Alpen", "Rhein", "Baltic", "Elbe"])} ${r.pick(["Fracht", "Logistik", "Cargo", "Transport"])} ${id}`,
    code,
    serviceLevel: r.pick(SERVICE_LEVELS),
    ratePerKm: rate(r),
    revision: 0,
  };
}

function rate(r: ReturnType<typeof rng>): number {
  return Math.round((0.6 + r.next() * 1.4) * 100) / 100;
}

/**
 * The carrier list after `step` activity steps. Step n gives one carrier, picked
 * from (seed, n), a new rate and the next revision. Pass an earlier result as
 * `from` to apply only the steps after it. Never mutates `from`.
 */
export function carriersAt(seed: number, step: number, from?: { step: number; carriers: readonly Carrier[] }): Carrier[] {
  const start = from && from.step <= step ? from : { step: 0, carriers: Array.from({ length: CARRIER_COUNT }, (_, i) => carrier(seed, i + 1)) };
  const list = [...start.carriers];
  for (let n = start.step + 1; n <= step; n++) {
    const r = rng(seed, STREAM_CARRIER_STEP, n);
    const index = r.int(CARRIER_COUNT);
    const changed = list[index];
    if (changed) list[index] = { ...changed, ratePerKm: rate(r), revision: changed.revision + 1 };
  }
  return list;
}

/**
 * Slice `total` items into a page. With `overlap`, every page after the first
 * starts one item early, which repeats the previous page's last row.
 */
export function pageBounds(total: number, cursor: number, limit: number, overlap: boolean): { start: number; end: number; next: number | null } {
  const start = Math.max(0, overlap && cursor > 0 ? cursor - 1 : cursor);
  const end = Math.min(total, cursor + limit);
  return { start, end, next: end < total ? end : null };
}

export class Portal {
  readonly seed: number;
  readonly #byKey = new Map<string, Booking>();
  #latest: { step: number; carriers: Carrier[] } | undefined;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Every carrier at `step`. Caches the last list, so moving forward applies only the new steps. */
  carriersAt(step: number): readonly Carrier[] {
    if (this.#latest?.step !== step) this.#latest = { step, carriers: carriersAt(this.seed, step, this.#latest) };
    return this.#latest.carriers;
  }

  carriers(cursor: number, limit: number, overlap: boolean, step: number): Page<Carrier> {
    const { start, end, next } = pageBounds(CARRIER_COUNT, cursor, limit, overlap);
    return { items: this.carriersAt(step).slice(start, end), nextCursor: next === null ? null : String(next) };
  }

  /** Accept a booking once per idempotency key. The same key with the same body replays the first answer. */
  book(idempotencyKey: string, request: BookingRequest, step: number): BookingResult {
    if (request.carrierId < 1 || request.carrierId > CARRIER_COUNT) return { kind: "unknown_carrier", message: `no carrier ${request.carrierId}` };
    const existing = this.#byKey.get(idempotencyKey);
    if (existing) return replayBooking(existing, request);
    const booking: Booking = { ...request, idempotencyKey, step, bookingId: `bk-${this.#byKey.size + 1}` };
    this.#byKey.set(idempotencyKey, booking);
    return { kind: "created", booking };
  }

  /** Every booking accepted so far, in acceptance order. */
  bookings(): Booking[] {
    return [...this.#byKey.values()];
  }
}
