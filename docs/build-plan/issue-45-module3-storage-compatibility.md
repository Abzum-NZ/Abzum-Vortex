# Module 3 storage compatibility

[Storage task #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45) ·
[Installation plan](module-record-provisioning.md) ·
[Coordination](agent-coordination.md)

## Reviewed implementation

Fable 5.1 inspected the contracts, compiler, provisioner and tests in session
`386287f0-7e79-4604-a808-b99ab38ebd93`. Codex reviewed the plan and requested exact
source/validation agreement and NULL-safe existing embedded identity checks;
Fable confirmed. This is design review, not implementation approval.

Module 3 adds rule graphs to Module 2 content without changing its field/storage
model. Change only `vortex_record.provision_exact_module_storage(uuid, bigint)`
through the CLI-created forward migration
`supabase/migrations/20260909101526_accept_module_v3_storage_pair.sql`:

- Accept validation 2.0.0 and 3.0.0, with source version equal to validation.
- Embedded validation must equal the release column; embedded kind must be module;
  embedded root must equal the selected root. Use IS DISTINCT FROM for these
  existing JSON checks so SQL NULL cannot evade them.
- Replace the existing function under its existing owner, with the body otherwise
  unchanged, including signature, volatility, security mode and empty search path.
  Make V2-specific failure messages version-neutral.
- Preserve owner/ACL: no new grants, roles, public helper or duplicate generator.
  Keep generator contract 1.0.0; physical meaning is unchanged and excludes rules.
- No TypeScript, source contract, table naming, field mapping, lock order,
  compatibility algorithm, permission or historical migration changes.

Codex mechanically compares the replacement against the original and reviews
every intentional difference before local database execution.

## Tests and evidence

Extend `supabase/tests/455_record_storage_provisioning.test.sql` using existing
transaction-scoped fixtures and real coordinator/private-helper paths. Preserve
the existing 31 assertions. Add focused proof for:

1. Native first-use Module 3 creates storage and exact provision evidence.
2. A V2-to-V3 rule-only release reuses tables/columns and storage meaning, advances
   the compatible catalogue bound, and leaves historical releases unchanged.
3. Older compatible V2 retry after V3 advancement creates no storage change.
4. Source/validation disagreement, embedded-output disagreement, unsupported
   versions and missing embedded identity refuse without provisioning evidence.
   Use a small table-driven fixture set for gate outcomes.
5. Owner, security mode, empty search path and restricted-role ACLs remain intact.
   Reuse existing permission assertions rather than duplicating them.

Codex independently reviews the patch and runs applicable database/concurrency
checks. Use the existing local database without resets or hosted changes;
rollback-scoped verification is preferred. Local proof is not hosted verification.

### Local implementation review — 9 September 2026

Opus 5 authored the implementation and focused review corrections in session
`546a5f75-f00c-4c73-b873-759cc75fd36a`. Codex reviewed the actual patch, not just
the summary. Mechanical comparison against the original function found only
CREATE OR REPLACE, the exact version/identity gate and version-neutral messages;
the storage, permission and locking body is unchanged.

- The original 31 storage assertions passed before the change.
- All 44 updated assertions passed with the forward migration inside one local
  rollback transaction, including the restricted-request Module 3 coordinator
  path. No installation activation is claimed.
- The rule-only upgrade retains the physical table OID, columns and storage
  meaning, and leaves the earlier release's V2 contracts and receipt intact.
- Codex corrected the test harness so pgTAP runs with its existing permissions
  while the tested private operation still runs as the Module owner. No role
  grants were added to make a test pass.
- The existing two-connection provisioning concurrency proof passed against the
  local baseline function. Its locking body is identical to the replacement;
  this is regression evidence, not a hosted/new-version concurrency run.
- Formatting and patch whitespace checks passed. No hosted database or migration
  history changed; exact hosted Testing verification remains outstanding.

## Remaining work and stop boundary

This does not activate installations, fix transitive provisioning, support
Application 2 in the coordinator, select all persisted-value codecs, deliver
protected saves/receipts/events, or close #45/#43/#47. No denied patch is reused.
Follow the current handoff safety history.

After this compatibility task, the user requests a full codebase/specification/
GitHub architecture review by Fable 5.1. Codex assesses findings; Fable 5 updates
agreed specifications/tasks and breaks implementation down for Opus 5 and Sonnet 5
under Codex coordination. Do not start that review during this implementation.
