# Repository Guidelines

## Project Structure & Ownership

`keiko` is a synthetic customer in a box: a small logistics company's system
of record that connectors and governed writes can be rehearsed against. It is
test equipment, not a product. Everything it holds is generated from a seed,
so two runs with the same seed, the same steps and the same accepted bookings
hold the same data.

- `src/erp.ts`: schema, deterministic seed, activity steps, durable switches
  and bookings, `/truth` checksums, the compare scorecard, and the change-stream
  publication plus connector role.
- `src/portal.ts`: generated carrier list, a pure function of seed and activity
  step, and the in-memory booking store used in portal-only mode.
- `src/server.ts`: HTTP for `/portal/v1`, `/control`, `/truth`, `/healthz`.
- `src/chaos.ts`: five fault switches; each changes exactly one behaviour.
- `src/rng.ts`: deterministic generator, a pure function of `(seed, stream, index)`.
- `src/main.ts`: `seed` and `serve`, configured from the environment.
- `test/`: `node:test` suites. Portal and HTTP tests bind ephemeral ports and
  need no database. `test/db.test.ts` runs only when `KEIKO_TEST_DATABASE_URL`
  is set; it creates a database named with process id plus a random suffix and
  drops it at the end. `test/tls.test.ts` runs when that URL and
  `KEIKO_TEST_CA_CERT` are both set; it does not create a database.
- `Dockerfile`: one image with the server, the seed command, the TLS
  generator and `compose.yaml`.
- `deploy/tenkai.toml`: the tenkai host product. Its install reads the compose
  file out of the released image, so it needs no checkout.
- `.github/workflows/release.yml`: a `v<version>` tag publishes the image to
  GHCR. `test/release.test.ts` keeps `package.json`, the manifest and its image
  tag on one version.
- `compose.yaml`: the whole box. A one-shot `tls` service writes a throwaway
  authority into a volume, Postgres 17 runs with the change stream and TLS on
  and keeps its data in a volume, a one-shot `seed` seeds only an empty
  database, and `keiko` serves HTTPS. `pnpm db` starts only the database and
  copies the authority into `tls/`; a host-run box serves HTTPS with it when
  `KEIKO_TLS_CERT` and `KEIKO_TLS_KEY` are set. `test/https.test.ts` runs the script from a copy in
  a unique temp directory and skips without openssl or flock.

Postgres is the durable store. Switches and accepted bookings live there too;
portal-only mode keeps them in memory. Connectors are the consumers; keiko does
not call out. Concurrent advances on one database serialize on the meta row.

Human documentation: [README.md](README.md). `CLAUDE.md` only points here;
this file is canonical. GitHub Issues are the planning source of truth. The
workflow Skills come from the shared agent kit (see `## Shared agent skills`).

## Build, Test, and Development Commands

Needs Node 22.18 or newer, pnpm, and a container runtime with compose.
`pnpm box` (`docker compose up -d --wait --build`) needs only the container runtime.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm up        # start the database, seed it, serve on 127.0.0.1:8787
pnpm down
bash scripts/validate-workflow-skills.sh
```

`pnpm test` binds free ports and needs no database, so several agents can run
it at once. Database tests run only when `KEIKO_TEST_DATABASE_URL` is set; each
file creates its own uniquely named database and drops it, so several agents
can share one server. To run two boxes side by side, give each its own
`COMPOSE_PROJECT_NAME`, `KEIKO_DB_PORT`, and `KEIKO_PORT`.

## Coding Style & Naming

TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`). Run TypeScript directly; there is no build. Keep
domain values in `erp.ts` and `portal.ts`; HTTP stays in `server.ts`; the
database driver stays in `erp.ts`. Each chaos switch changes exactly one
behaviour. The awkward ERP data (mixed status spellings, a nullable foreign
key, two date formats in one column, soft deletes) is intentional.

## Testing Guidelines

Add focused deterministic tests. Portal and HTTP tests bind port 0 and must
not use a shared database URL or a fixed port. Database tests must not use a
fixed database name. The same seed must produce the same carriers and rows. Verification is proportional: typecheck and the
narrowest relevant tests. Before delivery, prefer the project-local
`verify-change` Skill. Before commit or PR, run `pnpm typecheck`, `pnpm test`,
`bash scripts/validate-workflow-skills.sh`, and `autoreview`.

## Commit & Pull Request Guidelines

Use short imperative subjects, often Conventional Commit style:
`feat: record accepted bookings in /truth`,
`fix: refuse a reused idempotency key`,
`docs: describe the activity clock`. Keep commits narrow. Pull requests should
include a concise behavior summary, tests run, linked issue or context, and any
contract, schema, or configuration implications. Do not put hostnames, FQDNs,
home directories, absolute worktree paths, LAN or employer network names, or
other private environment inventory on public Issues, Pull Requests, comments,
or commit messages.

### Verified commits on GitHub

Lane branches are published with GitHub-verified commits and landed by the
shared lane script, from the lane worktree:

