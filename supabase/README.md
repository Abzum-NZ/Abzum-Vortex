# Supabase database project

## Operational reference

This is the repository's official Supabase CLI project. It is operational
configuration, migrations, canonical functions and synthetic seed data, not a
workspace package and not an application data model.

| Path | Purpose |
|---|---|
| `config.toml` | Local Supabase services and ports. It contains no credential. |
| `migrations/` | Immutable timestamped changes created with `pnpm db:new <name>`. |
| `schemas/` | One canonical source file per function, under `<schema>/<function>.sql`. |
| `seed.sql` | Synthetic Local and Testing data only. Production never applies it. |

## Canonical database-function source

The complete migration and canonical-function rule is in [schemas/README.md](schemas/README.md).

## Optional local database operations

Use pnpm db:start, pnpm db:stop and pnpm db:reset for interactive development with the Local
Supabase stack.

`pnpm db:start` first prepares a Local-only P-256 `ES256` signing key through the pinned Supabase
CLI. The key is generated once per checkout and reused: it is kept in the ignored `supabase/.temp`
file that `config.toml` reads, and for a linked worktree the shared copy is resolved from the main
checkout and copied in, so a reset in any worktree keeps the same key id for the shared Local stack.
No hosted signing key is downloaded or committed, and no private key is ever committed. After
changing signing-key settings, restart the Local stack with `pnpm db:stop` followed by
`pnpm db:start`.

Identity-session delivery adds a narrow runtime-only, non-mutating projection read. Session bootstrap
may call the existing idempotent ensure operation once; ordinary protected resolution must use the
read operation so a missing projection is never recreated as a side effect of checking liveness.
Supabase Auth remains the durable session store and Vortex adds no database session relation.

The database baseline covers `public`, and the private `vortex_platform`, `vortex_identity`,
`vortex_definition`, `vortex_access` and `vortex_record` schemas, plus the generated `record_data`
schema.

## Roles and request context

### Platform migrations and generated business storage

