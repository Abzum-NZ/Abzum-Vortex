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

## Memory

The server has 8 GB and already runs Coolify and a STUN/TURN service. Kestra is a JVM and takes what
it is given, so both containers carry a limit: 3 GB for Kestra, 1 GB for PostgreSQL.

## Recovering

[Section 24.6](https://claude.ai/code/artifact/f202d3c7-4c73-417c-bd3f-90740c2bc1d4#s24-6) promises
that runs pause and resume from their last completed step when the server returns. That holds only
while `kestra-postgres-data` survives, so it is backed up on a schedule. Losing it loses every run in
flight, and nobody would find out until a restore.