```sh
bash "${AGENT_KIT_HOME:-$HOME/.agents/agent-kit}/skills/deliver-ready-issue/scripts/issue-lane.sh" push <issue>
bash "${AGENT_KIT_HOME:-$HOME/.agents/agent-kit}/skills/deliver-ready-issue/scripts/issue-lane.sh" land <issue> --pr <pr>
```

`push` publishes the local `HEAD` tree to the claim branch as a Verified
commit and resets the worktree to it, so local `HEAD` is the Pull Request head.
`land` squash-merges that reviewed head once the checks pass and confirms the
merge and the closed Issue. Never pass `--no-gpg-sign` for local commits; if GPG
fails, stop and fix it. Avoid GitHub **rebase** merges: they rewrite commits
and drop signatures. Do not rewrite protected `main` after merging unless the
user explicitly approves.

## Parallel delivery lanes

A delivery lane is one Issue, one branch, one isolated checkout, one Pull
Request, and one owner. Several agents may deliver several Issues at the same
time, on one machine or on many, only as separate lanes. One Issue is never
split across lanes, and one lane never carries a second Issue.

### Claims live on GitHub

Machines cannot see each other's worktrees, so a claim is only what GitHub
shows. An Issue is claimed, and therefore active, when any of the following
exists:

1. an open Pull Request, draft or ready, that references the Issue;
2. a branch `<type>/<issue>`, or any branch matching `*/<issue>-*`;
3. the authenticated login assigned to the Issue less than six hours ago.

An assignment older than six hours with neither branch nor Pull Request is an
ownership hint, not a veto: report it and ask the maintainer before claiming.
A claim is stale once its Issue is closed or its Pull Request has merged; its
owner or the maintainer removes it. Any other takeover first preserves the
existing branch, Pull Request, and evidence and requires the maintainer's
confirmation, unless the lead of the same parallel run owns the stalled lane.

A lane claims before it implements, under Publish or Land authority or with an
explicit claim authorization under Implement, using
`bash "${AGENT_KIT_HOME:-$HOME/.agents/agent-kit}/skills/deliver-ready-issue/scripts/issue-lane.sh" claim <issue>`:

- the branch `<type>/<issue>` is created on GitHub from the default branch by
  an atomic ref creation, so when two machines race exactly one claim
  succeeds and the other sees `claimed`;
- the authenticated login is assigned to the Issue, which shows the claim in
  the Issue list and timestamps it in the Issue timeline.

`<type>` is derived deterministically so that every machine computes the same
branch: the Conventional Commit type in the Issue title, with `bug` mapped to
`fix`; otherwise the type label (`bug` → `fix`, `enhancement` → `feat`,
`documentation` → `docs`); otherwise `chore`. Lane branches carry no slug
because the name is the claim; the Pull Request title carries the description.
Human topic branches may keep `<type>/<issue>-<slug>`. A claim is any branch
matching `*/<issue>` or `*/<issue>-*`.

An Implement-only lane cannot claim and is invisible to other machines. Say so
in the report, or ask for claim authority before starting.

### Isolation on each machine

Local isolation protects lanes that share a machine; it is not a claim.

- Each lane checks out its claim branch in `.worktrees/issue-<issue>` inside
  the repository, ignored by Git. A fresh clone dedicated to the lane, as on a
  cloud agent, is equivalent. The base SHA is recorded in the lane report.
- The primary checkout belongs to the maintainer. Agents never switch its
  branch, reset it, stash it, or run long jobs in it while another lane is
  active.
- A worktree serves exactly one Issue. Finished lanes are removed; a worktree is
  never reused for a different Issue or renamed to hide its origin.
- Shared Git state is mutated in short, serialized slots: `git fetch --prune`,
  worktree creation and removal, local branch deletion, and merging belong to
  the lead of a parallel run or happen one lane at a time on a shared machine.
  A lane commits and publishes its own branch from its own worktree; that is
  not a shared mutation. Nobody holds a slot across implementation, test runs,
  or a remote wait.

### Limits, collisions, and landing

The three-lane limit counts claims visible on GitHub per repository: open
implementation Pull Requests plus claim branches without one. Assigned or
planned work with neither is not a running lane.
`bash "${AGENT_KIT_HOME:-$HOME/.agents/agent-kit}/skills/deliver-ready-issue/scripts/issue-lane.sh" capacity`
prints the count; `issue-lane.sh claim` refuses when remaining capacity is
zero.

Parallel lanes must not collide. Collision surfaces in this repository are
`src/erp.ts`, `src/portal.ts`, `src/server.ts`, `src/chaos.ts`, `src/rng.ts`,
`compose.yaml`, and `package.json`/`pnpm-lock.yaml`. Lanes that would both
change one of these surfaces run in sequence, not in parallel.

