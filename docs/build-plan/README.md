# Build plan

The [target architecture](target-architecture.md) is binding for all code. The
[product specification](../specification/README.md) holds the requirements. Issue status and
dependencies are on the [GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3).
Working instructions are in [AGENTS.md](../../AGENTS.md).

| Document | Covers |
| --- | --- |
| [Target architecture](target-architecture.md) | Product rules, repository layout, rendering pipeline, database, errors, guardrails |
| [Architecture decisions](architecture-decisions-2026-09-25.md) | Flows, applications, packages and caching decisions; the target architecture wins where they differ |
| [Data grid core](grid-core-design.md) | One SQL function per query mode, one page state owner, one feature definition contract |
| [Grid feature fan-out](grid-feature-fanout.md) | Per-feature work on the feature definition contract |
| [Studio redesign](studio-redesign.md) | App Studio interface |
| [Module installation and record storage](module-record-provisioning.md) | Installation and storage sequencing |
| [Access operations and their consumers](access-consumer-handoffs.md) | Administration and IAM consumers |
| [Landing Zone application](landing-zone-application.md) | The Landing Zone application definition |

Every behaviour change is walked through in the running app on a local database lane before merge.
Pull requests that change what users see include screenshots.
