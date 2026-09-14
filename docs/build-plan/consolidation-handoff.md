# Consolidation and next-agent handoff — 10 September 2026

Historical stopping-point record. Work subsequently resumed and the live board
now marks [#35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) and
[#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37) complete. The next-agent
sequence below is not a current instruction to rebuild them; check current
delivery evidence and dependencies first.

[GitHub task board](https://github.com/orgs/Abzum-NZ/projects/2/views/1) ·
[Build plan](README.md) · [Engine-first sequence](engine-first-application-delivery.md)

## Scope and stopping point

The user clarified: finish existing unmerged work and consolidate branches, not
every acceptance criterion of the 17 In progress board items. Stop coordination
after this consolidation. Do not automatically start the next implementation,
restart Claude sessions or recreate monitoring schedules.

## Disposition of existing work

| Work | Consolidated outcome | Still unfinished |
| --- | --- | --- |
| [Relationship totals #48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48) | Pure count/sum/minimum/maximum/average evaluator, related-record filters, exact arithmetic and publication checks. Review corrected accepted datetime precision. | Real related-row selection, access/disclosure, affected-parent locking and atomic save integration. |
| [Flow bindings #250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250) | Versioned component-event, flow-node, input/result and run-as descriptors; current-account source has a fixed reference type. | Compilation/registration, actual execution and runtime integration. A valid descriptor is not a usable flow. |
| [Row policy #35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) | Fresh unmerged source retained as [non-executable checkpoint text](../checkpoints/issue-35/README.md), not active SQL. | Complete exact-record decision, neutral policies, regression/concurrency and hosted proof. Empty migration omitted. |
| [Hosted verification #266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266) | Correct the commit runner to recognise the existing `record_data` schema, including a regression refusing omitted lint coverage. | Exact hosted verification is still required before promotion; no new deployment framework or Kestra upgrade. |
| [Module installation #43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43) and [protected save #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47) | Preserve delivered reader/save-command work and clarify transitive installation and trusted final-value handoffs. | Full installation and protected persistence remain open; plans are not implementation evidence. |
| Older branch candidates | Native V2 composition was superseded by the delivered compiler and later placement corrections. Older specifications, infrastructure plans, authentication receipts and fixture branches are historical, not new release changes. | Do not restore superseded behaviour or explicitly rejected SQL. |

No executable migration, database privilege, authentication route, infrastructure
upgrade or App Designer is added by this consolidation patch. The complete Testing
branch nevertheless contains earlier database work; main promotion must use the
normal verification rules for that full branch, not only this patch.

## Verification

Independent GPT-6 Astra reviewed actual totals/binding source and both corrections.
Focused checks passed **3 files / 22 tests**. An initial full run had one existing
fixture test exceed its five-second timeout while a focused suite was also running;
1,795 tests passed. A second default-parallel run also exceeded timeouts in two
existing compiler/fixture tests. The same complete suite with two workers passed:
**140 files / 1,796 tests**, with two files / three environment-dependent tests
skipped as configured. No assertions or timeouts were changed. All 23 package
type checks and boundaries, formatting and lint passed; the fixture command
passed **17 tests**. Final build, runner and deployment receipts belong in the
linked consolidation PR, not inferred from these partial results.

The later preview passed all 1,796 tests but the separate complete-bundle fixture
hit its implicit five-second timeout. Its equivalent first scenario already used
15 seconds. The second now uses the same scoped allowance; all assertions remain
unchanged, 17 fixture checks passed, and the full preview succeeded before
[PR #372](https://github.com/Abzum-NZ/Abzum-Vortex/pull/372) entered Testing.

### Existing Testing migration gap

Testing `09afc4b` passed repaired manifest validation but refused an unapplied
`20260908122641_record_storage_provisioning.sql` before its latest applied
`20260908124240_adopt_shipped_platform_permission_catalogue.sql`. Read-only history
inspection confirmed this was the only older gap, with four ordinary later
migrations pending. Independent Astra review confirmed the storage migration
creates Record/Module objects and does not replace catalogue/stewardship functions;
the catalogue migration has no migration-time storage dependency or provisioning.

The runner permits Supabase's documented `--include-all` only for that exact older
gap and exact remote maximum. Unknown remote history and every other older gap
refuse before applying. Ordinary pending tails and empty databases retain normal
delivery. Applied migration filenames and contents are not renamed or repaired;
all SQL, concurrency, lint and final-history checks remain required. This is a
bounded consolidation correction, not general permission to reorder migrations.

After that repair, Testing applied all five pending migrations. Its SQL gate then
identified obsolete Definition test inventories: the installed storage owners now
have six private SELECT policies, and the application-bound reader adds a narrow
request entry point. The test-only follow-up asserts the exact policy names,
tables, owner roles and operations, updates the entry-point inventories and checks
every function's empty search path. Existing raw-table access denials, forced row
security and immutable-write protections remain. No database privilege is changed
to satisfy the tests. Exact hosted success is still required for promotion; use
[the promotion PR](https://github.com/Abzum-NZ/Abzum-Vortex/pull/373) for final receipts.

## Recovery and branch cleanup

A pre-cleanup Git bundle at
`C:/Apps/Vortex-consolidation-archive/before-consolidation-20260910.bundle`
preserves all local and remote refs. Original dirty worktrees are retained; no
recursive worktree deletion is part of this task. The fresh #35 checkpoint is
also committed as text so it does not depend solely on this machine.

Keep `main` and `testing` as the live environment branches. Only remove other
branches after proving their contents are merged, equivalent/superseded, or
explicitly preserved as historical artifacts. The historical `evidence` ref may
be retained as a tag so existing screenshot links still resolve.

## Next-agent instructions (after a new user start)

1. Read the current [specification](../specification/README.md), this handoff,
   [engine-first plan](engine-first-application-delivery.md) and live board.
   Check current branches, PRs and actual code before assigning work. GitHub is
   authoritative for current status; do not mistake partial In progress tasks
   for active developers or completed features.
2. Finish [#35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35), then integrate
   [field access #37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37) with its
   complete record contributions. Use the current task plans and preserve
   tenant isolation without adding speculative authorization machinery.
3. Follow the coordinated [installation and save sequence](module-record-provisioning.md):
   exact transitive installation, generated storage, final field values/rules,
   totals, revisions, Activity and Event effects. Respect each task's real
   dependencies; do not claim a pure evaluator is a working save.
4. Integrate query, page/runtime assembly and configured behaviour into
   [the definition-first application proof #327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327).
   Build engines and a usable definition-led application before the visual designer.
5. Before each task, update its actual scope and acceptance criteria. Use one
   accountable writer and an independent actual-work review. Keep business-domain
   names in fixture definitions, not core engines. Do not revive the former
   multi-agent coordination loop without a new instruction.
6. Keep specifications, plans, issue descriptions and real dependencies aligned.
   Ask the user only for unresolved product behaviour or genuinely missing
   authority, not routine engineering choices. Leave deferred maintenance deferred.
7. Report Completed, Coming up, Pending User Decision and Overall Progress as
   table rows, linking every task. Count **all** board items for completion
   percentage; at this handoff the verified baseline is **60/173 = 34.7%**.
