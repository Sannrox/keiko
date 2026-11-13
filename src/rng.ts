// Deterministic randomness. Every generated value is a pure function of
// (seed, stream, index), so rows can be produced in any order or batch size
// and a run can be repeated exactly.

/** Mix three integers into one 32-bit state. */
function mix(seed: number, stream: number, index: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const v of [stream, index]) {
    h = Math.imul(h ^ (v >>> 0), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h;
}

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  pick<T>(items: readonly [T, ...T[]]): T;
  chance(p: number): boolean;
}

/** A generator for one (seed, stream, index) cell. `stream` separates tables and purposes. */
export function rng(seed: number, stream: number, index: number): Rng {
  let a = mix(seed, stream, index);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    pick: (items) => items[int(items.length)] ?? items[0],
    chance: (p) => next() < p,
  };
}

/** ISO date `days` after 2026-01-01, computed without the system clock. */
export function isoDate(days: number): string {
  return new Date(Date.UTC(2026, 0, 1 + days)).toISOString().slice(0, 10);
}
