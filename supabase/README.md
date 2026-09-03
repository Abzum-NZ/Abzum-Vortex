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

`db:verify` rebuilds the local database from committed migrations and seed
data, runs every pgTAP test, and fails database lint on errors. It is separate
from `pnpm verify`: Vercel previews and ordinary pull-request checks remain
database-free.

Lint is restricted to Vortex-owned schemas. The database baseline covers
`public` and the private `vortex_context` schema. Each issue that introduces a
private service schema must add that schema to the local and operated lint
commands in the same change. Supabase-managed extension functions are
deliberately excluded because their diagnostics are owned by the installed
platform image, not this repository.

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

Local and pgTAP checks may connect as the local owner and switch to the request
role to prove its restrictions. An owner-control assertion may prove that a
refused row exists, but it never represents an application success path.

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
Ordinary service schemas omit the helper's optional runtime-usage flag. Only
`vortex_context` passes `true`, because its initializer is the one declared
runtime exception; object execution remains explicitly granted.

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

Never edit a migration after it has reached Testing or Production. Correct it
with a later migration. Never place customer data, a database address, or a
credential in this directory.
