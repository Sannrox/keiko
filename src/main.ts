// Command line: `seed` loads the database (`--if-empty` keeps a seeded one),
// `serve` starts the box.
// Configuration comes from the environment so several boxes can run side by side.

import { readFileSync } from "node:fs";
import { connect, readMeta, seedErp, seedErpIfEmpty, upgradeSchema } from "./erp.ts";
import { Portal } from "./portal.ts";
import { createBox } from "./server.ts";

const SIZES = { small: 10_000, medium: 1_000_000 } as const;

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** KEIKO_TLS_CERT and KEIKO_TLS_KEY are PEM paths, both or neither. Neither means plain HTTP. */
function readTls(cert: string | undefined, key: string | undefined): { cert: string; key: string } | undefined {
  if (!cert && !key) return undefined;
  if (!cert || !key) throw new Error("set both KEIKO_TLS_CERT and KEIKO_TLS_KEY, or neither");
  return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

const databaseUrl = env("KEIKO_DATABASE_URL", `postgres://keiko:keiko@127.0.0.1:${env("KEIKO_DB_PORT", "54329")}/erp`);
const command = process.argv[2];

if (command === "seed") {
  const seed = Number(env("KEIKO_SEED", "1"));
  const sizeName = env("KEIKO_SIZE", "small");
  if (!Number.isInteger(seed)) throw new Error("KEIKO_SEED must be an integer");
  if (!(sizeName in SIZES)) throw new Error(`KEIKO_SIZE must be one of: ${Object.keys(SIZES).join(", ")}`);
  const shipments = SIZES[sizeName as keyof typeof SIZES];
  const db = await connect(databaseUrl);
  const seeded = process.argv[3] === "--if-empty" ? await seedErpIfEmpty(db, seed, shipments) : (await seedErp(db, seed, shipments), true);
  await db.end();
  console.log(seeded ? `seeded ${sizeName} company with seed ${seed}` : "already seeded, keeping its rows");
} else if (command === "serve") {
  // KEIKO_PORTAL_ONLY=1 runs without a database: portal, switches and bookings only.
  const db = env("KEIKO_PORTAL_ONLY", "") === "1" ? undefined : await connect(databaseUrl);
  if (db) await upgradeSchema(db);
  const seed = db ? (await readMeta(db)).seed : Number(env("KEIKO_SEED", "1"));
  const tls = readTls(process.env["KEIKO_TLS_CERT"], process.env["KEIKO_TLS_KEY"]);
  const server = createBox({
    portal: new Portal(seed),
    token: env("KEIKO_PORTAL_TOKEN", "keiko-dev-token"),
    ...(db ? { db } : {}),
    ...(tls ? { tls } : {}),
  });
  // KEIKO_HOST stays loopback on a host; the image listens on all interfaces
  // and compose publishes the port on loopback only.
  const host = env("KEIKO_HOST", "127.0.0.1");
  server.listen(Number(env("KEIKO_PORT", "8787")), host, () => {
    const address = server.address();
    console.log(`keiko listening on ${tls ? "https" : "http"}://${host}:${typeof address === "object" && address ? address.port : "?"}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => void db?.end().finally(() => process.exit(0)));
    });
  }
} else {
  console.error("usage: node src/main.ts <seed [--if-empty]|serve>");
  process.exit(2);
}
