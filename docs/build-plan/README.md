# Development roadmap

This page preserves the original phase and issue map. The current architecture and delivery order are defined by the [target architecture](target-architecture.md), which supersedes conflicting directions here. The product goal remains a visible definition-led application: an authorized user navigates installed pages, browses and opens records, creates and edits records, invokes declared actions and sees the installed theme. Generic engines render ordinary definitions; application names and business policies are not hardcoded.

[GitHub roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3) · [Architecture decisions](architecture-decisions-2026-09-25.md) · [Authority ledgers design record](authority-ledgers-design-2026-09-25.md) · [Product specification](../specification/README.md)

The [GitHub project roadmap](https://github.com/orgs/Abzum-NZ/Abzum-Vortex/projects/2/views/3) records issue status and dependencies. The [21 September architecture review](architecture-review-2026-09-21.md) is a historical snapshot of main at `e4cd4375958b91c55a5bd93b00c86656b98a8d13`.

## Historical scope mapping from 25 September 2026

The [25 September architecture decisions](architecture-decisions-2026-09-25.md) record the product direction and issue mapping from that date. The [target architecture](target-architecture.md) now defines current direction.

| Scope | Phase | Covers |
| --- | ---: | --- |
| [#990](https://github.com/Abzum-NZ/Abzum-Vortex/issues/990) | 4 | Readable database programs, read-time deadline values, access plan cache |
| [#976](https://github.com/Abzum-NZ/Abzum-Vortex/issues/976) | 4 | One Kestra-shaped flow language, protected-operation executor, flow runner prerequisites |
| [#999](https://github.com/Abzum-NZ/Abzum-Vortex/issues/999) | 5 | Theme vocabulary, Records table, layout and navigation blocks, responsive layout, interface tasks |
| [#1015](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1015) | 6 | Entry routing, administration access and operation wiring |
| [#1051](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1051) | 7 | Access operations, approvals as Kestra workflows, builder permissions |
| [#1025](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1025) | 7 | System modules for people, groups, roles, organisations and settings |
| [#1059](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1059) | 7 | One record-change path and leaner engine evidence |
| [#1079](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1079) | 8 | Access and filters inside list queries, runtime bundle cache |
| [#1085](https://github.com/Abzum-NZ/Abzum-Vortex/issues/1085) | 9 | Runnable Kestra flows, one system actor, background jobs, custom scripts |
| [#112](https://github.com/Abzum-NZ/Abzum-Vortex/issues/112) | 11 | Application packages, custom components, clean uninstall |
| [#200](https://github.com/Abzum-NZ/Abzum-Vortex/issues/200) | 10 | Agent building and use through MCP |

## Original phase map

| Phase | Functionality | Scope epic |
| ---: | --- | --- |
| 1 | Identity, access and current contracts | [#9](https://github.com/Abzum-NZ/Abzum-Vortex/issues/9) |
| 2 | Definitions, modules and storage | [#18](https://github.com/Abzum-NZ/Abzum-Vortex/issues/18) |
| 3 | Record changes and lifecycle | [#31](https://github.com/Abzum-NZ/Abzum-Vortex/issues/31) |
| 4 | Queries and current-user flows | [#42](https://github.com/Abzum-NZ/Abzum-Vortex/issues/42) |
| 5 | Application and page runtime | [#53](https://github.com/Abzum-NZ/Abzum-Vortex/issues/53) |
| 6 | First visible definition-led application | [#63](https://github.com/Abzum-NZ/Abzum-Vortex/issues/63) |
| 7 | Visual designers and start pages | [#75](https://github.com/Abzum-NZ/Abzum-Vortex/issues/75) |
| 8 | Search, files and query caching | [#87](https://github.com/Abzum-NZ/Abzum-Vortex/issues/87) |
| 9 | Workflows and delegated execution | [#98](https://github.com/Abzum-NZ/Abzum-Vortex/issues/98) |
| 10 | Connections and interfaces | [#109](https://github.com/Abzum-NZ/Abzum-Vortex/issues/109) |
| 11 | Sharing, copying and data exchange | [#164](https://github.com/Abzum-NZ/Abzum-Vortex/issues/164) |
| 12 | Privacy, retention and capability limits | [#165](https://github.com/Abzum-NZ/Abzum-Vortex/issues/165) |
| 13 | Operational functionality | [#166](https://github.com/Abzum-NZ/Abzum-Vortex/issues/166) |

## Development acceptance

Every behaviour change is walked through in the running app on a freshly reset local database before merge. Pull requests that change what users see include screenshots. See [AGENTS.md](../../AGENTS.md) for working instructions.

## Original Phase 6 outcome

Identity/access, one current definition format, installation/storage, record operations, queries and page/form/application composition must connect into the existing Next.js UI. Include actual session/access decisions, initial operating access and declared action wiring. No fake permission bypasses, fixture-only result or hardcoded demo counts as the implemented application.

Application installation and initial operating access are explicit owning-service operations. The initial setup command binds a frozen server-owned manifest to the original provisioning receipt and nominated account. It installs exact releases and establishes only their named operating access. Ordinary application requests continue to use actual sessions and Access decisions; management status or first login never invents business permissions. The later governed access-request workflow is Phase 9.

The original phase map places the visual designer, search/files, durable workflows, connections, sharing and MCP after the first visible application. Current delivery order is defined by the [target architecture](target-architecture.md).

## Current representation

This is a new application. Application, Module and Group owners replace obsolete format branches at their source and update all consumers together. There is no requirement to preserve unused V1/V2/V3 readers, converters or compatibility fixtures. Normal immutable product releases, explicit installed-release selection and revisions remain product functionality.

## Historical plans

Earlier dated architecture notes remain historical records. Current requirements and decisions are in the [product specification](../specification/README.md) and [target architecture](target-architecture.md).

## Working guidance

- [Definition-led application delivery](engine-first-application-delivery.md)
- [Specification](../specification/README.md)
