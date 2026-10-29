# Abzum Vortex

Vortex builds business applications from versioned definitions: modules, record types, fields, relationships, pages, permissions, actions, flows, connections and themes. It serves multiple organisations through one application, with access enforced by the platform and the database. Generic engines and the existing Next.js application render and execute those definitions.

The project is under active development. The current priority is definition-led applications with the Studio and data grid. A specification or contract does not mean the feature is implemented; the [GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) records delivery status.

## Start here

| Document | Purpose |
| --- | --- |
| [Agent instructions](AGENTS.md) | Entry point for every provider |
| [Build plan](docs/build-plan/README.md) | Architecture and design documents |
| [GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) | Current issues, dependencies and status |
| [Platform specification](docs/specification/README.md) | Product functionality and architecture |
| [Target architecture](docs/build-plan/target-architecture.md) | Binding architecture rules |
| [Open decisions](docs/specification/appendices/decisions.md) | Unresolved product choices requiring the owner's input |

## Development workflow

Working instructions are in [AGENTS.md](AGENTS.md), and the [target architecture](docs/build-plan/target-architecture.md) defines the current technical direction.

Every behaviour change is walked through in the running app on a local database before merge; a destructive reset or `pnpm demo:setup` for that walk is permitted only as the Local database lanes rules in [AGENTS.md](AGENTS.md) allow. Pull requests that change visible behaviour include screenshots. Product correctness, access control, isolation, transaction integrity and safe errors remain required functionality.

## Architecture

| Component | Responsibility |
| --- | --- |
| Next.js on Vercel | Web application and server entry points |
| Supabase | PostgreSQL, authentication, private files and database-backed platform services |
| Kestra on Coolify | Durable background execution and operational delivery jobs as product functionality |

Core contracts describe the capabilities needed to define, validate, publish, secure and execute arbitrary applications. Business applications, including Abzum's own, use those same primitives. Application names and business-specific rules belong in definitions and fixtures, not in generic engines.

Application workflow steps use protected Vortex operations. Kestra's operational database credentials are separate from application workflow execution. See the [runtime boundaries](docs/specification/17-runtime-storage-and-caching.md) and [workflow specification](docs/specification/09-workflows-and-pipelines.md).

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web/` | Existing Next.js UI, server entry points and deployment root |
| `packages/platform/` | Domain schemas, server operations, and database access |
| `packages/ui/` | Shared UI components and the designer |
| `packages/definitions/` | Ordinary shipped application and module definitions |
| `supabase/` | Database configuration, schema, migrations and seed |
| `workflows/kestra/` | Operational flows, scripts and delivery documentation |
| `tooling/` | Workspace checks and development tools |
| `docs/` | Specification, roadmap and architecture decisions |

A Vortex module is an application definition; a workspace package is source code. Packages use each other's public interfaces and nothing depends upward; each package's `package.json` declares its dependencies and environment.

## Development

Use Node 24 and the pnpm version pinned in [package.json](package.json). Dependency versions live in package manifests, the [workspace catalogue](pnpm-workspace.yaml) and the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server binds to `127.0.0.1`. Authentication and protected data operations also need the appropriate environment configuration and database; installing packages alone does not configure them. Starting a server is not a completion gate, and this does not authorize database or hosted operations.

### Local development setup

A fresh local database has no organisation, so a signed-in developer sees "No organisations available". `pnpm demo:setup` is the one-command path: it resets the local database, creates a confirmed local owner account, and runs the protected development setup. It requires the local Supabase stack to be running. The reset deletes all data in that local stack, including local sign-ups; never point it at a hosted database.

1. Install dependencies, start the local stack, and copy the environment example:

   ```sh
   pnpm install --frozen-lockfile
   pnpm db:start
   cp apps/web/.env.example apps/web/.env.local
   ```

   Fill in the local Supabase publishable key, identity authority UUID and Query continuation key. Set a local-only password for `VORTEX_DEMO_OWNER_PASSWORD`; do not commit `.env.local`.

2. Create the local demo:

   ```sh
   pnpm demo:setup
   ```

   The owner email and password come from `VORTEX_DEMO_OWNER_EMAIL` and `VORTEX_DEMO_OWNER_PASSWORD`. The account is confirmed locally, so no email step is required. The setup publishes and installs the shipped core applications and grants the owner their defined application roles. Re-running `pnpm demo:setup` starts over by resetting the local database.

3. Start the web application and sign in using the configured demo account:

   ```sh
   pnpm dev
   ```

   Open `http://127.0.0.1:3000` (or the origin in `VORTEX_SITE_URL`) and sign in with `VORTEX_DEMO_OWNER_EMAIL` and `VORTEX_DEMO_OWNER_PASSWORD`. The Landing Zone lists the installed applications; further applications are built in App Studio and installed from the App Store.

