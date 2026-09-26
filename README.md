# Abzum Vortex

Vortex builds business applications from versioned definitions: modules, record types, fields, relationships, pages, permissions, actions, flows, connections and themes. It serves multiple organisations through one application, with access enforced by the platform and the database. Generic engines and the existing Next.js application render and execute those definitions.

The project is under active development. The current priority is a usable definition-led application before the visual App Designer. A specification or contract does not mean the feature is implemented; the [GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) records delivery status.

Development is carried out by an orchestrated fleet of autonomous coding agents rather than a continuous team: one orchestrator plans, dispatches, reconciles and reports, implementers deliver bounded work in isolated worktrees, and independent reviewers fix their own findings and integrate the reviewed change.

## Start here

| Document | Purpose |
| --- | --- |
| [Agent instructions](AGENTS.md) | Entry point for every provider |
| [Agent coordination](docs/build-plan/agent-coordination.md) | Current roles, development acceptance and ownership |
| [Fleet operations](docs/build-plan/agent-fleet.md) | Strict pickup, bounded assignment, model routing, board updates and recovery |
| [Orchestration diagram](docs/build-plan/fleet-orchestration.html) | Implementation, reviewer fixes, closure and next-task handoff |
| [Roadmap](docs/build-plan/README.md) | Phase order and Phase 6 visible-application objective |
| [GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) | Current issues, Pickup Order and status |
| [Platform specification](docs/specification/README.md) | Product functionality and architecture |
| [Definition-led application delivery](docs/build-plan/engine-first-application-delivery.md) | Path to a usable application before the designer |
| [Architecture review — 21 September 2026](docs/build-plan/architecture-review-2026-09-21.md) | Main-branch findings and revised implementation order |
| [Open decisions](docs/specification/appendices/decisions.md) | Unresolved product choices requiring the owner's input |

## Development workflow

The GPT 5.6 Sol orchestrator selects the lowest unfinished pickup in the earliest incomplete roadmap phase, confirms a bounded scope and assigns the cheapest capable implementer. A separate Opus 5 or GPT 5.6 Sol reviewer fixes findings itself, re-reviews, integrates the reviewed change through permitted repository operations, updates/closes the assigned issue and reports. The orchestrator reconciles the board/dependencies, releases the agent, cleans the completed worktree and takes the next ordered task.

No tests, database review/execution, hosted verification, proof receipts, Kestra orchestration or Testing/Production deployment is part of this development workflow. Existing tooling and archived runbooks do not introduce extra gates. Product correctness, access control, isolation, transaction integrity and safe errors remain required functionality.

## Architecture

| Component | Responsibility |
| --- | --- |
| Next.js on Vercel | Web application and server entry points |
| Supabase | PostgreSQL, authentication, private files and database-backed platform services |
| Kestra on Coolify | Durable background execution and operational delivery jobs as product functionality |

Core contracts describe the capabilities needed to define, validate, publish, secure and execute arbitrary applications. Business applications, including Abzum's own, use those same primitives. Application names and business-specific rules belong in definitions and fixtures, not in generic engines.

