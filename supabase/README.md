# Supabase database project

This is the repository's official Supabase CLI project: configuration, migrations, canonical functions and synthetic seed data. It is not a workspace package and not an application data model.

| Path | Purpose |
|---|---|
| `config.toml` | Local Supabase services and ports. It contains no credential. |
| `migrations/` | Immutable timestamped changes created with `pnpm db:new <name>`. |
| `schemas/` | One canonical source file per function, under `<schema>/<function>.sql`. The migration and canonical-function rule is in [schemas/README.md](schemas/README.md). |
| `seed.sql` | Synthetic local data only. |

Never place customer data, a database address or a credential in this directory. Never edit a migration that has been applied; correct it with a later migration.

## Local database operations

Use `pnpm db:start`, `pnpm db:stop` and `pnpm db:reset` with the local Supabase stack.

`pnpm db:start` first prepares a local-only P-256 `ES256` signing key through `tooling/supabase/ensure-local-signing-key.mjs`. The key is generated once per checkout and kept in the ignored `supabase/.temp` file that `config.toml` reads. No hosted signing key is downloaded and no private key is ever committed. After changing signing-key settings, restart the local stack with `pnpm db:stop` then `pnpm db:start`.

Supabase Auth remains the durable session store and Vortex adds no database session relation. Ordinary protected resolution uses the non-mutating projection read; only session bootstrap may call the idempotent ensure operation, so a missing projection is never recreated as a side effect of checking liveness.

The database baseline covers `public`, the private `vortex_platform`, `vortex_identity`, `vortex_definition`, `vortex_access` and `vortex_record` schemas, and the generated `record_data` schema. Schema, role and ownership rules are in the [target architecture](../docs/architecture/target-architecture.md#4-database).

## Generated business storage

Migrations install or change platform schemas, including the generic [Record provisioner](../docs/specification/17-runtime-storage-and-caching.md#record-storage-provisioning). That closed operation creates and evolves business storage from exact published definitions during application installation, with no per-customer migration. `supabase_migrations.schema_migrations` is the platform delivery ledger; the private Record catalogue records domain storage mappings and provision state.

The generated Record objects have a narrowly privileged non-login owner. Only the fixed Module coordinator is callable by the request role; the internal DDL helper is private. No runtime or login role inherits the object owner or receives DDL rights. A new owner role needs its own default-privilege revocations in addition to explicit grants and revokes on each generated object; the `postgres` baseline below does not apply to another owner. Generated record adapters remain subject to row policies and field bounds.

## Request connection

The server runtime connects as the restricted `vortex_runtime` login. Inside one explicit transaction, that role establishes one transaction-local context through its private initializer, which stores the validated context in the owner-only `vortex_platform.request_contexts` row for the current backend and transaction and refuses re-establishment. A value written into any session setting is ignored, and neither login role can read or write the table. The same statement then enters the non-login `vortex_request` role with a transaction-local `set_config('role', 'vortex_request', true)` before protected work. Only `vortex_runtime` may execute the initializer; only `vortex_request` may execute the read-only context accessors used by policies and service SQL. The context row is bound to its transaction identifier, so no later transaction on a pooled connection can read it.

For a human organisation request, the browser supplies only one untrusted organisation identifier. The Identity service resolves the exact active identity, tenant, organisation and organisation account; Access composes that scope with its current version. Resolution, context initialisation, the role switch, live validation and protected work happen in the same transaction, and shared locks keep the resolved Identity and Access rows stable until it finishes. `vortex_request` has no Identity-schema access and receives only the exact Access validator needed to confirm the live scope.

The private Definition entry points accept only a validated system context. They derive tenant, organisation, actor and time from trusted state, allocate identifiers inside PostgreSQL and expose no underlying table permission. Source owner and alias rows are append-only.

## Private service-schema pattern

Every migration that introduces a private service schema applies this pattern, replacing `<service_schema>` with its neutral schema name. Default privileges protect future objects only, so the same migration must also revoke and grant the exact privileges for every object it creates.

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

PostgreSQL's built-in function default grants `EXECUTE` to `PUBLIC`, and a schema-limited revoke cannot subtract that global default, so each callable function receives its exact execution grant only after this baseline. Temporary relations stay on the Supabase-managed `PUBLIC` default: they are session-local and never service storage or authority.

## Credentials

Migrations create `vortex_runtime` without a password. Each environment assigns its own high-entropy password and stores it only in that environment's runtime database URL. The project-owner password, migration credentials, general `DATABASE_*` variables, SMTP credentials and service credentials never enter a runtime configuration. Auth SMTP settings are supplied per environment through the `env(...)` references in the commented `[auth.email.smtp]` template in `config.toml`; local Auth uses Mailpit.