For a manually nominated account or a separate validation organisation, use `pnpm setup:local` after the account exists in local Supabase Auth. Pass `--first-owner-email <email>` or `--first-owner-identity-id <uuid>` plus `--local-development`. The optional `--tenant-short-name` and `--organization-short-name` flags accept lowercase underscore keys such as `val_demo`.

What the setup does, in order, through the protected entry points only (no table is written directly):

| Step | Result |
| --- | --- |
| Provision | The tenant and organisation "Abzum Development" with the nominated account as its steward (`provision_tenant` with a fixed development duplicate key, recorded as the provisioning receipt). |
| Publish | IAM, Organisation Administration, Tenant Administration, Operations, Landing Zone and App Store, plus their modules from `packages/definitions/`, are published as 1.0.0 through the Definition store and publication service. |
| Installer access | The steward, through the ordinary Access administration operations, creates the custom role "Application installer" (`platform.organization.applications.manage` only) and assigns it to themselves. A provisioned steward holds no installation permission. |
| Install | The configured shipped applications are prepared and activated through the App installation coordinator, with an explicit initial record lifecycle policy (delete, 30-day recovery window) for each record type. |
| Owner access | Through protected Access operations, setup accepts the shipped application role templates and assigns their roles to the nominated owner, so the owner can open the installed applications. |
| Later access | The owner can use IAM's protected Access operations to assign roles to other accounts or Groups within their delegated scope. |

The configured manifest is `apps/web/scripts/development-setup/manifest.ts`. Management status or a first sign-in never implies application permission: the account can use only the roles explicitly assigned through the protected Access operations.

An interrupted `pnpm setup:local` run resumes from the identifiers recorded in `supabase/.temp/development-setup-state.json`; provisioning and record saves replay by their stable idempotency keys. Re-running setup for the same organisation reuses its published releases, installations and role assignments. A different nominated account is refused. `pnpm demo:setup` deliberately resets the local database before starting a fresh demo.

`pnpm verify` runs format check, lint, typecheck and build.

### Local environment variables

`pnpm dev`, `pnpm demo:setup`, and `pnpm setup:local` read server-only values from `apps/web/.env.local` and the other local Next.js environment files. Copy [apps/web/.env.example](apps/web/.env.example) and fill in local values only; never commit a real value. `pnpm db:start` prints the local API URL and publishable key. Setup commands refuse any environment or database that is not the local one.

| Variable | Local value | Purpose |
| --- | --- | --- |
| `VORTEX_ENVIRONMENT` | `local` | Selects local behaviour. The local site URL must then be `http` on loopback; the development setup refuses any other value. |
| `VORTEX_SITE_URL` | `http://127.0.0.1:3000` | The configured site URL. Use this exact host for browser requests and redirects. The local server binds to `127.0.0.1`. |
| `VORTEX_SUPABASE_URL` | `http://127.0.0.1:54321` | The local Supabase API and Auth endpoint. |
| `VORTEX_SUPABASE_PUBLISHABLE_KEY` | `<local publishable key from supabase status>` | The public key the browser sign-in journey uses. |
| `VORTEX_IDENTITY_AUTHORITY_ID` | `<uuid>` | Pins the local identity authority. Generate a UUID, keep it stable for this local stack, and use it for both `pnpm dev` and setup. |
| `VORTEX_QUERY_CONTINUATION_KEY` | `<base64 of exactly 32 random bytes>` | Makes Query continuation tokens opaque; the generation command is in the env example. |
| `VORTEX_RUNTIME_DATABASE_URL` | `postgresql://vortex_runtime:vortex-runtime-local-only@127.0.0.1:54322/postgres` | The restricted runtime connection to the local database. Required by `pnpm dev`; `pnpm setup:local` defaults to this address when unset. |
| `VORTEX_RUNTIME_DATABASE_POOL_SIZE` | `<1-20>` | Optional runtime connection-pool cap; 10 applies when unset locally, 5 elsewhere. |
| `VORTEX_RUNTIME_DATABASE_SSL_ROOT_CERT` | not set locally | Trusted root certificate for a hosted runtime connection; not needed for the local loopback database. |
| `VORTEX_DEMO_OWNER_EMAIL` | `owner@vortex.test` | Local email address created as the first owner by `pnpm demo:setup`. |
| `VORTEX_DEMO_OWNER_PASSWORD` | set locally | Local-only password for the demo owner. Use at least 12 characters with a letter and a number. |
| `VORTEX_LOCAL_DEVELOPMENT_SIGN_IN_ENABLED` | not set | Optional local sign-in shortcut switch. Set to `true` to show the development account button in a development server. |
| `VORTEX_LOCAL_DEVELOPMENT_IDENTITY_ID` | `<demo owner identity UUID>` | Required only when the optional local sign-in shortcut is enabled. Use the identity UUID printed by the setup command. |
| `VORTEX_LOCAL_SUPABASE_AUTH_ADMIN_KEY` | `<local Supabase secret key>` | Required only for the optional local sign-in shortcut. Read it from local Supabase status; never commit it. |
| `VORTEX_SETUP_DEBUG` | not set | Optional setup diagnostics. Set to `1` in the shell running `pnpm setup:local` to print the underlying setup error. |

