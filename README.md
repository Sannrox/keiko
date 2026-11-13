# keiko

**Rehearse connectors and governed writes against a customer you can reset.**

[![CI](https://github.com/Sannrox/keiko/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Sannrox/keiko/actions/workflows/ci.yml)

[Quickstart](#try-it) · [How it works](#how-it-works) · [HTTP](#http) · [Switches](#switches) · [Agent guide](AGENTS.md)

Keiko (稽古, "practice") is a synthetic customer in a box: a small logistics
company's system of record that connectors and governed writes can be
rehearsed against. It is test equipment, not a product. Everything it holds is
generated from a seed, so two runs with the same seed, the same steps and the
same accepted bookings hold the same data.

- **Seeded and repeatable.** The same seed, activity steps and accepted bookings always store the same rows.
- **Awkward on purpose.** Mixed status spellings, a nullable foreign key, two date formats in one column, soft deletes.
- **Faults on demand.** Five switches, each changing exactly one behaviour: slow pages, overlapping pages, a lost write response, a renamed column, rate-limited pages.
- **Scored against truth.** Post what your consumer holds and get back what is missing, extra or different.
- **Ready for change capture.** A read-only `connector` role, a publication over every table, and TLS on the database.
- **Nothing moves on its own.** Activity is an explicit clock, one transaction per step.

## Try it

Needs Node 22.18 or newer (TypeScript runs directly, there is no build), pnpm and a container runtime with compose.

```sh
git clone https://github.com/Sannrox/keiko && cd keiko
pnpm install
pnpm up        # start the database, seed it, serve on 127.0.0.1:8787
```

With only a container runtime, start the whole box from its image instead:

```sh
docker compose up -d --wait --build    # or pnpm box
docker compose cp keiko:/app/tls/ca.crt .
curl -s --cacert ca.crt https://localhost:8787/healthz
```

That box serves HTTPS on 127.0.0.1:8787 and seeds only an empty database, so
`up` again, or `down` then `up`, keeps its rows and its step. `docker compose
down -v` throws the box away; `docker compose run --rm seed seed` re-seeds it on
purpose. A container on another compose project or a local cluster reaches it by
joining the box's network (`<project>_default`) as an external network: the
server is `https://keiko:8787` and the database `db:5432`, both covered by the
certificate.

A tenkai profile pins a released box instead: `deploy/tenkai.toml` installs
`ghcr.io/sannrox/keiko:v<version>` on a container host with no checkout, keeps
its rows across upgrade and rollback, and reports healthy once `/healthz`
answers. It serves seed 1, size small, on ports 8787 and 54329.

To rehearse a consumer that runs in Kubernetes, install keiko into the same
namespace with `deploy/kubernetes/tenkai.toml` (executor
`kubernetes-inprocess`), or apply its manifests directly. The consumer reaches
`https://keiko:8787` and `keiko-db:5432`. Create the TLS Secret first; the
image generates it, so only a container runtime and kubectl are needed:

```sh
bash scripts/kube-tls.sh <namespace>
kubectl -n <namespace> apply -f deploy/kubernetes/manifests/
```

Point clients at the Secret's `ca.crt`. The database keeps its data in a
PersistentVolumeClaim, and the keiko pod seeds only an empty database, so
restarts, upgrades and rollbacks keep the rows. Both pods run under the
`restricted` Pod Security level. keiko is test equipment: install it beside a
consumer, never into the consumer's own deployment.

In a second terminal, ask the box what it holds:

```sh
curl -s http://127.0.0.1:8787/truth
```

```json
{"erp":{"seed":1,"shipments":10000,"step":0,"renamed":false,"tables":{
  "customers":{"rows":200,"checksum":"7a9499b6e7284ceedd2d06c7c290a1f4"},
  "orders":{"rows":5000,"checksum":"9bba8d3ba337166f04b699f697ec808b"},
  "shipments":{"rows":10000,"checksum":"8d640e46a8008b84c91fdd05a32aa169"},
  "stops":{"rows":10000,"checksum":"b5aa0e671b7e49745404668810c9db92"},
  "exceptions":{"rows":1000,"checksum":"5679c9258cffdbad86a72023d6ae4118"},
  "credits":{"rows":100,"checksum":"7cfa936562933a57de10841c5f9ff850"}}},
 "portal":{"seed":1,"bookings":[]}}
```

(Line breaks added.) Let some activity happen, then score a deliberately wrong
copy of one customer:

```sh
curl -s -X POST http://127.0.0.1:8787/control/advance -d '{"steps":3}'
printf '{"id":1,"city":"Nowhere"}\n' |
  curl -s -X POST http://127.0.0.1:8787/truth/compare/customers --data-binary @-
```

```json
{"step":3}
{"table":"customers","step":3,"expected":200,"received":1,"missing":199,"extra":0,"different":1,
 "examples":{"missing":[2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21],"extra":[],
  "different":[{"id":1,"column":"city","expected":"Antwerpen","received":"Nowhere"}]}}
```

`pnpm down` stops the box and deletes the database.

## How it works

```mermaid
flowchart LR
  T[your test] -- switches, activity clock --> C["/control"]
  C --> DB[(ERP database)]
  K[your connector] -- "read, follow changes" --> DB
  K -- "page carriers, book" --> P["/portal/v1"]
  P -- bookings --> DB
  K -- rows it holds --> S["/truth/compare"]
  DB --> S
  S -- "missing, extra, different" --> T
```

The **database** is the system of record: six tables a connector reads
directly or follows through the change stream. The **portal** is a second
system beside it: a paged carrier list and one idempotent write, behind a
bearer token. Your test drives **control**: it flips switches and advances the
activity clock. **Truth** reports what is actually stored and scores a
consumer's rows against it. keiko never calls out; the connector under
rehearsal is the only thing that moves data.

## What is in the box

| Part | What it is |
|------|------------|
| Relational database | Six tables (customers, orders, shipments, stops, exceptions, credits) with deliberately awkward data: mixed status spellings, a nullable foreign key, two date formats in one column, soft deletes |
| Carrier portal | Paged read API and one write endpoint, behind a bearer token |
| Control | Five fault switches and an explicit activity clock |
| Truth | Row counts, checksums, and a compare scorecard of what is actually stored |

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `KEIKO_SEED` | `1` | Seed for all generated data |
| `KEIKO_SIZE` | `small` | `small` is 10,000 shipments, `medium` is 1,000,000 (about 30 s to seed) |
| `KEIKO_PORT` | `8787` | HTTP port, `0` picks a free one |
| `KEIKO_DB_PORT` | `54329` | Host port of the database |
| `KEIKO_DATABASE_URL` | built from `KEIKO_DB_PORT` | Database to seed and serve |
| `KEIKO_PORTAL_TOKEN` | `keiko-dev-token` | Bearer token for the portal |
| `KEIKO_PORTAL_ONLY` | unset | `1` serves without a database |
| `KEIKO_TLS_CERT`, `KEIKO_TLS_KEY` | unset | PEM certificate and key. Both set: the box serves HTTPS. Neither: plain HTTP |
| `KEIKO_HOST` | `127.0.0.1` | Interface the server listens on. The image sets `0.0.0.0` and compose publishes on loopback |
| `KEIKO_TLS_NAMES` | `DNS:localhost,IP:127.0.0.1,DNS:db,DNS:keiko` | Names in the generated server certificate, read when compose starts the database |

To run two boxes side by side, give each its own `COMPOSE_PROJECT_NAME`, `KEIKO_DB_PORT` and `KEIKO_PORT`.

The owner is user `keiko`, password `keiko`, database `erp`. Connectors follow
changes as user `connector`, password `keiko`: that role can read and replicate,
and cannot write. A re-seed drops leftover change-stream slots and recreates the
publication, so a reader must start over.

The database speaks TLS. Point a verifying client at `tls/ca.crt` (created on
first `pnpm db`, which copies the authority out of the database container). The
box's own seed and serve still use a plain connection.

The box's HTTP can use the same authority:
`KEIKO_TLS_CERT=tls/server.crt KEIKO_TLS_KEY=tls/server.key pnpm serve`. A client
that reaches the box under another name needs that name in the certificate:
set `KEIKO_TLS_NAMES` (for example `DNS:localhost,IP:127.0.0.1,DNS:box.test`)
before `pnpm db`. Other names replace the whole set, authority included; restart
the database and the box afterwards.

## HTTP

| Call | Purpose |
|------|---------|
| `GET /portal/v1/carriers?cursor=0&limit=25` | One page of carriers, `nextCursor` is `null` on the last page. Each carrier has a `revision` that moves when activity changes it. Pages are ordered by id, so a reader finds changes by re-reading the whole list, not by resuming from its last cursor |
| `POST /portal/v1/bookings` | Book a carrier for a shipment. Needs an `Idempotency-Key` header. `201` first time, `200` on a replay, `409` if the key is reused with a different body, `404` for an unknown carrier or shipment. With a database, a new booking also sets `shipments.carrier_id` in the same transaction |
| `GET /control/chaos`, `POST /control/chaos` | Read or patch the switches |
| `POST /control/advance` | `{"steps": n}` applies n rounds of activity |
| `GET /truth` | What is stored: per-table row count and checksum, plus accepted bookings |
| `POST /truth/compare/{table}` | JSON Lines of the consumer's rows (primary key plus claimed columns). `carriers` works too, with or without a database, for up to 10,000 rows. Returns a scorecard: missing, extra, different, with up to 20 examples of each. Numeric columns compare by value (`2247.8` matches `2247.80`); text compares exactly |
| `GET /healthz` | Fails when the database does not answer |

Compare only the columns sent. Text values are compared with the database's own text form of each cell, so trailing spaces count; numeric columns compare by value. Soft-deleted customers are expected rows; hard-deleted exceptions are not. While the rename switch is on, `status` and `shipment_status` both work and the scorecard says which name it saw. There is no row limit; the body is streamed.

## Switches

| Switch | Effect |
|--------|--------|
| `slowPageMs` | Every portal page waits this long |
| `overlapPages` | Each page after the first repeats the previous page's last row |
| `dropWriteResponse` | A new booking is stored, then the connection is cut without a response |
| `renamedColumn` | `shipments.status` becomes `shipment_status` (and back) |
| `rateLimitSeconds` | Above `0`, every portal page answers `429` with this `Retry-After` and no records. Writes are not limited |

A box started on a database seeded by an older keiko adds any missing switch, off.

## Activity

Nothing changes on its own. One step updates some shipment statuses, raises
exceptions, hard-deletes one exception every 7th step and soft-deletes a
customer every 5th. It also gives one carrier a new rate and the next revision;
carriers are generated, not stored, so the list is a function of seed and step. A step is one transaction, so a crash leaves a whole number
of steps applied. Two callers advancing the same database serialize on the
meta row and apply distinct steps.

Switches and accepted bookings are stored in the database, so a restart still
has them. Portal-only mode (`KEIKO_PORTAL_ONLY=1`) keeps them in memory.

## Status

Pre-1.0 and unreleased. The box serves snapshot reads, change capture and one
idempotent write today; routes and the truth format may still change. Work is
tracked in [GitHub Issues](https://github.com/Sannrox/keiko/issues).

## Contributing

```sh
pnpm typecheck
pnpm test      # binds free ports, needs no database
KEIKO_TEST_DATABASE_URL=postgres://keiko:keiko@127.0.0.1:54329/erp pnpm test
KEIKO_TEST_DATABASE_URL=postgres://keiko:keiko@127.0.0.1:54329/erp KEIKO_TEST_CA_CERT=tls/ca.crt pnpm test
```

The last commands also run `test/db.test.ts` and, with `KEIKO_TEST_CA_CERT`,
`test/tls.test.ts`. Database tests create a uniquely named database on that
server and drop it; the caller supplies the server. The TLS file talks to the
supplied server and does not create a database.

To release, bump the version in `package.json` and `deploy/tenkai.toml`
(product version and image tag) together, merge, and push the tag
`v<version>`. The release workflow checks they agree and publishes the image
for amd64 and arm64.

Repository layout, delivery lanes and commit rules are in
[AGENTS.md](AGENTS.md).

## License

[Apache-2.0](LICENSE).