Application workflow steps use protected Vortex operations. Kestra's operational database credentials are separate from application workflow execution. See the [runtime boundaries](docs/specification/17-runtime-storage-and-caching.md) and [workflow specification](docs/specification/09-workflows-and-pipelines.md). Kestra is product capability; it is not part of fleet management or development acceptance.

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web/` | Existing Next.js UI, server entry points and deployment root |
| `contracts/` | Current definition and operation schemas |
| `runtime/` | Owning engines with explicit public interfaces |
| `db/` | Database connection and transaction boundary |
| `ui/`, `studio/` | Shared UI components and the later designer |
| `modules/` | Ordinary shipped application and module definitions |
| `supabase/` | Database configuration, schema, migrations and seed |
| `testing/` | Shared fixtures and existing cross-package utilities |
| `workflows/kestra/` | Operational flows, scripts and delivery documentation |
| `tooling/` | Workspace checks and development tools |
| `docs/` | Specification, roadmap, fleet policy and historical evidence |

A Vortex module is an application definition; a workspace package is source code. Packages use each other's public interfaces and nothing depends upward; the workspace [boundary checker](tooling/boundaries/check.mjs) records those dependency and environment rules.

## Development

Use Node 24 and the pnpm version pinned in [package.json](package.json). Dependency versions live in package manifests, the [workspace catalogue](pnpm-workspace.yaml) and the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The development server binds to `127.0.0.1`. Authentication and protected data operations also need the appropriate environment configuration and database; installing packages alone does not configure them. Starting a server is not a completion gate, and this does not authorize database or hosted operations.

### Local development setup

A fresh local database has no organisation, so a signed-in developer sees "No organisations available". The development-only setup command provisions one organisation, publishes and installs every shipped application and gives one nominated first owner their access. It runs only on your machine against the Supabase CLI database on loopback: it refuses `NODE_ENV=production`, any other database host or port, and a run without the explicit `--local-development` flag.

1. Start the local stack and build a fresh database (this deletes local data, including local sign-ups):

   ```sh
   pnpm install --frozen-lockfile
   pnpm db:start
   pnpm db:reset
   ```

2. Start the web application with your usual local environment (the same variables `pnpm dev` uses) and sign up at `http://127.0.0.1:3000` as the person who should own the organisation. Confirm the sign-up email in Mailpit at `http://127.0.0.1:54324`.

3. Nominate that account and run the setup in a shell with the same `VORTEX_IDENTITY_AUTHORITY_ID` as the web application (the runtime database variables default to the local Supabase values):

   ```sh
   pnpm setup:local -- --local-development --first-owner-email you@example.com
   ```

   `--first-owner-identity-id <uuid>` nominates by Supabase user id instead of email. Exactly one account is accepted, and it comes only from this command line; nothing is read from a browser. The account must already exist locally (step 2).

4. Sign in at `http://127.0.0.1:3000` with the nominated account and select the organisation "Abzum Development". It has six installed applications: IAM, Organisation Administration, Tenant Administration, CRM, Service Desk and Operations.

What the setup does, in order, through the protected entry points only (no table is written directly):

| Step | Result |
| --- | --- |
| Provision | The tenant and organisation "Abzum Development" with the nominated account as its steward (`provision_tenant` with a fixed development duplicate key, recorded as the provisioning receipt). |
| Publish | The IAM, Organisation Administration, Tenant Administration, CRM, Service Desk and Operations modules and applications from `modules/` are published as 1.0.0 through the Definition store and publication service. |
| Installer access | The steward, through the ordinary Access administration operations, creates the custom role "Application installer" (`platform.organization.applications.manage` only) and assigns it to themselves. A provisioned steward holds no installation permission. |
| Install | Organisation Administration, Tenant Administration, CRM, Service Desk and Operations, then IAM, are prepared and activated through the App installation coordinator, with an explicit initial record lifecycle policy (delete, 30-day recovery window) for each record type. |
| Grant | The App first-owner composition installs IAM and calls the Access-owned initial operating-role grant once with the provisioning receipt: the nominated account receives the IAM reviewer role (`iam_reviewer`) as a standing assignment. |
| Administration and application roles | The steward accepts and assigns to themselves `iam_administrator`, `organisation_administrator` and `tenant_administrator` through the ordinary Access administration operations, so the owner can administer the organisation from IAM, plus `crm_manager`, `service_manager` and `operations_operator` so the owner can open CRM, Service Desk and Operations. |

The configured manifest is `apps/web/scripts/development-setup/manifest.ts`. Management status or a first sign-in never implies application permission: the account can use only what these roles and later IAM assignments give it. The command is not a general grant tool: further access is granted in the IAM application.

