# 18. Development delivery and environment boundaries

[Specification index](README.md) · [Code-review acceptance](20-quality-and-acceptance.md) · [Fleet policy](../build-plan/agent-coordination.md)

## Current development policy

Develop the bounded functionality and complete it through independent source code review. The reviewer fixes findings itself, re-reviews, integrates its permitted PR into main, updates/closes the assigned issue and reports to the orchestrator. The orchestrator reconciles project status, dependencies and cleanup before the next ordered task.

No tests are created or run. No database review/execution, hosted verification, proof receipts, screenshots, benchmarks or deployment are acceptance requirements. Kestra is not a fleet dependency or a completion gate. Do not deploy to Testing or Production, promote branches, trigger delivery or re-enable delivery hooks. Historical operational tooling remains outside this development sequence.

## Branch flow

Issue worktrees start from current `origin/main`. Reviewed PRs target `main`. A reviewer confirms integration before closing the issue completed. A reviewed but unmerged candidate remains In review with its exact integration blocker. Do not add another planner/reviewer, a missing authority-file condition or a release phase to close development work.

Actual repository protections and permission controls remain in force. If one rejects integration, report the concrete rule and supported resolution rather than bypassing it. This is an external operational block, not permission to invent testing work.

## Repository layout convention

Deployable applications live under `apps/`; `apps/web` is the single Next.js composition root. Shared runtime packages expose public service interfaces and remain separate workspace members. Browser code cannot import database credentials or privileged server implementations. Use the pinned dependency catalogue and lockfile. A different deployment root or package boundary requires an explicit architecture change rather than an implicit exception.

## Database changes

Platform database changes are immutable, ordered migration files. Once a filename has been applied to a shared environment, correcting it requires a later migration because the migration ledger does not replay edited content. Missing or out-of-order files are an explicit migration-state conflict; code must not rewrite applied history or reset shared data to conceal one.

Schema evolution changes the owning current schema and all affected current callers together. Additive storage, bounded data transformation, caller switch-over and obsolete-shape removal remain distinct operations when the change cannot be atomic. This sequencing protects accepted data and transaction integrity without requiring a legacy application contract or parallel compatibility reader.

Application installation invokes the generic [Record storage provisioner](17-runtime-storage-and-caching.md#record-storage-provisioning) over exact published definitions. It does not accept customer SQL, expose DDL credentials or create a per-customer repository migration stream. The Record catalogue tracks definition-driven provisioning; the platform migration ledger remains authoritative for platform schema.

<a id="supabase-development-and-verification"></a>

### Supabase project and database invariants

The repository uses one standard Supabase project layout: `supabase/config.toml`, ordered `supabase/migrations/`, `supabase/seed.sql` and the existing database support paths. There is no parallel migration directory, second schema ledger or customer-controlled SQL path.

Database behavior preserves these product invariants:

- Runtime and migration identities are separate, least-privilege credentials. Browser and application runtime paths never receive a migration or owner credential, and the runtime role remains unable to alter schema or bypass protected operations.
- Connection identity, target project, database, TLS certificate and hostname are explicit. Environment variables or page parameters cannot substitute another environment or broaden authority.
- Vortex-owned schemas, relations, functions, policies, privileges, roles and extensions have one current declared shape. Unexplained drift is a blocking operational state, not a source of inferred product behavior.
- Ordered migration filenames and the target ledger describe the platform schema history. Normal operation never resets a shared environment, rewrites the ledger or seeds Production.
- Definition-driven record storage retains organisation and application scope, exact published-definition identity and current access enforcement independently of physical table names.
- Index recommendations and performance observations can propose ordinary source changes, but no adviser directly changes Production and performance pressure cannot weaken access, integrity or privacy.

These are source and runtime design requirements. They do not authorize the current fleet to open a database, execute a migration, invoke a hosted flow or collect a receipt.

## Environments

Local, Testing and Production are separate product environments with separate addresses, secrets, databases, files, queues, connections and runtime settings. An environment may contain several Vortex clusters, but it has one shared [Vortex Identity Authority](02-people-organisations-and-sign-in.md#identity-across-clusters). Identity, trust, credentials, federation routes, cached authority and business data never cross an environment boundary.

Application workflow execution is a product capability owned by [Workflows and pipelines](09-workflows-and-pipelines.md). When operated, each environment has explicit namespaces, flow identities, webhook authentication, configuration and least-privilege credentials. A workflow for one environment cannot read another environment's database, file store, queue, workflow state, cache or secrets. This product topology does not make Kestra part of fleet coordination or development completion.

Environment setup, hosted operation and deployment require separately scoped work. Development completion makes no claim of deployment, customer availability or production readiness.

## Release and recovery behavior

A running environment either exposes the complete current application behavior for its installed revision or a safe unavailable state. Partial schema application, missing configuration, failed installation, unknown workflow state or incomplete recovery cannot be presented as successful functionality.

Forward correction is the default for accepted data. A reverse operation is valid only when its owning product operation can preserve accepted records, authority, privacy removals and immutable history. Feature flags and recovery paths cannot bypass access, protected data handling, retention or entitlement rules. Restored state remains unavailable until current identity, permission, migration and privacy-removal state is internally consistent.

Cross-cluster product changes preserve source authority, signed trust and safe refusal as defined in [runtime storage and federation](17-runtime-storage-and-caching.md#vortex-federation-between-clusters). A cluster advertises only protocol and contract versions its running source implements. Unsupported peers receive a stable refusal and never a partially interpreted request.

## Credentials and runtime connections

Runtime services use restricted credentials; browser bundles contain only public settings. Preserve certificate verification, connection semantics, request identity and current permissions. A deployment variable, page parameter or stale cache cannot grant access. Never place credentials in issue bodies, prompts, logs or commits.

Secrets are referenced by stable configuration keys and resolved only in the owning runtime. Migration, runtime, webhook and external-provider credentials have separate purposes and cannot be exchanged. Rotation, revocation and temporary unavailability must fail closed without exposing the secret or silently falling back to broader authority.
