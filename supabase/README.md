# Supabase database project

This is the repository's official Supabase CLI project. It is operational
configuration, migrations, synthetic seed data, and database tests—not a
workspace package and not an application data model.

| Path | Purpose |
|---|---|
| `config.toml` | Local Supabase services and ports. It contains no credential. |
| `migrations/` | Immutable timestamped changes created with `pnpm db:new <name>`. |
| `seed.sql` | Synthetic Local and Testing data only. Production never applies it. |
| `tests/` | pgTAP tests run with `pnpm db:test`. |

## Local database gate

A Docker-compatible container runtime must be running. From the repository
root:

```text
pnpm db:start
pnpm db:verify
pnpm db:stop
```

`pnpm db:start` first generates a Local-only P-256 `ES256` signing key through the pinned Supabase
CLI. The private key stays under the ignored `supabase/.temp` directory; a clean checkout creates its
own key and no hosted signing key is downloaded or committed. After changing signing-key settings,
restart the Local stack with `pnpm db:stop` followed by `pnpm db:start`.

With the Local stack running, `pnpm auth:local:proof` creates an isolated local address and proves
Mailpit confirmation, password sign-in, local `getClaims()` verification against the published
ES256 JWKS, and password-recovery delivery. It does not configure Testing or Production and does not
exercise durable application sessions.

Identity-session delivery adds a narrow runtime-only, non-mutating projection read. Session bootstrap
may call the existing idempotent ensure operation once; ordinary protected resolution must use the
read operation so a missing projection is never recreated as a side effect of checking liveness.
Supabase Auth remains the durable session store and Vortex adds no database session relation.

`db:verify` rebuilds the local database from committed migrations and seed
data, runs every pgTAP test, proves tenant hierarchy, invitation acceptance, Access-version increments,
organisation-context suspension/version races, lifecycle and Definition publication races through two real database connections, and fails database lint on errors. It is separate
from `pnpm verify`: Vercel previews and ordinary pull-request checks remain
database-free.

Lint is restricted to Vortex-owned schemas. The database baseline covers
`public`, `vortex_context`, and the private `vortex_identity`, `vortex_definition` and `vortex_access` schemas. Each
issue that introduces another private service schema must add it to the local and operated lint
commands in the same change. Supabase-managed extension functions are deliberately excluded because
their diagnostics are owned by the installed platform image, not this repository.

## Roles and request context

The Supabase project owner is an operational credential used by Kestra for
migrations and controlled database verification. Vercel never receives it.
The server runtime instead connects as the restricted `vortex_runtime` login.
Inside one explicit transaction, that role establishes one complete
transaction-local context through its private initializer and then enters the
non-login `vortex_request` role with `SET LOCAL ROLE` before protected work.
Only `vortex_runtime` may execute the initializer; only `vortex_request` may
execute the read-only context accessors used by policies and service SQL.
Commit or rollback clears the role and context before a pooled connection can
be reused.

For a human organisation request, the browser supplies only one untrusted
organisation identifier. The Identity service resolves the exact active identity,
tenant, organisation and organisation account; Access composes that scope with
its current version. Resolution, context initialisation, `SET LOCAL ROLE`, live
validation and protected work remain in the same transaction. Shared locks keep
the resolved Identity and Access rows stable until that work finishes. The
`vortex_request` role has no Identity-schema access and receives only the exact
Access validator needed to confirm the live scope. Rich account-list and
standalone Access-version reads are not runtime grants.

Local and pgTAP checks may connect as the local owner and switch to the request
role to prove its restrictions. An owner-control assertion may prove that a
refused row exists, but it never represents an application success path.

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

Later pgTAP suites include
`tests/helpers/private-schema-assertions.psql` and call
`pg_temp.vortex_private_schema_assertions(...)`. The reusable assertions prove
the schema owner, direct Data API denial, public creation denial, and absence of
future-object default grants without installing any permanent test function.
Ordinary service schemas omit the helper's optional runtime-usage flag. The
`vortex_context`, `vortex_identity` and `vortex_access` schemas pass `true` only where their
named runtime functions require schema usage; object execution remains
explicitly granted. `vortex_identity` gives `vortex_request` no schema usage or function grant in
Phase 2. Runtime invitation acceptance is available only through `vortex_access`, which commits the
Identity transition and organisation version increment together. Its generic increment, initialisation
and account-administration composition remain owner-only; #30 must perform permission checking before
the latter becomes an authenticated command. Neither runtime role receives direct relation access.

PostgreSQL grants temporary-relation capability through the database-wide
`PUBLIC` role by default. This baseline leaves that Supabase-managed default
unchanged: temporary relations are session-local, never service storage or
authority, and are outside the persistent ownership restriction.

Vercel runtime traffic uses Supabase's shared transaction pooler on port 6543
with prepared statements disabled. Kestra delivery uses the session pooler on
port 5432. Both routes verify the certificate and hostname.
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
that environment's complete `VORTEX_RUNTIME_DATABASE_URL`. After the exact
Doppler-to-Vercel sync and redeployment, the operated proof must verify a real
protected request. Never copy the project-owner password, a migration variable,
a general `DATABASE_*` variable, or a Kestra credential into a Vercel-synchronised
config.

Never edit a migration after it has reached Testing or Production. Correct it
with a later migration. Never place customer data, a database address, or a
credential in this directory.