In a local environment the installed-application pages read releases against the platform catalogue plus the platform connection types (`apps/web/app/_lib/definition-catalogue.ts`). During `pnpm setup:local` the database driver no longer prints server notices such as `relation ... already exists, skipping` (an idempotent index the setup creates twice); a real database error still stops the setup with a non-zero exit. A failing installed-application page logs a safe `[access] human organisation request failed` line with error class names and codes to the `pnpm dev` console.

The custom-component and file pages read additional variables and report a configuration error until they are set:

| Variable | Purpose |
| --- | --- |
| `VORTEX_COMPONENT_BUNDLE_ORIGIN` | The dedicated origin the custom-component sandbox is served from. |
| `VORTEX_FILE_STORAGE_SIGNING_KEY` | The private key the file routes sign file-storage tokens with. |
| `VORTEX_FILE_STORAGE_SIGNING_KEY_ID` | The key id published in those signed file-storage tokens. |

For private files, `VORTEX_ENVIRONMENT=local` accepts only a loopback HTTP Supabase origin
with an explicit port. Set `VORTEX_SUPABASE_WORKDIR` to the Local Supabase workdir (a worker's
lane directory); file routes use its existing ignored `supabase/.temp/signing-keys.json`.
Tenant provisioning derives the destination project from `VORTEX_SUPABASE_URL` in every
environment and persists it in `vortex_platform.storage_destination` in the same transaction.
The project is immutable after provisioning. Storage policies read this protected row through
`storage_destination_project()`; no database parameter is required. Hosted file routes require
the server-only signing variables above.

Generated New and Edit forms include attachment fields through the registered Puck input.
Admission checks current record/field access, file limits, then returns
a 60-second credential for one private object. The browser uploads directly to Storage.
Completion reads a bounded copy, detects its binary type with `file-type` and computes SHA-256;
unknown and disallowed content stays unavailable. This is content admission, with no malware
scanner integration. Save activates admitted references and detaches removed files atomically
inside `apply_record_changes`. Pending uploads never appear in record detail or download routes.

`VORTEX_CLUSTER_ID` and `VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID` are not needed locally: `pnpm setup:local` takes the configured operator from its manifest.

## Delivery and contribution

- Work from a GitHub issue with clear scope, dependencies and functional acceptance. Keep its description and roadmap status current.
- Use the existing engine boundaries and official framework conventions. Update the specification and build plan when agreed behaviour or sequencing changes.
- Keep changes focused. Preserve organisation isolation, current permission checks, atomic writes, revision checks and safe errors without introducing unnecessary abstractions.
- Work on a branch from `origin/main` and open a pull request to `main`; never push to `main` directly.
- Before merge, walk every behaviour change through the running app on a local database (a destructive reset only as the Local database lanes rules in [AGENTS.md](AGENTS.md) allow); include screenshots for visible changes.
- Follow the [AGENTS.md](AGENTS.md) and [target architecture](docs/build-plan/target-architecture.md).
- Manage secrets through the documented Doppler configuration. Keep credentials out of source, browser bundles, agent prompts and logs.
