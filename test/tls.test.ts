// TLS handshake against a running database. Runs only when both
// KEIKO_TEST_DATABASE_URL and KEIKO_TEST_CA_CERT are set, so `pnpm test`
// stays green without a server. Does not create a database.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import pg from "pg";

const adminUrl = process.env.KEIKO_TEST_DATABASE_URL;
const caPath = process.env.KEIKO_TEST_CA_CERT;

describe("database tls", { skip: adminUrl === undefined || caPath === undefined }, () => {
  test("a client that verifies against the generated authority connects", async () => {
    if (adminUrl === undefined || caPath === undefined) throw new Error("tls test env required");
    const client = new pg.Client({
      connectionString: adminUrl,
      ssl: { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true },
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ n: number }>("SELECT 1 AS n");
      assert.equal(rows[0]?.n, 1);
    } finally {
      await client.end();
    }
  });

  test("the same client without the authority is refused", async () => {
    if (adminUrl === undefined) throw new Error("tls test env required");
    const client = new pg.Client({
      connectionString: adminUrl,
      ssl: { rejectUnauthorized: true },
    });
    await assert.rejects(() => client.connect());
  });

  test("a plain connection is still accepted", async () => {
    if (adminUrl === undefined) throw new Error("tls test env required");
    const client = new pg.Client({ connectionString: adminUrl, ssl: false });
    await client.connect();
    await client.end();
  });
});
