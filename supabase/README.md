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

`db:verify` rebuilds the local database from committed migrations and seed
data, runs every pgTAP test, and fails database lint on errors. It is separate
from `pnpm verify`: Vercel previews and ordinary pull-request checks remain
database-free.

Lint is restricted to Vortex-owned schemas. The foundation starts with
`public`; each issue that introduces a private service schema must add that
schema to the lint command in the same change. Supabase-managed extension
functions are deliberately excluded because their diagnostics are owned by
the installed platform image, not this repository.

Never edit a migration after it has reached Testing or Production. Correct it
with a later migration. Never place customer data, a database address, or a
credential in this directory.
