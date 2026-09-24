# The workflow engine

## Current development policy — 21 September 2026

The [current roadmap](../../docs/build-plan/README.md) and [architecture review](../../docs/build-plan/architecture-review-2026-09-21.md) govern implementation work. Development completion is implemented functionality plus independent code review. Do not create or run tests, require database review, collect hosted proof, or introduce verification/promotion gates for these development issues.

This policy supersedes contrary completion or standing-authority wording below. The recipes and environment observations below are separate, optional operational documentation. They describe existing tooling and historical operational practices; they are not developer completion instructions and do not authorize running commands, starting recurring jobs, deploying, recovering data, changing credentials or modifying Production. Any operational work requires a separately scoped request for that environment and action. Reading this file or finishing a development issue grants no Production authority.

Preserve runtime access controls, tenant isolation, atomic changes, protected credentials and safe error handling. This policy changes completion requirements, not those product protections.

## Operational reference

Kestra open source runs on the Coolify-managed server with its own PostgreSQL. It is the workflow and
operations service in the [current hosting boundary](../../docs/specification/17-runtime-storage-and-caching.md#hosting-boundaries).
It runs durable application workflows and reviewed operational jobs such as database migration,
verification, backup, and recovery.

No application user sees it. The Vortex Workflow service operates customer-authored workflows
through the [protected-operation boundary](../../docs/specification/09-workflows-and-pipelines.md#protected-operation-contract).
Operational flows remain separate and use their own narrow credentials.

## What is here

| File | Holds |
|---|---|
| `Dockerfile` | The pinned Kestra operations image with checksum-verified Supabase and Doppler command-line tools |
| `docker-compose.yml` | The stack Coolify deploys: Kestra and its own PostgreSQL |
| `flows/` | Reviewed operational flows. Operational database delivery is separate from the roadmap; application workflow execution is scheduled in phase 9. |
| `scripts/` | Reviewed commands called by operational flows; these are not available as application workflow nodes |
| `tests/` | Credential-free contract checks for the operational delivery boundary |

## How it is deployed

Coolify deploys this directory from the repository rather than from a compose file pasted into its
interface, so the stack is reviewed and versioned like anything else, and a change to it arrives by
pull request.

The `flows/` directory and operational scripts are copied into the pinned Kestra image at build time,
and the flow directory is passed to Kestra's official `--flow-path` startup option. Baking them into
the image is required because Coolify removes its temporary checkout after deployment; a relative
runtime bind mount would become an empty host directory. Every reviewed Coolify deployment therefore
validates and creates or updates these flows in Kestra's PostgreSQL repository. Removing an
operational flow is an explicit reviewed deletion; a missing file is not silently interpreted as
permission to erase stored operational state.

The one-time delivery-engine bootstrap pins Coolify to the exact commit SHA approved in the pull
request and disables automatic branch redeployment. It does not point the operated service at a
moving feature or Testing branch. After that exact commit merges to `testing`, the protected event is
replayed against the pinned engine and must produce successful Testing evidence. Only then is the
same revision promoted to `main`; Coolify returns to the protected `main` source at that commit and
normal automatic deployment begins. The bootstrap never authorises a Production database change.

## Secrets

Every secret is supplied by the environment. Nothing in this directory holds one.

| Variable | What it is |
|---|---|
| `KESTRA_DB_PASSWORD` | The password for Kestra's own PostgreSQL |
| `KESTRA_BASIC_AUTH_USERNAME` | The account the API and interface demand |
| `KESTRA_BASIC_AUTH_PASSWORD` | Its password |
| `KESTRA_PUBLIC_URL` | The public Kestra address used in generated links |
| `VORTEX_TESTING_MIGRATION_WEBHOOK_KEY_BASE64` | Base64 encoding of the unpredictable key for the protected Testing push webhook |
| `VORTEX_PRODUCTION_MIGRATION_WEBHOOK_KEY_BASE64` | Base64 encoding of a different unpredictable key for the protected Production push webhook |
| `VORTEX_TESTING_DOPPLER_TOKEN_BASE64` | Base64 encoding of the read-only service token limited to `abzum-vortex` / `ops_stg` |
| `VORTEX_PRODUCTION_DOPPLER_TOKEN_BASE64` | Base64 encoding of the separate read-only service token limited to `abzum-vortex` / `ops_prd` |
| `VORTEX_EVENT_DISPATCH_WAKEUP_URL_BASE64` | Base64 encoding of the protected Vercel dispatch route address for scheduled event recovery |
| `VORTEX_EVENT_DISPATCH_WAKEUP_CREDENTIAL_BASE64` | Base64 encoding of the dispatcher route bearer credential, the same value whose SHA-256 digest is configured in Vercel and whose raw value is a database server setting |

These Kestra bootstrap values are stored only as protected Coolify runtime variables. Doppler
remains the source of record for the database values that the two service tokens can read. The
Kestra API credential is also provided to the web application so it can reach the engine.

`event_dispatch_recovery` is the scheduled recovery half of the event dispatch boundary. Its
schedule trigger calls the protected Vercel dispatch route every five minutes, so an event
occurrence committed while a database-webhook hint or a web deployment was unavailable is still
delivered. After a Kestra outage it runs one catch-up tick rather than every missed interval, and an
overlapping tick is cancelled because the running one already covers it. The flow holds only two
values: the route address and the route bearer credential. It never receives a database URL,
migration credential or application secret, and it never reads the database. The route accepts
only an optional `source` label and refuses any batch or consumer tuning.

The same route credential authenticates the normal database-webhook hint: the database server
carries the raw credential as the `vortex.event_dispatch_wakeup_bearer` setting while Vercel carries
only its SHA-256 digest in `VORTEX_EVENT_DISPATCHER_CREDENTIAL_SHA256`. Database sessions can read
that setting, so the credential must authorise nothing beyond the bounded dispatcher wake-up. The
database hint is installed by the `20260923173000_event_dispatch_wakeup` migration, reads
`vortex.event_dispatch_wakeup_url` and `vortex.event_dispatch_wakeup_bearer` at runtime, queues at
most one request per appending transaction and sends it only after that transaction commits. It
sends nothing when either setting is absent or unusable, so missing configuration fails closed
without breaking a committed record save.

Kestra open source recognises sensitive flow values only when the container variable begins
`SECRET_` and its value is base64-encoded. Coolify therefore stores the `_BASE64` values above;
the compose file maps them to Kestra's required names and each flow reads them with `secret()`. Base64
is not encryption, so Coolify remains the protected host boundary. Kestra masks resolved secrets in
execution logs.

Webhook keys authenticate only GitHub-to-Kestra delivery endpoints; they do not authorize Doppler
or database access and do not replace the branch, repository,
commit, migration-set, or approval checks performed by the flow. The two Doppler tokens are runtime
bootstrap credentials. The delivery process asks Doppler only for the existing database connection
and password plus the Supabase root certificate.

Database delivery uses the unsynced `ops_stg` and `ops_prd` configs under the `abzum-vortex`
project's separate `Operations` environment. The `Operations` root contains only the three Testing
migration values; `ops_stg` inherits them, while `ops_prd` overrides the Production URL and password
and inherits the common Supabase certificate. The `stg` and `prd` roots continue to sync restricted
application-runtime values to Vercel; no Operations config has an external sync. Keeping Operations
separate is required because Doppler branch configs inherit every root secret. The
delivery script retrieves only `VORTEX_MIGRATION_DATABASE_URL`,
`VORTEX_MIGRATION_DATABASE_PASSWORD`, and `VORTEX_DATABASE_SSL_ROOT_CERT`. The migration URL contains
the project-owner username, session-pooler host, port, and database but deliberately contains no
password; the separate password value remains raw so reserved characters require no URL encoding.
The script accepts only
Supabase's IPv4 session pooler on port 5432,
the `postgres.<project-ref>` owner and the `postgres` database. Each reviewed flow also carries the
exact non-secret Supabase project reference for its environment, so swapping the `stg` and `prd`
database addresses is refused before any connection is opened. It confirms that the separately read
credential-free URL names the approved owner, project, host, session-mode port, and database, then
adds `sslmode=verify-full`. The separate raw password travels through `PGPASSWORD`, not a command
argument or logged address. The certificate is the project Server root certificate downloaded from
Supabase Database Settings. Backup, restore, web, and connection-provider secrets remain in other
environments or projects, so a
migration process cannot receive them accidentally.

The config-scoped read-only service token reaches Doppler through the process environment, not a
command argument. Every secret request still supplies the reviewed project and config explicitly;
the token is removed from the delivery process before any database command runs.

Rotate one environment at a time under a recorded change: create the replacement Doppler token or
webhook key, update only the matching Coolify runtime variable and GitHub webhook, redeploy Kestra,
prove delivery from the matching protected branch, then revoke the previous value. Never reuse a
Testing value in Production. A periodic inventory check must reconcile the two active Coolify token
copies with the two active read-only Doppler tokens and confirm that Preview and build-time scopes
cannot receive them.

The Kestra environment makes these operational bootstrap values available to reviewed flow
definitions. Vortex builders cannot upload Kestra YAML, choose a Process runner, interpolate Kestra
environment values, or invoke an operational script. Application workflows are compiled from the
published generic node catalogue and call protected Vortex operations; adding any raw command node
would be a separate security decision and is refused by the current specification.

## The application instance holds only the callback key

Kestra open source lets any namespace read any instance secret, so customer flows must never share an
instance with Vortex's operational secrets. Two separate instances exist:

| Instance | Directory | Holds |
|---|---|---|
| Operations (this directory) | `workflows/kestra/` | Vortex's own reviewed delivery flows and their operational bootstrap secrets |
| Application | `workflows/kestra/application/` | Customer durable flows and exactly one flow secret, the callback signing key |

The application instance's environment holds exactly one flow secret,
`VORTEX_WORKFLOW_CALLBACK_KEY`. It holds no delivery, database or provider secret: the delivery
webhook keys, the Testing and Production Doppler tokens and the event-dispatch credential above
exist only in this operations instance. Its own PostgreSQL password and interface basic-auth
password are engine bootstrap values supplied from the deployment environment, and they are never
available to a customer flow as a secret. The application instance bakes no operational flow or
script and starts with no `--flow-path`.

The Workflow service's registration and start adapters resolve their provider target only through
`runtime/workflow/src/kestra-instance.ts`, which knows only the application instance and exposes no
operations address, credential or secret. An operational secret must never be added to the
application instance's environment, and no Workflow adapter may be pointed at this operations
instance.

## Database delivery

`testing_database_delivery` accepts the GitHub push webhook for `refs/heads/testing`, fetches the
exact commit, proves that it remains reachable from that protected branch, and applies its ordered
Supabase migrations. The committed selector compares the target with the latest authenticated
successful ancestor. A direct edit to an existing SQL suite or concurrency proof can run only that
check; protected, broad, new, deleted, replaced, reverted, unmapped or ambiguous input executes the
complete remote pgTAP, concurrency-proof and schema-lint set. The image-baked script is a small provenance bootstrap: it accepts only this fixed
repository, the environment's protected ref, the selected full commit and the fixed runner path. It
then executes that commit's regular checked-out runner. The runner and Local database commands read
the same strict verification manifest, which must name every concurrency proof and every schema
created by the migration set. A stored older supported bootstrap therefore cannot silently retain an
older proof list or override the schema scope for the commit being delivered.
Before selecting any subset, the selector applies that same manifest boundary: every paired
migration and proof must exist, every operated schema created by the migration set must be linted,
and only the runner's non-empty concurrency-proof filename form is accepted.
The committed selection inventory groups verification checks; it does not group migrations. Any
changed `supabase/migrations/*.sql` file forces the complete SQL, concurrency, and lint set, so
migration filenames, formatting, and inferred function ownership never narrow that coverage.
`supabase test db` deliberately uses a Docker helper, so it remains the
local-development command and is not used by the operated flow: Kestra does not receive the host
Docker socket. Only complete coverage writes credential-free schema-3 evidence. Its required
inventory is the disjoint union of checks freshly executed now and checks backed by a directly
authenticated fresh receipt; a reused check receipt can never become another source. Each source
receipt is retained under an execution-specific immutable key, while the mutable baseline contains
bounded copies of only the direct source receipts needed by the latest successful commit. Before
reuse, the runner hashes a data-free catalog/security snapshot covering operated schemas, relations,
columns, constraints, indexes, policies, functions, default privileges, Vortex roles and extensions.
Malformed, foreign, failed, replayed or chained sources, a PostgreSQL build change, or unexplained
snapshot drift falls back to full verification. The receipt also records current/baseline identities,
inventory, selector and changed-input digests, reasons, the fresh/reused partition and per-check
timings. Reused checks are absent from the current execution's completed arrays.

`production_database_delivery` performs the same immutable-commit checks for `refs/heads/main` and
prepares a credential-free migration fingerprint before pausing. The operator approves and identifies
the Testing commit; they do not type their own identity, an execution identifier, or a migration
fingerprint. The receipt records the approving Kestra execution, and that execution's audit log holds
the authenticated account that resumed the hold. The Pause task does not expose that account to the
flow, so the receipt references it rather than restating it. Production then
loads the successful Testing evidence itself and hands it to the delivery script as two local files,
`testing-evidence.json` and `testing-full-source-evidence.json`, named by
`VORTEX_TESTING_EVIDENCE_PATH` and `VORTEX_TESTING_FULL_SOURCE_EVIDENCE_PATH`. A complete receipt is
larger than Linux's 131072-byte limit on one environment string, so it is never carried in the
environment; the script refuses a missing, empty, non-regular or non-object file and refuses the
retired `VORTEX_TESTING_EVIDENCE` and `VORTEX_TESTING_FULL_SOURCE_EVIDENCE` variables outright rather
than choosing between them. The delivery script independently proves that the
tested commit is an ancestor of the Production commit and that both revisions contain the same
migration set, commit-owned runner and verification manifest before opening the Production database
connection. The current Production reader remains deliberately narrower than Testing selection: it
accepts only the existing complete schema-3 `full` or direct-full-source `reused` receipt and rejects
selected or aggregate coverage before secret access. Supporting selected receipts in Production is
a separate reviewed rollout, not an inference from one source check. Older receipts remain
historical evidence, but cannot approve the current Production delivery.

Testing execution `7w9iLE15hlvA9ii64ROry` predates this corrected runner boundary. It applied and
ran the SQL suites for commit `50b6d4e2a1b7b079d57f8f15d00ee42a29284780`, but its older image-baked
script ran only three concurrency proofs and linted four schemas. It is retained as partial historical
evidence and is not an all-current-checks receipt for #235 or the final Phase 2 gate.

Both flows queue at concurrency one. Supabase's migration history makes delivery of the same commit
idempotent; the repository does not create another migration ledger. Production never runs seed data,
and neither flow resets a shared database.

GitHub sends every push event to both repository webhooks. Each webhook trigger therefore has an
expression condition: the Testing flow accepts only `refs/heads/testing`, and the Production flow
accepts only `refs/heads/main`. Kestra returns without creating an execution when the condition does
not match.

An exceptional Testing-only recovery is a separate, explicitly authorised operation. Before it
changes anything, it must prove that Testing contains no application tables, identities, storage
buckets or files; record the exact existing migration history and legacy roles; and fingerprint
Production through a read-only query. It may then remove only the verified legacy Testing objects and
replay the reviewed migrations without seed data. Completion requires an exact migration-history
match, all committed pgTAP assertions, clean Supabase security and performance advisers, and a second
read-only Production fingerprint equal to the first. A mismatch stops the recovery. This permission
never applies to Production and is not built into either delivery flow.

The checked-in flow files are validated against the pinned Kestra image before review. Kestra 1.0.57
currently reports its supported `Pause.onResume` field as deprecated during local validation even
though the current official Pause contract documents and uses that field; this warning is recorded
and does not justify an unverified replacement.

For a separately requested operational task, the existing local commands are:

```text
docker compose -f workflows/kestra/docker-compose.yml build kestra
docker run --rm -v <repository>/workflows/kestra/flows:/flows:ro abzum-vortex-kestra:v1.0.57-operations.1 flow validate --local /flows/testing-database-delivery.yml
docker run --rm -v <repository>/workflows/kestra/flows:/flows:ro abzum-vortex-kestra:v1.0.57-operations.1 flow validate --local /flows/production-database-delivery.yml
docker run --rm --entrypoint bash -v <repository>:/source:ro -v <repository>/workflows/kestra/scripts:/app/vortex-operations:ro -v <repository>/workflows/kestra/tests:/tests:ro abzum-vortex-kestra:v1.0.57-operations.1 /tests/deliver-database.test.sh
```

The contract test uses a disposable local Git remote and a credential-free Doppler stand-in. It
proves that an older bootstrap executes a newer reachable commit's runner and expanded manifest,
exact-commit preparation, full, selected and unchanged-descendant receipt shapes, direct-source and
catalog-state fallback, real failed-command propagation, and refusal of an
invalid repository, ref, commit, runner, manifest or Testing receipt. It retains the approval, role,
certificate and exact credential-free `verify-full` address checks even when an unsafe address is
present in the process environment, and refuses a remote migration history containing a file absent
from the selected commit. Actual Testing/Production application remains a remote environment
acceptance check because local evidence cannot prove the configured Supabase projects or their
least-privilege roles, each Doppler token's external scope, or that only the named Production
operator can resume the approval hold.

## Three deliberate departures from Kestra's published compose file

**The Docker socket is not mounted.** Kestra's own file mounts `/var/run/docker.sock` into a
container running as `root`. Anything able to schedule a Docker task could then start a container on
the host with any mount it chose, which is root on the machine that also runs Coolify. This platform
runs customer-defined workflows, so that mount would hand a tenant the host. The Docker task runner
is given up until there is a sandbox for it.

**Both images are pinned.** Kestra's file uses `kestra/kestra:latest`. This repository pins Kestra's
exact release and multi-platform image digest, and pins its state database to an exact PostgreSQL
patch release, distribution and digest. The workflow engine and its database therefore change only
as their own reviewed change, the same rule
[#6](https://github.com/Abzum-NZ/Abzum-Vortex/issues/6) applies to Next.js and Puck.

The image remains temporarily pinned to the exact `v1.0.57` deployment that this repository has
verified. Kestra's current [release policy](https://kestra.io/docs/releases) identifies 1.3 as the
current LTS and states that 1.0 support ends in September 2026; its
[changelog](https://kestra.io/docs/changelog) also records `v1.0.58` after this pin. The required
forward upgrade and state-database compatibility rehearsal belong to
[#198](https://github.com/Abzum-NZ/Abzum-Vortex/issues/198), rather than an unreviewed tag change in
the database-delivery task. A first attempt used `v1.3.35` because it appeared in the release list,
but no image was published under that tag at the time. Confirm the registry artifact and digest before
changing any pin.

A fresh disposable startup with the pinned PostgreSQL 18.4 image succeeds, applies all Kestra
migrations and loads the two reviewed operational flows. Its bundled Flyway nevertheless warns that
PostgreSQL 18 is newer than its tested maximum of 17. Operational database delivery can use this
verified combination. Application-workflow execution [#76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76)
must validate its generated flows, execution and restart behaviour against the existing pinned
runtime; a real compatibility failure is not waived. The user has deferred engine upgrades and
backup work for now. [#198](https://github.com/Abzum-NZ/Abzum-Vortex/issues/198) governs a later
forward upgrade, not a mandatory engine-version change before core workflow implementation.
The existing PostgreSQL 18 data directory must never be opened by PostgreSQL 17.

**No password is written down.** Kestra's file publishes `POSTGRES_PASSWORD: k3str4` in its own
public repository.

## Usage reporting is off

Kestra ships with `anonymous-usage-report.enabled: true`, which posts to
`https://api.kestra.io/v1/reports/server-events` every hour, and a second browser-side report from the
interface. The payload carries the instance and session identifiers, the server type and version, the
host's time zone, and system, feature, service and plugin usage counts. No flow content and no records.

Both are turned off. This engine runs tenants' business processes on a server that also holds its own
database, and a standing hourly call outward from it is a decision, not a default. The
[privacy and operational rules](../../docs/specification/14-activity-privacy-and-retention.md)
refuse unapproved third-party analytics; this is the same rule one layer down.

## Memory

The server has 8 GB and already runs Coolify and a STUN/TURN service. Kestra is a JVM and takes what
it is given, so both containers carry a limit: 3 GB for Kestra, 1 GB for PostgreSQL.

## Recovering

The [workflow recovery contract](../../docs/specification/09-workflows-and-pipelines.md#failure-and-display-behaviour)
requires runs to resume safely when the server returns. That holds only
while `kestra-postgres-data` survives, so it is backed up on a schedule. Losing it loses every run in
flight, and nobody would find out until a restore.

The backup runs nightly and the archive is sent to Cloudflare R2. As of 31 August 2026 no local copy
is kept: the Coolify backup's **Local copy** setting is *Delete after S3 upload*, so the only copy
that survives the server is the one in R2. The full backup and restore procedure, with the checksums
and row counts from a rehearsal, is written out on
[issue #132](https://github.com/Abzum-NZ/Abzum-Vortex/issues/132).

## Checking that the backup still restores

A backup nobody has restored is a guess. `verify-restore.sh` turns that guess into a fact: it pulls
the newest archive from Cloudflare R2, restores it into a throwaway database beside the live one,
checks the flow definitions came back, and drops it again. It fails loudly at every step, so a run
that reports success is a backup that genuinely restores.

It verifies a backup. It does not recover one. Replacing the live database is a decision a person
makes after working out what went wrong, so that stays manual.

### Where the settings live

Doppler project **`abzum-kestra`**, config **`prd`**. That project exists to keep server-side secrets
apart from `abzum-vortex`, whose `dev`, `stg` and `prd` configs all sync to Vercel. Nothing here is
wanted by the web application, and a secret placed in `abzum-vortex` would be pushed to every Vercel
build and function for no reason.

Four of the six values are already there and are not secret: `R2_ENDPOINT`, `R2_BUCKET`, `R2_PREFIX`
and `PG_CONTAINER`. The two credentials, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, are added by
hand.

Doppler has no Coolify sync — its catalogue covers Vercel, Netlify, Render, Fly.io and the rest, but
not Coolify — so the values do not arrive on the server on their own. Install the Doppler CLI there,
give it a service token scoped to `abzum-kestra` / `prd`, and let the script read them at run time:

```
doppler run --project abzum-kestra --config prd -- ./verify-restore.sh
```

Reading them at run time is what keeps the promise that a credential is changed in one place. Copying
the values into Coolify's own environment variables would work today and drift tomorrow, because
rotating the R2 key would then mean remembering to change it twice.

Run it as a weekly Coolify scheduled task on the Kestra resource. Weekly, not nightly — enough to
catch a backup that has quietly stopped restoring while the older copies are still inside the
seven-day retention window.

### The token this needs

Create an R2 API token in Cloudflare with **Object Read only**, scoped to the `abzum-console-backups`
bucket, and put its Access Key ID and Secret Access Key into Doppler under `abzum-kestra` / `prd`.

Read-only is not caution for its own sake. This token sits on the same server as the thing it backs
up. A token that could also write or delete would let anyone who took the server destroy the offsite
copies too, which is the single thing an offsite copy exists to survive. Read-only means the worst
they can do is read backups they already have the database for.
