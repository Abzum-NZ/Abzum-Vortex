# The workflow engine

Kestra open source, on the Coolify-managed server, with its own PostgreSQL beside it. It is the third
of the three services in [Specification section 24.1](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s24-1),
and it runs every background thing the platform does: approvals, timers, scheduled jobs, outbound
messages.

No user ever sees it. The Workflow engine operates it, and
[section 25.1](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s25-1) says so
outright.

## What is here

| File | Holds |
|---|---|
| `docker-compose.yml` | The stack Coolify deploys: Kestra and its own PostgreSQL |

Flow definitions are not here yet. They arrive in phase 7, when the Workflow engine is built.

## How it is deployed

Coolify deploys this directory from the repository rather than from a compose file pasted into its
interface, so the stack is reviewed and versioned like anything else, and a change to it arrives by
pull request.

## Secrets

Every secret is supplied by the environment. Nothing in this directory holds one.

| Variable | What it is |
|---|---|
| `KESTRA_DB_PASSWORD` | The password for Kestra's own PostgreSQL |
| `KESTRA_BASIC_AUTH_USERNAME` | The account the API and interface demand |
| `KESTRA_BASIC_AUTH_PASSWORD` | Its password |

They are set in Coolify and held in the secret manager. The API credential is also set on the web
application so it can reach the engine.

## Three deliberate departures from Kestra's published compose file

**The Docker socket is not mounted.** Kestra's own file mounts `/var/run/docker.sock` into a
container running as `root`. Anything able to schedule a Docker task could then start a container on
the host with any mount it chose, which is root on the machine that also runs Coolify. This platform
runs customer-defined workflows, so that mount would hand a tenant the host. The Docker task runner
is given up until there is a sandbox for it.

**Both images are pinned, to the LTS line.** Kestra's file uses `kestra/kestra:latest`. Pinned, the
workflow engine changes only as its own reviewed change, the same rule
[#6](https://github.com/Abzum-NZ/Abzum-Vortex/issues/6) applies to Next.js and Puck.

The tag is `v1.0.57`, not the newer `v1.3.x`. The 1.0 line is what `latest-lts` tracks, it is patched
on the same day as the current line, and the workflow engine is the part of this platform that should
be dull. A first attempt pinned `v1.3.35` because that was the newest GitHub release; the deployment
failed because **no image is published under that tag**. Check Docker Hub, not the release list.

**No password is written down.** Kestra's file publishes `POSTGRES_PASSWORD: k3str4` in its own
public repository.

## Usage reporting is off

Kestra ships with `anonymous-usage-report.enabled: true`, which posts to
`https://api.kestra.io/v1/reports/server-events` every hour, and a second browser-side report from the
interface. The payload carries the instance and session identifiers, the server type and version, the
host's time zone, and system, feature, service and plugin usage counts. No flow content and no records.

Both are turned off. This engine runs tenants' business processes on a server that also holds its own
database, and a standing hourly call outward from it is a decision, not a default. Chapter 24,
section 24.9 already refuses third-party analytics on customer pages; this is the same rule one layer
down.

## Memory

The server has 8 GB and already runs Coolify and a STUN/TURN service. Kestra is a JVM and takes what
it is given, so both containers carry a limit: 3 GB for Kestra, 1 GB for PostgreSQL.

## Recovering

[Section 24.6](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s24-6) promises
that runs pause and resume from their last completed step when the server returns. That holds only
while `kestra-postgres-data` survives, so it is backed up on a schedule. Losing it loses every run in
flight, and nobody would find out until a restore.

The backup runs nightly and the archive is sent to Cloudflare R2. As of 31 August 2026 no local copy
is kept: the Coolify backup's **Local copy** setting is *Delete after S3 upload*, so the only copy
that survives the server is the one in R2. The full backup and restore procedure, with the checksums
and row counts from a rehearsal, is written out on
[issue #132](https://github.com/Abzum-NZ/Abzum-Vortex/issues/132).

## Checking that the backup still restores

A backup nobody has restored is a guess. `verify-restore.sh` turns that guess into a fact: it pulls
the newest archive from Cloudflare R2, restores it into a throwaway database beside the live one,
checks the flow definitions came back, and drops it again. It fails loudly at every step, so a run
that reports success is a backup that genuinely restores.

It verifies a backup. It does not recover one. Replacing the live database is a decision a person
makes after working out what went wrong, so that stays manual.

### Where the settings live

Doppler project **`abzum-kestra`**, config **`prd`**. That project exists to keep server-side secrets
apart from `abzum-vortex`, whose `dev`, `stg` and `prd` configs all sync to Vercel. Nothing here is
wanted by the web application, and a secret placed in `abzum-vortex` would be pushed to every Vercel
build and function for no reason.

Four of the six values are already there and are not secret: `R2_ENDPOINT`, `R2_BUCKET`, `R2_PREFIX`
and `PG_CONTAINER`. The two credentials, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, are added by
hand.

Doppler has no Coolify sync — its catalogue covers Vercel, Netlify, Render, Fly.io and the rest, but
not Coolify — so the values do not arrive on the server on their own. Install the Doppler CLI there,
give it a service token scoped to `abzum-kestra` / `prd`, and let the script read them at run time:

```
doppler run --project abzum-kestra --config prd -- ./verify-restore.sh
```

Reading them at run time is what keeps the promise that a credential is changed in one place. Copying
the values into Coolify's own environment variables would work today and drift tomorrow, because
rotating the R2 key would then mean remembering to change it twice.

Run it as a weekly Coolify scheduled task on the Kestra resource. Weekly, not nightly — enough to
catch a backup that has quietly stopped restoring while the older copies are still inside the
seven-day retention window.

### The token this needs

Create an R2 API token in Cloudflare with **Object Read only**, scoped to the `abzum-console-backups`
bucket, and put its Access Key ID and Secret Access Key into Doppler under `abzum-kestra` / `prd`.

Read-only is not caution for its own sake. This token sits on the same server as the thing it backs
up. A token that could also write or delete would let anyone who took the server destroy the offsite
copies too, which is the single thing an offsite copy exists to survive. Read-only means the worst
they can do is read backups they already have the database for.
