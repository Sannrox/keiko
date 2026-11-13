// The misbehaviours a run can switch on. Each changes exactly one behaviour.

export interface Chaos {
  /** Delay, in milliseconds, before every portal list page. */
  slowPageMs: number;
  /** Each portal page starts one item early, so pages overlap by one row. */
  overlapPages: boolean;
  /** A portal write is stored, then the connection is cut before the response. */
  dropWriteResponse: boolean;
  /** `shipments.status` is renamed to `shipment_status` in the database. */
  renamedColumn: boolean;
  /** Above zero: every portal list page answers 429 with this `Retry-After`, in seconds. */
  rateLimitSeconds: number;
}

export const calm: Chaos = { slowPageMs: 0, overlapPages: false, dropWriteResponse: false, renamedColumn: false, rateLimitSeconds: 0 };

/** Validate a partial update from the control endpoint. Returns an error message on bad input. */
export function parseChaosPatch(input: unknown): Partial<Chaos> | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "body must be an object";
  const patch: Partial<Chaos> = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "slowPageMs":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 60_000) return "slowPageMs must be an integer from 0 to 60000";
        patch.slowPageMs = value;
        break;
      case "rateLimitSeconds":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3_600) return "rateLimitSeconds must be an integer from 0 to 3600";
        patch.rateLimitSeconds = value;
        break;
      case "overlapPages":
      case "dropWriteResponse":
      case "renamedColumn":
        if (typeof value !== "boolean") return `${key} must be a boolean`;
        patch[key] = value;
        break;
      default:
        return `unknown switch: ${key}`;
    }
  }
  return patch;
}
