# Application installation activation and detach evidence

Task: [#43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43) ·
[installation plan](module-record-provisioning.md) ·
[active reader](issue-43-active-installation-read.md)

## Delivered boundary

Module exposes two fixed protected operations: activate and detach one exact
Application release's complete Module pin set. The public command contains only
the exact local Application root/release and the canonically ordered expected
revision of each required binding. Organisation, account, Access version and
correlation identity come from the trusted human request context.

Access owns the authority check and its row lock. Module calls it before locking
bindings, locks every direct and transitively required binding in Module-identity
order, then calls Access again and compares the same current facts. It derives the
required set again from the immutable Application release and rechecks every
binding's revision and release/content/resolution evidence after those locks.
The supplied set therefore cannot omit or insert a dependency: its count must
equal the derived set, identifiers must be unique, and every derived Module must
appear exactly once.

For each required Module, activation calls Record's narrow protected exact-release
provision-evidence read and requires a result matching the binding's content,
resolution, generator and complete storage-contract identities. A missing evidence
row refuses activation and is not repaired there. Module does not read or receive
privileges on Record's private provision tables.

Activation requires every exact binding to be provisioned and the Application's
Access-owned permission snapshot to match the same release. Detach requires the
same complete set to be active. Each operation updates the whole set in its one
transaction or updates nothing. Exact current-state retry returns `changed: false`;
stale revisions refuse. Detach retains storage, mappings and records, changes no
other Application's bindings, and the active reader refuses the detached target.
No lifecycle receipt, fingerprint, counter, copied event catalogue or new grant
framework was added.

## Implementation and verification map

| Area | Evidence |
| --- | --- |
| Shared command/result contract | `contracts/src/storage.ts`; strict canonical binding list and matching lifecycle result schemas |
| Module service boundary | `runtime/module/src/installation-lifecycle.ts`; fixed transaction repository and closed error mapping |
| Access-owned decision | `vortex_access.lock_application_installation_authority()` in `20260913010000_application_installation_lifecycle.sql` |
| Record provision evidence | `vortex_record.read_exact_module_storage_provision()` in the same migration; one immutable exact-release evidence read, executable only by Module's non-login owner |
| Atomic lifecycle writers | `vortex_module.activate_application_installation()` and `vortex_module.detach_application_installation()` in the same migration |
| Database behavior | `470_module_dependency_pin_set.test.sql`; direct/transitive success, omission/insertion/substitution/staleness/mixed-state refusal, retries, registration and authority refusal, retention and shared-Module isolation |
| Concurrent lifecycle and authority changes | `module-storage-provisioning-concurrency.test.sh`; competing activation commands serialize so the second refuses stale without a mixed state, and a real assignment revocation makes a waiting activation refuse stale authority without changing its provisioned binding |
| TypeScript behavior | `contracts/test/storage.test.ts` and `runtime/module/test/installation-lifecycle.test.ts` |

Local verification is implementation evidence, not hosted promotion evidence.
Independent patch review remains mandatory before merge.
