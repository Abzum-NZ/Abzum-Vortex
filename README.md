# Abzum Vortex

Vortex builds business applications from versioned definitions: modules, record types, fields,
relationships, pages, permissions, actions, flows, connections and themes. It serves multiple
organisations through one application, with access enforced by the platform and the database.
Generic engines and the Next.js application render and execute those definitions. Application
flows run in the in-house flow engine; the only back end is its simulated adapter.

Working instructions are in [AGENTS.md](AGENTS.md). The
[target architecture](docs/build-plan/target-architecture.md) is binding, the
[specification](docs/specification/README.md) describes product functionality, and the
[build plan](docs/build-plan/README.md) holds architecture and design documents. Current issues,
dependencies and delivery status are on the
[GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3).

## Architecture

| Component | Responsibility |
| --- | --- |
| Next.js on Vercel | Web application and server entry points |
| Supabase | PostgreSQL, authentication, private files and database-backed platform services |
| In-house flow engine | Compiles published definitions into flow plans and runs interactive, transaction and background flow segments |

Core contracts describe the capabilities needed to define, validate, publish, secure and execute
arbitrary applications. Business applications, including Abzum's own, use those same primitives.
Application names and business-specific rules belong in definitions and fixtures, not in generic
engines. Packages use each other's public interfaces and nothing depends upward.

## Development

Use Node 24 and the pnpm version pinned in [package.json](package.json). Dependency versions live in
the workspace catalogue and the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server binds to `127.0.0.1`. Authentication and protected data operations also need
the appropriate environment configuration and database; installing packages alone does not configure
them. Starting a server is not a completion gate.

### Local development setup

A fresh local database has no organisation, so a signed-in developer sees "No organisations
available". `pnpm demo:setup` is the one-command path: it resets the local database, creates a
confirmed local owner account, and runs the protected development setup. It requires the local
Supabase stack to be running. The reset deletes all data in that local stack, including local
sign-ups; never point it at a hosted database.

1. Install dependencies, start the local stack, and copy the environment example:

   ```sh
   pnpm install --frozen-lockfile
   pnpm db:start
   cp apps/web/.env.example apps/web/.env.local
   ```

   Fill in the local Supabase publishable key and identity authority UUID. Generate the Query
   continuation key using the command in `.env.example`, and keep the same key for this local
   environment so existing continuation tokens remain valid.
   Set a local-only password for `VORTEX_DEMO_OWNER_PASSWORD`; do not commit `.env.local`.

2. Create the local demo:

   ```sh
   pnpm demo:setup
   ```

   The owner email and password come from `VORTEX_DEMO_OWNER_EMAIL` and
   `VORTEX_DEMO_OWNER_PASSWORD`. The account is confirmed locally, so no email step is required.
   The setup publishes and installs the shipped core applications and grants the owner their defined
   application roles. Re-running `pnpm demo:setup` starts over by resetting the local database.

3. Start the web application and sign in using the configured demo account:

   ```sh
   pnpm dev
   ```

   Open `http://127.0.0.1:3000` (or the origin in `VORTEX_SITE_URL`) and sign in with
   `VORTEX_DEMO_OWNER_EMAIL` and `VORTEX_DEMO_OWNER_PASSWORD`. The Landing Zone lists the installed
   applications; further applications are built in App Studio and installed from the App Store.

For a manually nominated account or a separate validation organisation, use `pnpm setup:local` after
the account exists in local Supabase Auth. Pass `--first-owner-email <email>` or
`--first-owner-identity-id <uuid>` plus `--local-development`. The optional `--tenant-short-name` and
`--organization-short-name` flags accept lowercase underscore keys such as `val_demo`.

What the setup does, in order, through the protected entry points only (no table is written
directly):

| Step | Result |
| --- | --- |
| Provision | The tenant and organisation "Abzum Development" with the nominated account as its steward (`provision_tenant` with a fixed development duplicate key, recorded as the provisioning receipt). |
| Publish | IAM, Organisation Administration, Tenant Administration, Operations, Landing Zone and App Store, plus their modules from `packages/definitions/`, are published as 1.0.0 through the Definition store and publication service. |
| Installer access | The steward, through the ordinary Access administration operations, creates the custom role "Application installer" (`platform.organization.applications.manage` only) and assigns it to themselves. A provisioned steward holds no installation permission. |
| Install | The configured shipped applications are prepared and activated through the App installation coordinator, with an explicit initial record lifecycle policy (delete, 30-day recovery window) for each record type. |
| Owner access | Through protected Access operations, setup accepts the shipped application role templates and assigns their roles to the nominated owner, so the owner can open the installed applications. |
| Later access | The owner can use IAM's protected Access operations to assign roles to other accounts or Groups within their delegated scope. |

The configured manifest is `apps/web/scripts/development-setup/manifest.ts`. Management status or a
first sign-in never implies application permission: the account can use only the roles explicitly
assigned through the protected Access operations.

An interrupted `pnpm setup:local` run resumes from the identifiers recorded in
`supabase/.temp/development-setup-state.json`; provisioning and record saves replay by their stable
idempotency keys. Re-running setup for the same organisation reuses its published releases,
installations and role assignments. A different nominated account is refused. `pnpm demo:setup`
deliberately resets the local database before starting a fresh demo.

### Local environment variables

`pnpm dev`, `pnpm demo:setup`, and `pnpm setup:local` read server-only values from
`apps/web/.env.local` and the other local Next.js environment files. Copy
[apps/web/.env.example](apps/web/.env.example) and fill in local values only; never commit a real
value. `pnpm db:start` prints the local API URL and publishable key. Setup commands refuse any
environment or database that is not the local one.

For a database lane, `node tooling/supabase/lane.mjs env <n>` emits the lane's connection values and
its persistent, randomly generated Query continuation key. Copy the output into the worktree's
ignored `apps/web/.env.development.local`; it contains secrets and must not be committed or logged.

The custom-component and file pages read additional variables and report a configuration error until
they are set: `VORTEX_COMPONENT_BUNDLE_ORIGIN`, `VORTEX_FILE_STORAGE_SIGNING_KEY` and
`VORTEX_FILE_STORAGE_SIGNING_KEY_ID`. For private files, `VORTEX_ENVIRONMENT=local` accepts only a
loopback HTTP Supabase origin with an explicit port. Set `VORTEX_SUPABASE_WORKDIR` to the Local
Supabase workdir (a worker's lane directory); file routes use its existing ignored
`supabase/.temp/signing-keys.json`. Tenant provisioning derives the destination project from
`VORTEX_SUPABASE_URL` in every environment and persists it in `vortex_platform.storage_destination`
in the same transaction. The project is immutable after provisioning. Storage policies read this
protected row through `storage_destination_project()`; no database parameter is required. Hosted
file routes require the server-only signing variables above.

Generated New and Edit forms include attachment fields through the registered Puck input. Admission
checks current record/field access, file limits, then returns a 60-second credential for one private
object. The browser uploads directly to Storage. Completion reads a bounded copy, detects its binary
type with `file-type` and computes SHA-256; unknown and disallowed content stays unavailable. This is
content admission, with no malware scanner integration. Save activates admitted references and
detaches removed files atomically inside `apply_record_changes`. Pending uploads never appear in
record detail or download routes.

`VORTEX_CLUSTER_ID` and `VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID` are not needed locally:
`pnpm setup:local` takes the configured operator from its manifest.
