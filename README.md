# Abzum Vortex

Vortex builds business applications from versioned definitions: modules, record types, fields,
relationships, pages, permissions, actions, flows, connections and themes. It serves multiple
organisations through one application, with access enforced by the platform and the database.
Generic engines and the Next.js application render and execute those definitions. Application
flows run in the in-house flow engine; the only back end is its simulated adapter.

The [target architecture](docs/architecture/target-architecture.md) is binding, and the
[specification](docs/specification/README.md) describes product functionality. Repository rules are
in [AGENTS.md](AGENTS.md).

## Documents

| Path | Holds |
| --- | --- |
| `docs/specification` | Product requirements and data contracts |
| `docs/architecture` | Target architecture, architecture decisions, and design documents for the data grid, module and record storage, the Landing Zone and Studio |
| `docs/demo-walkthrough.md` | A scripted tour of the local demo |
| `packages/platform/README.md`, `supabase/README.md`, `supabase/schemas/README.md`, `workflows/kestra/README.md` | The folder each sits in |

## Development

Use Node 24 and the pnpm version pinned in [package.json](package.json). Dependency versions live in
the workspace catalogue and the lockfile. The development server binds to `localhost`.
Authentication and protected data operations need the environment configuration and database below;
installing packages alone does not configure them.

### Local setup

A fresh local database has no organisation, so a signed-in developer sees "No organisations
available". `pnpm demo:setup` is the one-command path: it creates a confirmed local owner account and
runs the protected development setup. It requires the local Supabase stack to be running and never
resets the database. Never point it at a hosted database.

1. Install dependencies, start the local stack, and copy the environment example:

   ```sh
   pnpm install --frozen-lockfile
   pnpm db:start
   cp apps/web/.env.example apps/web/.env.local
   ```

   Fill in the local Supabase publishable key and identity authority UUID. Generate the Query
   continuation key using the command in `.env.example`, and keep the same key for this local
   environment so existing continuation tokens remain valid. Set a local-only password for
   `VORTEX_DEMO_OWNER_PASSWORD`; do not commit `.env.local`.

2. Create the local demo:

   ```sh
   pnpm demo:setup
   ```

   The owner email and password come from `VORTEX_DEMO_OWNER_EMAIL` and
   `VORTEX_DEMO_OWNER_PASSWORD`. The account is confirmed locally, so no email step is required.
   Re-running `pnpm demo:setup` reuses the local database.

3. Start the web application and sign in with the demo account:

   ```sh
   pnpm dev
   ```

   Open `http://localhost:3000` (or the origin in `VORTEX_SITE_URL`). The Landing
   Zone lists the installed applications; further applications are built in App Studio and installed
   from the App Store.

For a manually nominated account or a separate validation organisation, use `pnpm setup:local` after
the account exists in local Supabase Auth. Pass `--first-owner-email <email>` or
`--first-owner-identity-id <uuid>` plus `--local-development`. The optional `--tenant-short-name` and
`--organization-short-name` flags accept lowercase underscore keys such as `val_demo`.

The setup works through the protected entry points only (no table is written directly): it
provisions the development tenant and organisation with the nominated account as steward, publishes
and installs the shipped core applications, and assigns the shipped role templates to the owner. The
configured manifest is `apps/web/scripts/development-setup/manifest.ts`. Management status or a
first sign-in never implies application permission: the account can use only the roles explicitly
assigned through the protected Access operations.

An interrupted `pnpm setup:local` run resumes from identifiers recorded in
`supabase/.temp/development-setup-state.json`. Provisioning and record saves replay by their stable idempotency keys, and re-running setup
for the same organisation reuses its releases, installations and role assignments. A different
nominated account is refused, as is old, mismatched or orphaned state. Run `pnpm db:reset` before setting
it up again; the reset clears the state only after the database reset succeeds.

### Local environment variables

`pnpm dev`, `pnpm demo:setup`, and `pnpm setup:local` read server-only values from
`apps/web/.env.local` and the other local Next.js environment files. Copy
[apps/web/.env.example](apps/web/.env.example) and fill in local values only; never commit a real
value. `pnpm db:start` prints the local API URL and publishable key. Setup commands refuse any
environment or database that is not the local one.

Each environment must set `VORTEX_SESSION_COOKIE_NAME`; Testing and Production use a secure
host-only name beginning with `__Host-`.

The custom-component and file pages read additional variables and report a configuration error until
they are set: `VORTEX_COMPONENT_BUNDLE_ORIGIN`, `VORTEX_FILE_STORAGE_SIGNING_KEY` and
`VORTEX_FILE_STORAGE_SIGNING_KEY_ID`. For private files, `VORTEX_ENVIRONMENT=local` accepts only a
loopback HTTP Supabase origin with an explicit port. File routes use the ignored
`supabase/.temp/signing-keys.json`. Tenant provisioning derives the destination project from
`VORTEX_SUPABASE_URL` in every environment and persists it in `vortex_platform.storage_destination`
in the same transaction. The project is immutable after provisioning. `VORTEX_CLUSTER_ID` and
`VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID` are not needed locally: `pnpm setup:local` takes the
configured operator from its manifest.
