// HTTPS with the generated authority. Runs `scripts/db-tls.sh` from a copy in
// a temp directory named with process id plus a random suffix, so it never
// touches this checkout's `tls/`. Skips when openssl or flock is missing.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Portal } from "../src/portal.ts";
import { createBox } from "../src/server.ts";

const TOKEN = "test-token";
const tools = ["openssl", "flock"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

interface Reply {
  status: number;
  body: string;
}

/** One HTTPS request to 127.0.0.1. `servername` is the name the client verifies. */
function call(port: number, path: string, options: { ca?: string; servername?: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers, ca: options.ca, servername: options.servername, rejectUnauthorized: true },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("https", { skip: !tools }, () => {
  const root = join(tmpdir(), `keiko-https-${process.pid}-${randomBytes(4).toString("hex")}`);
  let ca = "";
  let port = 0;
  let close = async (): Promise<void> => {};

  before(async () => {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(new URL("../scripts/db-tls.sh", import.meta.url), join(root, "scripts", "db-tls.sh"));
    execFileSync("bash", [join(root, "scripts", "db-tls.sh")], {
      env: { ...process.env, KEIKO_TLS_NAMES: "DNS:localhost,IP:127.0.0.1,DNS:keiko.test" },
    });
    ca = readFileSync(join(root, "tls", "ca.crt"), "utf8");
    const tls = { cert: readFileSync(join(root, "tls", "server.crt"), "utf8"), key: readFileSync(join(root, "tls", "server.key"), "utf8") };
    const server = createBox({ portal: new Portal(1), token: TOKEN, tls });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    close = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  });

  after(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a client that verifies against the authority reads a page and books", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const page = await call(port, "/portal/v1/carriers?limit=5", { ca, headers: auth });
    assert.equal(page.status, 200);
    assert.equal((JSON.parse(page.body) as { items: unknown[] }).items.length, 5);
    const booked = await call(port, "/portal/v1/bookings", {
      ca,
      method: "POST",
      headers: { ...auth, "idempotency-key": "k1", "content-type": "application/json" },
      body: JSON.stringify({ shipmentId: 5, carrierId: 3 }),
    });
    assert.equal(booked.status, 201);
  });

  test("a name issued at generation verifies, and a client without the authority is refused", async () => {
    assert.equal((await call(port, "/healthz", { ca, servername: "keiko.test" })).status, 200);
    await assert.rejects(call(port, "/healthz", { ca, servername: "other.test" }), /altnames/i);
    await assert.rejects(call(port, "/healthz", {}), /self.signed|unable to verify|local issuer/i);
  });
});