Reviewed timestamped migrations install or change platform schemas, including the
generic [Record provisioner](../docs/specification/17-runtime-storage-and-caching.md#record-storage-provisioning).
That closed operation creates/evolves business storage from exact immutable
published definitions during application installation. It does not require a
per-customer repository migration or write a second platform migration history.
`supabase_migrations.schema_migrations` remains the platform delivery ledger;
the private Record catalogue records domain storage mappings and provision state.

The generated Record objects have a narrowly privileged non-login owner. Only
the fixed Module coordinator is callable by the request role; the internal DDL
helper is private. No runtime/login role inherits the object owner or receives
DDL rights. New owner roles require their own default-privilege revocations in
addition to explicit grants/revokes on each generated object; the `postgres`
default-privilege baseline below does not automatically apply to another owner.
Generated record adapters remain subject to row policies and field bounds.

### Request connection

The Supabase project owner is an operational credential used by Kestra for
migrations and controlled database verification. Vercel never receives it.
The server runtime instead connects as the restricted `vortex_runtime` login.
Inside one explicit transaction, that role establishes one complete
transaction-local context through its private initializer, which stores the
validated context in the owner-only `vortex_platform.request_contexts` row for the
current backend and transaction and refuses re-establishment; a value written
into any session setting is ignored, and neither login role can read or write the
table. The same statement then enters the non-login `vortex_request` role with a
transaction-local `set_config('role', 'vortex_request', true)` before protected work.
Only `vortex_runtime` may execute the initializer; only `vortex_request` may
execute the read-only context accessors used by policies and service SQL.
Commit or rollback ends the transaction-local role. The context row outlives the
transaction but is bound to its identifier, so no later transaction on a pooled
connection can read it; each must establish its own.

For a human organisation request, the browser supplies only one untrusted
organisation identifier. The Identity service resolves the exact active identity,
tenant, organisation and organisation account; Access composes that scope with
its current version. Resolution, context initialisation, the request-role switch, live
validation and protected work remain in the same transaction. Shared locks keep
the resolved Identity and Access rows stable until that work finishes. The
`vortex_request` role has no Identity-schema access and receives only the exact
Access validator needed to confirm the live scope. Rich account-list and
standalone Access-version reads are not runtime grants.

Local and pgTAP checks may connect as the local owner and switch to the request
role to prove its restrictions. An owner-control assertion may prove that a
refused row exists, but it never represents an application success path.
A suite that switches account mid-transaction clears the owner row
(`delete from vortex_platform.request_contexts where backend_pid = pg_catalog.pg_backend_pid();`)
before initialising again.

Before the Access service is available, the private Definition entry points accept only a validated
system context. They derive tenant, organisation, actor, and time from trusted context/database state,
allocate root and contained-component identifiers inside PostgreSQL, and expose no underlying table
permission. The trusted Definition service supplies parsed authored source, source-derived identity
requirements, and an expected draft revision, but no permanent identifier, organisation, actor,
timestamp, or stored publication evidence comes from its caller. Source owner and alias rows are
append-only. Nested components use a stable parent-owner scope alongside their current key-based
compiler lookup scope, so a parent-key rename preserves child identifiers and retains every historical
alias. Each draft also stores its exact current source-derived requirements, so publication preparation
returns only current aliases while immutable earlier releases keep their own resolution snapshots.

Definition publication preparation reads the organisation-owned draft, immutable history, permanent
identity evidence and available exact Module releases through narrow operations. Publication then locks
the root and draft and appends the authored source, complete canonical compilation output, exact resolution
snapshot, exact dependency manifest, actor and database time as one immutable effect before advancing only
that root's current discovery pointer. The append refuses a root that already has 10,000 releases before
writing anything. The two-connection proof verifies that only one publication from the
same draft can commit and that an Application's prepared exact Module release is not retargeted when a newer
Module release commits concurrently.

### Private service-schema pattern

Every migration that introduces a private service schema applies this pattern,
replacing `<service_schema>` with its neutral schema name. Default privileges
protect future objects only, so the same migration must also revoke and grant
the exact privileges for every object it creates.

```sql
create schema <service_schema> authorization postgres;
revoke all on schema <service_schema>
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant usage on schema <service_schema> to vortex_request;

alter default privileges for role postgres in schema <service_schema>
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema <service_schema>
  revoke all on sequences from public, anon, authenticated, service_role;
```

The database baseline separately applies this owner-wide function default once:

```sql
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;
```

PostgreSQL's built-in function default grants `EXECUTE` to `PUBLIC`. A
schema-limited revoke cannot subtract that global default, so each callable
function receives its exact execution grant only after this owner-wide baseline.

PostgreSQL grants temporary-relation capability through the database-wide
`PUBLIC` role by default. This baseline leaves that Supabase-managed default
unchanged: temporary relations are session-local, never service storage or
authority, and are outside the persistent ownership restriction.

Supabase Auth sends verification and recovery messages through its configured
SMTP provider. The commented `[auth.email.smtp]` template in `config.toml` names
`env(VORTEX_AUTH_SMTP_HOST)`, `env(VORTEX_AUTH_SMTP_USER)`,
`env(VORTEX_AUTH_SMTP_PASSWORD)`, and `env(VORTEX_AUTH_SMTP_FROM_ADDRESS)` for
environment-specific Auth configuration; it commits no credential values.
Supply them from an environment-scoped Doppler configuration consumed only by
the matching Supabase Auth project, separate from the Vercel-synchronised roots
and the Operations environment. In particular, the SMTP password never enters
a Vercel-synchronised config. The Supabase Auth/email operator owns provider
credential rotation, updates that environment's Auth configuration, and
verifies delivery before retiring the prior credential. Local Auth continues
to use Mailpit.

Vercel runtime traffic uses Supabase's shared transaction pooler on port 6543
with prepared statements disabled and verifies the certificate and hostname.
`VORTEX_RUNTIME_DATABASE_URL` and `VORTEX_RUNTIME_DATABASE_SSL_ROOT_CERT` live
in the Doppler `stg` and `prd` root configs; `VORTEX_MIGRATION_DATABASE_URL`,
`VORTEX_MIGRATION_DATABASE_PASSWORD`, and `VORTEX_DATABASE_SSL_ROOT_CERT` live
only in the unsynced `ops_stg` and `ops_prd` configs of the separate Doppler
`Operations` environment.
The migration URL never embeds a password; the separate raw password supports
reserved characters without URL-encoding ambiguity.

Migrations deliberately create `vortex_runtime` without a password. Hosted
provisioning generates a different high-entropy password for each environment,
assigns it through the Supabase administrative path, and stores it only inside
that environment's complete `VORTEX_RUNTIME_DATABASE_URL`. The database
operator owns rotation of each environment's `vortex_runtime` password and its
matching Vercel-synchronised Doppler root config. After the exact
Doppler-to-Vercel sync and redeployment, the operated proof must verify a real
protected request. Never copy the project-owner password, a migration variable,
a general `DATABASE_*` variable, an SMTP credential, or a Kestra credential into
a Vercel-synchronised config.

The database operations operator owns the separate project-owner and migration
credentials in the unsynced `Operations` environment. Rotation updates only the
matching `ops_stg` or `ops_prd` config and the reviewed migration path; those
credentials are never copied into Vercel or exchanged for a runtime password.

Never edit a migration after it has reached Testing or Production. Correct it
with a later migration. Never place customer data, a database address, or a
credential in this directory.
