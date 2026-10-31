# The operations scheduler

## Operational reference

Kestra open source runs on the Coolify-managed server with its own PostgreSQL. It is the operations
scheduler in the [current hosting boundary](../../docs/specification/17-runtime-storage-and-caching.md#hosting-boundaries).
It runs the two scheduled operations flows below. It does not run application flows: those are
compiled and executed by the in-house flow engine (ADR #1127), and Kestra holds no application
credentials or application database access.

No application user sees it. The two operations flows use only their protected route credentials.

## What is here

| File | Holds |
|---|---|
| `Dockerfile` | The pinned Kestra operations image with the reviewed flow definitions |
| `docker-compose.yml` | The stack Coolify deploys: Kestra and its own PostgreSQL |
| `flows/` | Scheduled event-dispatch recovery and runtime-bundle cleanup |

## How it is deployed

Coolify deploys this directory from the repository rather than from a compose file pasted into its
interface, so the stack is reviewed and versioned like anything else, and a change to it arrives by
pull request.

The `flows/` directory is copied into the pinned Kestra image at build time, and the flow directory
is passed to Kestra's official `--flow-path` startup option. Baking it into the image is required
because Coolify removes its temporary checkout after deployment; a relative runtime bind mount would
become an empty host directory. A reviewed Coolify deployment loads these flows into Kestra's
PostgreSQL repository. Removing an operational flow is an explicit reviewed deletion; a missing file
is not silently interpreted as permission to erase stored operational state.

## Secrets

Every secret is supplied by the environment. Nothing in this directory holds one.

| Variable | What it is |
|---|---|
| `KESTRA_DB_PASSWORD` | The password for Kestra's own PostgreSQL |
| `KESTRA_BASIC_AUTH_USERNAME` | The account the API and interface demand |
| `KESTRA_BASIC_AUTH_PASSWORD` | Its password |
| `KESTRA_PUBLIC_URL` | The public Kestra address used in generated links |
| `VORTEX_EVENT_DISPATCH_RECOVERY_URL_BASE64` | Base64 encoding of the protected Vercel dispatch route address for scheduled event recovery |
| `VORTEX_EVENT_DISPATCH_RECOVERY_CREDENTIAL_BASE64` | Base64 encoding of the dispatcher route bearer credential, whose SHA-256 digest is configured in Vercel |
| `VORTEX_RUNTIME_BUNDLE_CLEANUP_URL_BASE64` | Base64 encoding of the protected Vercel runtime-bundle cleanup route address |
| `VORTEX_RUNTIME_BUNDLE_CLEANUP_CREDENTIAL_BASE64` | Base64 encoding of the cleanup route bearer credential; its SHA-256 digest is configured on the Vercel route |

These values are stored as protected Coolify runtime variables. The operations instance receives
only the route URL and credential for each scheduled flow; it has no database-delivery credentials.

Kestra open source recognises sensitive flow values only when the container variable begins
`SECRET_` and its value is base64-encoded. Coolify therefore stores the `_BASE64` values above;
the compose file maps them to Kestra's required names and each flow reads them with `secret()`. Base64
is not encryption, so Coolify remains the protected host boundary. Kestra masks resolved secrets in
execution logs.

## The two flows

`event_dispatch_recovery` is the scheduled recovery half of the event dispatch boundary. Its
schedule trigger calls the protected Vercel dispatch route every minute, so an event
occurrence committed while a web deployment was unavailable is still
delivered. After a Kestra outage it runs one catch-up tick rather than every missed interval, and an
overlapping tick is cancelled because the running one already covers it. The flow holds only two
values: the route address and the route bearer credential. It never receives a database URL,
migration credential or application secret, and it never reads the database. The route accepts
only an optional `source` label and refuses any batch or consumer tuning. Vercel holds only the
bearer credential's SHA-256 digest in `VORTEX_EVENT_DISPATCHER_CREDENTIAL_SHA256`.

Each authenticated wake-up reclaims work after every successful nonempty batch for up to ten
seconds or 200 dispatches. Every dispatch rechecks the system actor grant and uses the existing
claim, lease, retry and fencing operations. A failed or interrupted batch stops the wake-up;
retries keep their existing backoff. The budget stops new dispatches, allowing the current bounded
batch to commit normally within the route's 60-second allowance. Counts in the response cover all
dispatches, and the backlog snapshot is read once at the end. Work left at the budget boundary
resumes from its committed cursor on the next one-minute recovery tick, without needing another
outbox insert or an in-process timer.

`runtime_bundle_cleanup` calls the protected Vercel `POST /api/runtime-bundles/cleanup` route daily
with concurrency one. It carries only the route URL and bearer credential; Kestra never receives a
Vortex database URL or credential. One call removes three things in one bounded run:

- runtime bundles superseded by a newer installation;
- preview installations whose lifetime ended, then the storage of replaced previews;
- at most 25 expired, never-activated attachment uploads, including clean inspections awaiting Save
  and rejected content.

Upload cleanup locks and marks each abandoned upload before deleting its exact private object
through the Storage API with a server-only, short-lived credential. Successful deletion removes
upload state and marks file metadata removed. Failed calls keep their claims and become eligible for
retry after five minutes; active attachments and held files are excluded. Provision the flow and
route credential in every environment that accepts uploads; without scheduled maintenance abandoned
objects are not reclaimed.

Keep the raw bearer credential in the secret manager, set the base64 route URL and credential as the
protected Coolify inputs `VORTEX_RUNTIME_BUNDLE_CLEANUP_URL_BASE64` and
`VORTEX_RUNTIME_BUNDLE_CLEANUP_CREDENTIAL_BASE64`, and configure its lowercase SHA-256 digest
in the Vercel server-side environment as `VORTEX_RUNTIME_BUNDLE_CLEANUP_CREDENTIAL_SHA256`.

These two scheduled flows use the Kestra HTTP task and need no database client, delivery CLI, or
repository checkout at runtime.

## Pins and deliberate departures from Kestra's published compose file

**The Docker socket is not mounted.** Kestra's own file mounts `/var/run/docker.sock` into a
container running as `root`. Anything able to schedule a Docker task could then start a container on
the host with any mount it chose, which is root on the machine that also runs Coolify. This platform
runs customer-defined workflows, so that mount would hand a tenant the host. The Docker task runner
is given up until there is a sandbox for it.

**Both images are pinned.** Kestra's file uses `kestra/kestra:latest`. This repository pins Kestra's
exact release and multi-platform image digest, and pins its state database to an exact PostgreSQL
patch release, distribution and digest. The workflow engine and its database therefore change only
as their own reviewed change, the same rule
[#6](https://github.com/Abzum-NZ/Abzum-Vortex/issues/6) applies to Next.js and Puck.

**No password is written down.** Kestra's file publishes `POSTGRES_PASSWORD: k3str4` in its own
public repository.

## Usage reporting is off

Kestra ships with `anonymous-usage-report.enabled: true`, which posts to
`https://api.kestra.io/v1/reports/server-events` every hour, and a second browser-side report from the
interface. The payload carries the instance and session identifiers, the server type and version, the
host's time zone, and system, feature, service and plugin usage counts. No flow content and no records.

Both are turned off. This engine runs tenants' business processes on a server that also holds its own
database, and a standing hourly call outward from it is a decision, not a default. The
[privacy and operational rules](../../docs/specification/14-activity-privacy-and-retention.md)
refuse unapproved third-party analytics; this is the same rule one layer down.

## Memory

The server has 8 GB and already runs Coolify and a STUN/TURN service. Kestra is a JVM and takes what
it is given, so both containers carry a limit: 3 GB for Kestra, 1 GB for PostgreSQL.