CRM and Service Desk bind the email, calendar and webhook connection types, which have no platform release yet (#1316). Until then the setup publishes development placeholders of them (`apps/web/scripts/development-setup/placeholder-connection-types.ts`) only into its own local catalogue: they have no provider, their only allowed host is a reserved `.invalid` name that never resolves, and no connection is configured, so the installed CRM and Service Desk show their connections as not configured and cannot send anything.

An interrupted run resumes: provisioning replays by its fixed key and the steps recorded in `supabase/.temp/development-setup-state.json` are skipped. Once every step has completed, the command is disabled: running it again only calls the initial operating-role grant with the original receipt and the same manifest, which replays the stored result. A different nominated account is refused. `pnpm db:reset` starts over.

Existing developer utilities (`pnpm verify`, `pnpm fixtures`, `pnpm db:verify`) remain in the workspace for local use. They are not fleet completion requirements, and the current development workflow does not run them or treat their output as acceptance.

### Local environment variables

`pnpm dev` reads server-only values from `apps/web/.env.local`: copy [apps/web/.env.example](apps/web/.env.example) and fill in local values only; never commit a real value. `pnpm db:start` prints the local API URL and publishable key. `pnpm setup:local` does not read that file: run it in a shell that exports the same `VORTEX_IDENTITY_AUTHORITY_ID`, and it refuses any environment or database that is not the local one.

| Variable | Local value | Purpose |
| --- | --- | --- |
| `VORTEX_ENVIRONMENT` | `local` | Selects local behaviour. The local site URL must then be `http` on loopback; the development setup refuses any other value. |
| `VORTEX_SITE_URL` | `http://127.0.0.1:3000` | The configured site URL. Identity-session cookies and auth redirects are built from it. |
| `VORTEX_SUPABASE_URL` | `http://127.0.0.1:54321` | The local Supabase API and Auth endpoint. |
| `VORTEX_SUPABASE_PUBLISHABLE_KEY` | `<local publishable key from supabase status>` | The public key the browser sign-in journey uses. |
| `VORTEX_IDENTITY_AUTHORITY_ID` | `<uuid>` | Pins the local identity authority. Use the same value for `pnpm dev` and `pnpm setup:local`. |
| `VORTEX_QUERY_CONTINUATION_KEY` | `<base64 of exactly 32 random bytes>` | Makes Query continuation tokens opaque; the generation command is in the env example. |
| `VORTEX_RUNTIME_DATABASE_URL` | `postgresql://vortex_runtime:vortex-runtime-local-only@127.0.0.1:54322/postgres` | The restricted runtime connection to the local database. Required by `pnpm dev`; `pnpm setup:local` defaults to this address when unset. |
| `VORTEX_RUNTIME_DATABASE_POOL_SIZE` | `<1-20>` | Optional runtime connection-pool cap; 5 applies when unset. |
| `VORTEX_RUNTIME_DATABASE_SSL_ROOT_CERT` | not set locally | Trusted root certificate for a hosted runtime connection; not needed for the local loopback database. |

The custom-component and file pages read additional variables and report a configuration error until they are set:

| Variable | Purpose |
| --- | --- |
| `VORTEX_COMPONENT_BUNDLE_ORIGIN` | The dedicated origin the custom-component sandbox is served from. |
| `VORTEX_FILE_STORAGE_SIGNING_KEY` | The private key the file routes sign file-storage tokens with. |
| `VORTEX_FILE_STORAGE_SIGNING_KEY_ID` | The key id published in those signed file-storage tokens. |

`VORTEX_CLUSTER_ID` and `VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID` are not needed locally: `pnpm setup:local` takes the configured operator from its manifest. `VORTEX_APPLICATION_KESTRA_URL` and the flow secret `VORTEX_WORKFLOW_CALLBACK_KEY` belong to the application Kestra instance and are not read by `pnpm dev` or `pnpm setup:local`.

## Delivery and contribution

- Work from a GitHub issue with clear scope, dependencies and functional acceptance. Keep its description and roadmap status current.
- Use the existing engine boundaries and official framework conventions. Update the specification and build plan when agreed behaviour or sequencing changes.
- Keep changes focused. Preserve organisation isolation, current permission checks, atomic writes, revision checks and safe errors without introducing unnecessary abstractions.
- Use issue branches from `origin/main`, obtain an independent code review, and merge the reviewed implementation into `main`. Implementation plus that review is the completion criterion.
- Hosted delivery and Production are outside this development pass.
- Follow [agent coordination](docs/build-plan/agent-coordination.md) and the [delivery specification](docs/specification/18-delivery-and-testing.md) for the current development policy. Historical handovers do not add requirements.
- Manage secrets through the documented Doppler configuration. Keep credentials out of source, browser bundles, agent prompts and logs.
