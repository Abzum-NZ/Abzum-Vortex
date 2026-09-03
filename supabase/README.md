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

Lint is restricted to Vortex-owned schemas. The foundation starts with
`public`; each issue that introduces a private service schema must add that
schema to the lint command in the same change. Supabase-managed extension
functions are deliberately excluded because their diagnostics are owned by
the installed platform image, not this repository.

Never edit a migration after it has reached Testing or Production. Correct it
with a later migration. Never place customer data, a database address, or a
credential in this directory.
