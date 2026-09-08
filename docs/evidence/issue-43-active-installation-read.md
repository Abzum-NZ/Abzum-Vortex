# Exact active installation read — bounded evidence

[Module lifecycle #43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43) ·
[Reviewed plan](../build-plan/issue-43-active-installation-read.md)

## Scope

Module reads the exact active Application and required Module bindings from the
verified current Application context. Definition reads that local Application's
exact release and its pinned Module releases, including shared Modules owned by
another organisation. Callers cannot choose a foreign root or organisation, and
ordinary runtime discovery does not require installation-management permission.

The existing generic Definition consumer reader keeps its system-only,
same-organisation behavior. The Event projector permits exact shared Modules
without weakening its dependency and release checks. These operations identify
installed definitions; they neither activate an installation nor grant record
access.

## Author verification

| Check | Reported result |
| --- | --- |
| Focused TypeScript tests | **8 files / 48 tests passed**, covering contracts, repositories and release projection. |
| Actual database proof | [SQL460](../../supabase/tests/460_application_bound_release_reads.test.sql): **18/18 passed** in a rollback-only transaction after the transitive-dependency correction. It reads Module installation evidence and the Definition release set under the same verified Application context. |
| Database scenarios | Exact shared foreign Module included; unrelated releases excluded; detached history ignored; partial/mixed installation and missing Application context refused; private projector/raw-table access remains unavailable to the request role. |
| Types and boundaries | Contracts, Definition and Module type checks passed; scoped lint and all **23 package boundaries** passed. |
| Local database lint | The supported CLI reported no schema errors for `vortex_definition` and `vortex_module`. The installed CLI exposes no local advisor command; no advisor result is claimed. |
| Independent actual-work review | **Approved by an independent Sol reviewer** against all 17 final file hashes and the narrow plan/specification/evidence changes. The reviewer independently reran **48/48 TypeScript** and **18/18 rollback-only SQL** checks and confirmed no dependency on excluded #35/#250 work. |

Frozen SQL SHA-256 values were independently read from disk by the root agent:

| File | SHA-256 |
| --- | --- |
| [Definition read migration](../../supabase/migrations/20260908162212_read_application_bound_release_set.sql) | `187737d29687d49075e74f5df8cf9dbf5cf6c7bde39cfe97f7a2f4a565647ce3` |
| [Module read migration](../../supabase/migrations/20260908162229_read_current_active_installation.sql) | `512310af14af615d841447dd1e54a40fbb4885478394604cc28deaf39b21281e` |
| [SQL460 proof](../../supabase/tests/460_application_bound_release_reads.test.sql) | `9a3ae64183fa1a4d3059d8d2d6d24cbda46cc73c66f74bfe5f4799eaa717fd51` |

Focused command:

```powershell
node ./node_modules/vitest/vitest.mjs run contracts/test/storage.test.ts contracts/test/definition-consumer-read.test.ts runtime/module/test/storage-provisioning.test.ts runtime/module/test/installation-binding-reader.test.ts runtime/definition/test/application-bound-release-set-repository.test.ts runtime/definition/test/definition-consumer-read-repository.test.ts runtime/definition/test/definition-consumer-read.test.ts runtime/definition/test/installed-event-catalogue.test.ts
```

The SQL proof seeds an active installation fixture. This proves the reader, not
a delivered activation operation. The two private read migrations were exercised
on the existing local Vortex database; this document does not claim ordered
hosted migration verification, Production delivery or new security-advisor results.

Independent review found a direct-only dependency assumption in Module discovery
and Event projection. Both now follow the complete exact reachable Module set,
including Application-to-Module-to-shared-Module. The revised database proof
includes that case and a missing transitive binding. The already-delivered
provisioner still needs the separately recorded [transitive provisioning work](../build-plan/module-record-provisioning.md#integration-prerequisites);
this reader correction does not claim to deliver it.

## Remaining acceptance

The whole Module lifecycle task remains open for real activation, upgrades,
detachment, governed non-human execution and owning runtime integrations.
Protected saves still recheck current binding/revision and access before commit.
This reader is not an authorization receipt that can be reused to bypass those
checks. There is no new screen to screenshot in this headless delivery.