A lane publishes its first Verified commit to the claim branch as a draft Pull
Request that closes the Issue and may list public lane fields only: claim
branch, repo-relative worktree (for example `.worktrees/issue-N`, never an
absolute path), base SHA, published SHA, and authority ceiling. Never hostname,
FQDN, home path, absolute worktree path, LAN or employer network name, or other
environment inventory. Keep absolute paths and machine or host names in the
private agent session only. It marks the Pull Request ready when verification
and review are complete. Immediately before publishing, the lane fetches and
confirms that the default branch is an ancestor of its head; it refreshes onto
`main` only for a conflict, a failing gate, an explicit request, or a sibling
landing on a shared surface, not merely because `main` advanced. Publish and
land with `issue-lane.sh push` and `land` (see "Verified commits on GitHub").

After each merge, fetch, recompute the frontier, and let the remaining lanes
recheck `mergeable` against the new `main`.

The lead of a parallel run keeps a ledger per lane: Issue, branch, base SHA,
owner, state, Pull Request, evidence, blockers, and cleanup. Report verified
outcomes, not launched work. Keep hostnames and absolute checkout paths in the
session with the maintainer, never on GitHub. The executable lead procedure is
`references/parallel-delivery.md` of the shared `deliver-ready-issue` Skill.

## Shared agent skills

The workflow Skills (`advance-issue-frontier`, `assess-change-impact`,
`capture-project-decision`, `deliver-ready-issue`, `prepare-release`,
`refactor-docs`, `shape-work-item`, `technical-documentation`, `verify-change`)
are canonical in [Sannrox/agent-kit](https://github.com/Sannrox/agent-kit).
There is no pin: this repository always uses the latest `main`.
`.agents/skills/<name>/` holds only a generated stub that points to the shared
skill; read the installed skill under `~/.agents/agent-kit/` (or
`$AGENT_KIT_HOME`). Run `bash scripts/validate-workflow-skills.sh` to clone or
update it.

- Repository-specific facts the shared Skills need come from this file: the
  structure, parallel-lane and testing sections, plus
  `## Agent skill profile` below for anything they do not already say. Edit
  this file, not the stubs.
- Never edit the stubs or the vendored `scripts/validate-workflow-skills.sh`
  here; change them upstream in agent-kit, then run
  `bash scripts/validate-workflow-skills.sh --render` here when it reports
  drift.
- Repository-only Skills live next to the stubs as full folders and stay local.

## Agent skill profile

Facts the shared agent-kit skills read that the sections above do not already
state.

Feature: a new observable rehearsal outcome.

### Compatibility and failure obligations

Same seed, same activity steps and same accepted bookings produce the same
stored rows and the same carriers; a new booking sets `shipments.carrier_id` in its own transaction.
The portal contract stays a bearer token, cursor pagination, and an
`Idempotency-Key` (`201` create, `200` replay, `409` reuse, `404` unknown
carrier or shipment). Schema awkwardness is intentional
and must survive a change. Switches and bookings are durable when a database is
configured; portal-only mode keeps them in memory.

### Verification matrix

Rows beyond `## Testing Guidelines`:

| Surface | Required evidence |
| --- | --- |
| portal HTTP | `node:test` against an ephemeral portal-only server |
| ERP schema, seed, activity, truth | typecheck; a seeded run with `/truth` checksums when the database is involved; compare scores exact, drop, extra and alter; a connector-role reader sees seven steps of inserts, updates and the hard delete |
| database TLS | a client that verifies against `tls/ca.crt` connects; the same client without the authority is refused; a plain connection still works |
| portal HTTPS | a client that verifies against the generated authority reads a page and books; a name set by `KEIKO_TLS_NAMES` verifies; a client without the authority is refused |
| control switches | a test for the one behaviour each switch changes |
| agent-kit stubs | `bash scripts/validate-workflow-skills.sh` |

### Release audit

- `package.json` version and lockfile;
- portal routes, pagination, and booking idempotency;
- ERP tables and the awkward columns;
- connector role (`connector` / `keiko`) is read and replication only;
- environment variables (`KEIKO_SEED`, `KEIKO_SIZE`, `KEIKO_PORT`,
  `KEIKO_DB_PORT`, `KEIKO_DATABASE_URL`, `KEIKO_PORTAL_TOKEN`,
  `KEIKO_PORTAL_ONLY`, `KEIKO_HOST`, `KEIKO_TLS_CERT`, `KEIKO_TLS_KEY`,
  `KEIKO_TLS_NAMES`);
- image pins (`postgres:17-alpine`, the `node` base in `Dockerfile`) and the
  compose service names `db` and `keiko`, which other networks address;
- seeding from compose never replaces a seeded database;
- the published image `ghcr.io/sannrox/keiko:v<version>`, and the tenkai
  manifest's product name, ports and uninstall that keeps volumes;
- throwaway TLS authority path `tls/ca.crt` (gitignored).

## Security & Configuration

Never commit secrets, tokens, `.env`, or local database state. The default
portal token and database password are fixtures for rehearsal, not production
credentials. Publish the server and database on loopback only; inside a
container the server listens on all interfaces. Never put hostnames, FQDNs, home
directories, absolute worktree paths, LAN or employer network names, or other
private environment inventory on public Issues, Pull Requests, comments, or
commit messages.
