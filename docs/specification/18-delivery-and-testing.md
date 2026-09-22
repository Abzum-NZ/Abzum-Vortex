# 18. Development delivery and environment boundaries

[Specification index](README.md) · [Code-review acceptance](20-quality-and-acceptance.md)

## Current development policy

The owner directed on 21 September 2026 that functionality is built first and completed through code review. Development issues do not require tests, database review, hosted verification, proof receipts, preview evidence or release gates. Do not create tests as part of these tasks. Existing verification tooling can remain in the repository without becoming a task prerequisite.

This policy supersedes earlier Testing-first, hosted-proof and backward-compatibility instructions in dated plans and comments. It changes development acceptance, not the application's access, isolation or data-integrity requirements.

## Branch flow

Create a bounded issue branch from current `origin/main`, obtain code review, and target `main`. The project board records implementation completion after the reviewed code is merged. The `testing` branch and hosted environments are outside this development sequence. Code-review completion does not authorise Production deployment or claim release readiness; the actual effect of a push depends on the separately configured hosting and delivery triggers.

## Repository layout convention

`apps/web` is the Next.js composition and deployment root. Shared runtime packages expose public service interfaces. Browser code cannot import database credentials or privileged server implementations. Dependencies use the pinned workspace catalogue and lockfile.

## Database changes

Change the owning schema and all affected current callers together. No old application representation or parallel compatibility reader is required. Ordered migration files describe schema changes. If a file has already been applied, express a correction in a new migration because the migration ledger will not rerun the old filename. Do not reset shared data as a shortcut.

Application installation invokes the generic Record storage provisioner over exact published definitions. It does not accept customer SQL or require per-customer repository migrations. Module field changes and populated record handling remain explicit product operations under [modules](05-modules-fields-and-relationships.md) and [runtime storage](17-runtime-storage-and-caching.md).

## Environments

Local, Testing and Production have separate databases, addresses, secrets, files, queues and connection targets. The operated Kestra instance is shared, with environment-scoped application execution and target-specific credentials. No application flow accesses another environment's resources.

The development roadmap does not authorize deployment, shared-environment reset, secret rotation or Production operation. Those actions are scheduled separately when requested. Hosted behavior and release readiness are not implied by code-review completion.

## Credentials and runtime connections

Keep environment credentials in the configured secret-management system. Server runtime connections use restricted runtime credentials, not schema-owner or migration credentials. Migration and runtime connections retain their respective session/transaction semantics and certificate verification. Browser bundles contain only settings intended for public use.

The Identity Authority, selected organisation account, current permissions and installed definition determine request authority. A deployment variable, page parameter or stale browser cache cannot grant access.
