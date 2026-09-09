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

## Remaining work and stop boundary

This does not activate installations, fix transitive provisioning, support
Application 2 in the coordinator, select all persisted-value codecs, deliver
protected saves/receipts/events, or close #45/#43/#47. No denied patch is reused.
Follow the current handoff safety history.

After this compatibility task, the user requests a full codebase/specification/
GitHub architecture review by Fable 5.1. Codex assesses findings; Fable 5 updates
agreed specifications/tasks and breaks implementation down for Opus 5 and Sonnet 5
under Codex coordination. Do not start that review during this implementation.
