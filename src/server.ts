// One HTTP server with three route groups:
//   /portal/v1/*  the carrier portal a connector reads and writes (bearer token)
//   /control/*    switches and the activity clock, for the test driving a run
//   /truth        what is actually stored, to compare against
// The database is optional so the portal can be tested without one.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import { calm, parseChaosPatch, type Chaos } from "./chaos.ts";
import { advance, bookErp, compareCarriers, compareTable, CompareRequestError, erpTruth, listBookings, patchSwitches, readMeta, readSwitches } from "./erp.ts";
import type { Portal } from "./portal.ts";

export interface BoxOptions {
  portal: Portal;
  token: string;
  /** Absent in portal-only mode: database routes answer 503. */
  db?: pg.Client;
  /** PEM certificate and key. Present: serve HTTPS. Absent: plain HTTP. */
  tls?: { cert: string; key: string };
}

const MAX_BODY = 64 * 1024;
const MAX_LIMIT = 100;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as unknown;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

const MAX_JSONL_LINE = 1_000_000;

/** Drain so a 4xx can be written after a mid-body reject. Does not destroy the socket. */
async function drainRequest(req: IncomingMessage): Promise<void> {
  if (req.readableEnded || req.destroyed) return;
  req.resume();
  await new Promise<void>((resolve) => {
    req.once("end", resolve);
    req.once("close", resolve);
    req.once("error", () => resolve());
  });
}

/** Yield JSON objects from a JSON Lines body. No total size cap; each line is bounded. */
async function* jsonlRecords(req: IncomingMessage): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let pending = "";
  const take = (line: string): Record<string, unknown> => {
    if (line.length > MAX_JSONL_LINE) throw new CompareRequestError(400, "jsonl line too long");
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CompareRequestError(400, "each line must be a JSON object");
    }
    return value as Record<string, unknown>;
  };
  // destroyOnReturn: false so a 400 can still be written after a mid-body reject.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    pending += decoder.decode(chunk as Buffer, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      if (line.length > 0) yield take(line);
      nl = pending.indexOf("\n");
    }
    if (pending.length > MAX_JSONL_LINE) throw new CompareRequestError(400, "jsonl line too long");
  }
  pending += decoder.decode();
  const last = pending.replace(/\r$/, "");
  if (last.length > 0) yield take(last);
}

export function createBox(options: BoxOptions): Server {
  const { portal, token, db } = options;
  // Portal-only mode keeps switches in memory. With a database they live in keiko_meta.
  const chaos: Chaos = { ...calm };
  // The portal's own step counter, used when no database keeps one.
  let portalStep = 0;
  const currentStep = async (): Promise<number> => (db ? (await readMeta(db)).step : portalStep);
  const switches = async (): Promise<Chaos> => (db ? readSwitches(db) : chaos);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://keiko");
    const route = `${req.method} ${url.pathname}`;

    if (url.pathname.startsWith("/portal/") && req.headers.authorization !== `Bearer ${token}`) {
      return send(res, 401, { error: "missing or wrong bearer token" });
    }

    if (route === "POST /truth/compare/carriers") {
      try {
        const step = await currentStep();
        return send(res, 200, await compareCarriers(portal.carriersAt(step), step, jsonlRecords(req)));
      } catch (error) {
        await drainRequest(req);
        if (error instanceof CompareRequestError) return send(res, error.status, { error: error.message });
        throw error;
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/truth/compare/")) {
      if (!db) {
        await drainRequest(req);
        return send(res, 503, { error: "compare needs a database" });
      }
      const table = url.pathname.slice("/truth/compare/".length);
      if (table.length === 0 || table.includes("/")) {
        await drainRequest(req);
        return send(res, 404, { error: `no route for ${route}` });
      }
      try {
        return send(res, 200, await compareTable(db, table, jsonlRecords(req)));
      } catch (error) {
        await drainRequest(req);
        if (error instanceof CompareRequestError) return send(res, error.status, { error: error.message });
        throw error;
      }
    }

    switch (route) {
      case "GET /healthz": {
        // Healthy means able to do its work: with a database configured, the database must answer.
        if (db) await db.query("SELECT 1");
        return send(res, 200, { ok: true, database: db !== undefined });
      }
      case "GET /portal/v1/carriers": {
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "25");
        if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
          return send(res, 400, { error: `cursor must be >= 0 and limit from 1 to ${MAX_LIMIT}` });
        }
        const state = await switches();
        if (state.rateLimitSeconds > 0) {
          res.setHeader("retry-after", String(state.rateLimitSeconds));
          return send(res, 429, { error: "rate limited" });
        }
        if (state.slowPageMs > 0) await sleep(state.slowPageMs);
        return send(res, 200, portal.carriers(cursor, limit, state.overlapPages, await currentStep()));
      }
      case "POST /portal/v1/bookings": {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || key.length === 0) return send(res, 400, { error: "Idempotency-Key header is required" });
        const body = await readJson(req);
        const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        const shipmentId = positiveInt(record["shipmentId"]);
        const carrierId = positiveInt(record["carrierId"]);
        if (shipmentId === undefined || carrierId === undefined) return send(res, 400, { error: "shipmentId and carrierId must be positive integers" });
        const request = { shipmentId, carrierId };
        const result = db ? await bookErp(db, key, request) : portal.book(key, request, await currentStep());
        if (result.kind === "unknown_carrier" || result.kind === "unknown_shipment") return send(res, 404, { error: result.message });
        if (result.kind === "key_reused") return send(res, 409, { error: result.message });
        if ((await switches()).dropWriteResponse && result.kind === "created") {
          // The booking is stored. Cut the connection so the caller cannot know.
          res.destroy();
          return;
        }
        return send(res, result.kind === "created" ? 201 : 200, result.booking);
      }
      case "GET /control/chaos":
        return send(res, 200, await switches());
      case "POST /control/chaos": {
        const patch = parseChaosPatch(await readJson(req));
        if (typeof patch === "string") return send(res, 400, { error: patch });
        if (patch.renamedColumn !== undefined && !db) return send(res, 503, { error: "renamedColumn needs a database" });
        if (db) return send(res, 200, await patchSwitches(db, patch));
        Object.assign(chaos, patch);
        return send(res, 200, chaos);
      }
      case "POST /control/advance": {
        const body = await readJson(req);
        const steps = positiveInt(typeof body === "object" && body !== null ? (body as Record<string, unknown>)["steps"] : undefined);
        if (steps === undefined || steps > 10_000) return send(res, 400, { error: "steps must be an integer from 1 to 10000" });
        if (db) return send(res, 200, { step: (await advance(db, steps)).step });
        portalStep += steps;
        return send(res, 200, { step: portalStep });
      }
      case "GET /truth":
        return send(res, 200, {
          erp: db ? await erpTruth(db) : null,
          portal: { seed: portal.seed, bookings: db ? await listBookings(db) : portal.bookings() },
        });
      default:
        return send(res, 404, { error: `no route for ${route}` });
    }
  };

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent || res.destroyed) return;
      const message = error instanceof Error ? error.message : "unexpected error";
      send(res, error instanceof SyntaxError ? 400 : 500, { error: message });
    });
  };
  return options.tls ? createTlsServer(options.tls, listener) : createServer(listener);
}
