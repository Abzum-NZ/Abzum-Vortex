# Protected Access administration evidence

## Removal-only cleanup approval — 8 September 2026

The user explicitly authorized delegated organisation administrators to remove
assignments to withdrawn roles/permissions only when the operation cannot restore,
recreate, assign or increase authority. The [approved implementation scope](../build-plan/issue-40-protected-access-administration.md#approved-removal-only-cleanup-after-withdrawal--8-september-2026)
retains exact management permission, current organisation-catalogue delegation for
an unavailable empty role, revision/governance checks, terminal removal and atomic
Access/Activity. Historical permission fallback and permission-only removal remain
excluded. The earlier tool-authorization hold is resolved; this approval is not
evidence of a passing implementation, source delivery or hosted verification.
Those results will be recorded separately after actual execution and independent
review. The historical checkpoint descriptions below retain their original scope.

## Removal-only assignment operation — locally verified, 8 September 2026

Implementation: `fca2992fd1cc552ddf445e2730c94f0bc6cf8b24`, in
[PR #334](https://github.com/Abzum-NZ/Abzum-Vortex/pull/334). Merging Testing ancestry
into the feature branch as `954e3627db0cd6388ffeaf4a47ddcc1689cb9e94` preserves its exact
tracked source tree, `d4657bdbe193fb4274203e17b65aa6d03eedb295`.

The protected command accepts only one existing assignment identity and its
expected revision. Its trusted operation checks the current organisation, fixed
assignment-management permission and complete affected scope. Only an explicitly
unavailable current role with zero entries uses organisation-catalogue delegation;
bounded delegation, missing management permission and empty active/retired roles
refuse. It calls the existing terminal assignment coordinator and appends one
Activity entry atomically with the single Access change. No grant, reactivation,
historical fallback or new authority mechanism is added.

Independent Sol review approved the exact nine implementation/test files after
correcting a test that had conflated an unknown assignment with a real foreign
assignment. The corrected test proves that the foreign assignment remains live at
the same revision. Root independently executed the final rollback-only SQL350
**37/37** and SQL395 **8/8** checks. The implementer also passed both real
role-change and Group-administration concurrency harnesses under the candidate
function, then restored the previous local function without changing migration
history. The withdrawal harness proves actual application withdrawal, insufficient
management/scope refusals, catalogue-delegated success and unchanged retained role
and assignment facts.

Existing unchanged coordinator proofs establish retained activation provenance
after source-assignment revocation ([SQL240](../../supabase/tests/240_organization_role_activation_changes.test.sql))
and refusal of stale activation authority ([SQL290](../../supabase/tests/290_organization_permission_eligibility.test.sql)).
The existing Activity-collision test covers rollback through the identical shared
writer/append path. These are reused rather than adding duplicate history or
rollback permutations for the new scope-selection branch.

The separate isolated snapshot used its own locked dependencies and matched all
**612 tracked files** of `fca2992` by SHA-256, with no dependency junction escaping
the snapshot. It passed formatting, lint, boundaries, **1,311 tests across 88 test
files**, **8 fixture checks**, and the direct existing typecheck/build scripts in
all **23 packages**, including the Next.js production build. Two live-test files
containing three tests were skipped; no live Identity or hosted verification is
claimed by that run.

The isolated `pnpm verify` command itself **did not pass**: Turbo's typecheck
orchestrator exited `3221226505` twice without a TypeScript diagnostic. An earlier
unelevated invocation could not read dependencies installed under the elevated
context; matching the installation's execution context resolved that file-access
error without changing dependencies or hoisting. Independent Sol review confirmed
that running the same existing package scripts directly, in dependency order,
provides equivalent substantive source checks. All those direct checks passed.
No CI configuration, protection, dependency version or product source was changed
to accommodate the tooling faults. The native mixed-working-tree full check also
passed, but is corroboration only because it included unfinished #35 work.

Local Supabase security advisors reported no issues in the existing local database;
this baseline check is not a hosted or candidate-migration receipt. The separate
#35 database candidate is excluded from this delivery. Exact hosted Testing
verification remains required before closing the whole task; no Production
promotion is claimed.

## Private role and delegation composition — 7 September 2026

Source delivery: [PR #332](https://github.com/Abzum-NZ/Abzum-Vortex/pull/332) merged normally into Testing at `2026-09-07T06:11:02Z`, after both preview checks passed. Reviewed source `6569a4d54b3522360f07cf90ee0e98c2c0975e7f` merged as `c036ff274e31fa7f4d71a17c9f37341c81d892cd`. This includes both private composition families and the reviewed consumer-ownership documentation. No protection was bypassed. At that checkpoint, the exact hosted database/security/concurrency receipt and isolated assignment-cleanup exception remained unresolved. The later cleanup approval is recorded above; implementation and hosted verification still keep the whole task open.

The second private family supports delegation grants/scope replacement and all six existing authority-establishing role variants: create custom, copy a current template, accept a new application role, revise custom permissions, change role policy, and accept an application role revision. It checks fixed management permissions plus the exact complete before/after scope, then reuses existing canonical preparation, source checks, assignment manifests where required, stewardship and atomic Access/Activity writers. These are owner-only functions, not runtime/MCP endpoints or a delivered IAM grant journey.

Independent Sol actual-work review approves the final executed migration and SQL420 proof. The focused proof passes **39 assertions**, including successful real application-source cases, incomplete delegated authority, stale/foreign requests, restricted-role refusal and both role/delegation Activity rollback. Review rejected the earlier invalid-source-only evidence for three advertised variants; the final proof uses actual registered Definition/template fixtures. Scope-fingerprint recomputation remains at the existing TypeScript prepared-evidence boundary for the later verified IAM consumer; SQL does not introduce a parallel fingerprint implementation.

The migration was applied only locally. A first transactional parse failure was corrected by selecting the composite role row correctly, and collision assertions were aligned with the wrapper's existing closed error while preserving actual rollback checks. Final SHA-256: migration `20260907053923_protect_private_delegation_role_authority_composition.sql` is `ed02f374ad3c1f91eea062d58f308948e16851c189f85c8866b8d0b8b5518786`; SQL420 is `4431a5dbeab9c37a41786495127bcd34d4ef61c4af62aa525d44864ac52d2494`. Neither depends on the excluded assignment-revocation draft.

Root's exact staged-source database export, including the approved membership/assignment family, passes **58 SQL files / 2,594 assertions**. The full working-tree repository gate also passes formatting, lint, 23 package typechecks/builds, boundaries, tests and fixtures; unchanged package checks use normal task caching. Separate assignment TypeScript work remains in that working tree and this result does not approve its excluded SQL exception. Concurrency, database lint and hosted/source delivery results are recorded separately when verified. The existing local database contains the undelivered assignment draft, but the exported source/test corpus excludes it and its unfinished test changes.

All **25 manifest-registered concurrency proofs** pass in one uninterrupted run from that same exact staged-source export. Six-schema database lint has no errors and the same eight existing warnings; neither new private migration adds a warning. Local security advisors at warning/error level report no issues. No database reset, provider upgrade or production change was required. These are local results, not an exact hosted receipt.

## Private membership and assignment composition — 7 September 2026

The next private engine family composes Group membership addition, restoration and renewal, and role-assignment grants from the existing governed writers. It binds the current organisation, person and correlation to verified context, checks complete affected authority, preserves the trusted Activity source and commits one Access/Activity result atomically. These functions are owner-only: public, anonymous, authenticated, service, runtime and request roles receive no execution grant. A working user-facing grant journey still belongs to [IAM #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267); verified session alone is not its invocation boundary.

The migration was applied locally and the focused SQL415 proof passes **30 assertions**. Independent Sol actual-work review approves the exact executed bytes. Execution corrected a SQL CASE parsing ambiguity by binding the existing operation key once, replaced an invalid expired fixture with a coordinator-created membership followed by real expiry, and aligned an Activity-collision assertion with the existing `22023` contract while retaining atomic rollback checks. No production permission or constraint was relaxed. This is local private composition evidence, not source delivery, hosted verification or whole-task completion.

Frozen SHA-256: migration `20260907051411_protect_private_membership_assignment_composition.sql` is `e306adcab72e2af3b28e839e1b8bc163765638c8b9b071524923cf7f24aa973f`; SQL415 is `d0282a1904fcc68c3b93497e62e225df0ed1492fffb157cdfdf5d394306c5637`. This family depends on the delivered structural authority helper, not the excluded assignment-revocation draft. Remaining role/delegation and other private compositions continue separately before the combined checkpoint is delivered.

## Structural administration — 7 September 2026

Source delivery: [PR #331](https://github.com/Abzum-NZ/Abzum-Vortex/pull/331) merged normally into Testing at `2026-09-07T05:33:43Z`, after both preview checks passed. Reviewed source `433f7cd78dcddb155e9fdbba933414e37c285d0f` merged as `8ac071fa4fcc85b25d0820324ddbe1c0bfc93a2a`. No protection was bypassed. The exact hosted database/security/concurrency receipt remains unverified; this merge does not complete the whole task.

Permitted administrators can retire a Group, remove a membership, edit a role's label/description without altering its permissions or policy, and retire a role. Group changes evaluate the complete retained assignment/delegation scope, including scheduled or expired retained facts. Role metadata uses the existing canonical preparation within the same transaction; all four changes retain current revision, tenant, permission and final-steward safeguards with one atomic Access/Activity result.

Independent Sol actual-work review approves the frozen eight-file candidate. The focused database proof passes 33 assertions, including bounded-scope union/deduplication and protected final-steward refusal. The two-scenario structural race passes with actual blocker chains: a membership change wins before stale Group retirement, and an existing assignment grant wins before stale role retirement. These use the delivered coordinators, not the excluded assignment-revocation wrapper. Initial proof-only temporary-table permissions and race-fixture candidate construction were corrected before the passing runs; no product authorization was weakened.

Root's full working-tree repository verification passes formatting, lint, all 23 typechecks/builds, boundaries, tests and fixtures. That tree still contains separate assignment TypeScript work; it is not approval of that excluded SQL path. The exact staged-source database corpus passes **56 files / 2,525 assertions**, and **all 25 registered concurrency proofs** pass from that same exported index. Six-schema database lint has no errors and retains the same eight existing warnings; local security advisors at warning/error level report no issues. Source delivery and the exact hosted receipt remain separate requirements.

Frozen SHA-256: migration `c9f61f16b8e77901b01fde07e5cb362be554eec49dc7049820c65f6af678f1bd`; SQL410 `c2927deac9924461a4ad21e6be1ba36810b9777f25f07660f42c206f830b2077`; structural race `1659f114b82af1398b27f06af5ba05486b9f6d0b35d9090e3a6ed3485e45a06f`; manifest `0cfcb4d9995f0c79b132b479a4ec56448d504fa097520fc6610908d21c99dfc8`. Selective staging preserves but excludes the unfinished assignment-revocation changes and private membership/assignment draft. No user interface or production promotion is claimed, and the whole [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40) remains open.

## Temporary and delegated access removal — locally verified candidate

Source delivery: [PR #330](https://github.com/Abzum-NZ/Abzum-Vortex/pull/330) merged normally into Testing at `2026-09-07T05:00:47Z`, after both preview checks passed. Reviewed source `41ea316aa841563524670dd92fe71dfd7da97528` merged as `b56daf903e802d7b63d8b688f75a03aeeeae2aa4`. A separate delivery-boundary review confirmed no dependency on the excluded assignment-revocation or structural draft migrations. Exact hosted database/security/concurrency receipt verification remains pending; preview success is not that receipt. The connected Vercel inspection tool lacked access to the project scope, so the normal GitHub checks supplied preview status without a credential or infrastructure change.

Final local database lint passes all six selected schemas without errors. The same eight existing warnings remain; this candidate adds no lint warning.

A subsequent read-only inspection of the intended hosted Testing project (`abflfptnguasinoussws`) confirms all 61 delivered migrations through `20260907035309_protect_activation_delegation_revocation`. The excluded assignment and structural draft migrations are absent. This establishes arrival of this checkpoint's schema, not a passing hosted verification receipt.

The candidate adds protected self-deactivation and administrator revocation of temporary role activations, plus protected revocation of delegation. It reuses the existing governance-first transaction, current authority decision, revision-checked writers and atomic Activity append. Self-deactivation requires no administration permission; administrator deactivation uses the activation's exact immutable role revision, while delegation removal uses its exact current stored scope. No grant, renewal, generic dispatcher or new approval journey is added.

The full working-tree repository gate passed formatting, lint, all 23 package typechecks, boundaries, **1,299 tests with three existing skips**, eight fixture checks and all 23 builds. This working tree also contains the separately excluded assignment-revocation work; that gate is not approval of its known SQL failure. Git index packaging isolates the four activation/delegation TypeScript changes without modifying or stashing the other work. Whole-task approval, exact candidate database proof and source/hosted delivery remain separate requirements.

Independent review found that the first historical-scope test did not distinguish historical from changed permissions, and that the existing raw-writer races did not prove the new protected invocation path. Both were corrected. The final independent Sol review approved the exact staged nine-file candidate after an operation-key result-binding correction; no new evaluator, counter or mock framework was needed.

After that correction, the complete staged-source SQL suite passes **55 files / 2,492 assertions**, and all **24 manifest-registered concurrency proofs** pass, including protected activation/source-change and delegation replacement/revocation contention. The existing test corpus was exported from the Git index to a disposable local directory; the unapproved assignment fixture, its expanded Group/role tests and the structural draft were not selected because they are not part of this delivery. The separate failed working-tree assignment proof remains recorded and unresolved, not skipped and called repaired. Local database history includes undelivered work, so source/migration arrival and exact hosted verification remain separate from these local results.

The focused combined activation/delegation SQL proof passes 99 assertions. It distinguishes original two-permission activation authority from a different current role scope; complete original coverage allows removal and partial coverage refuses. It also proves self-deactivation without administration/read authority, foreign/stale/replay refusal, final-steward delegation protection and Activity-collision rollback. The exact candidate migration SHA-256 is `7ecc4c2eb65bd875d839e4cab4c739f0d6d4660bcf39b9cf240511d625df3e9e`; SQL390 is `aba9f0f5fcb25ff58d057172fac078353ed6ed903b289c5a070d3452eafeb4d2`, activation race is `378c430f0abbc2072019bbcb1e6a5f1da997afdc5a0caf290d75e6705c1af94d`, and delegation race is `91c4937f066627b0163ad3998ec6096995e03e17f034ea58d4f8eaa3feab15bb`. Source delivery and exact hosted receipt are still pending at this checkpoint; the whole #40 task remains open.

Task: [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40). Scope and acceptance: [implementation plan](../build-plan/issue-40-protected-access-administration.md).

## First implementation checkpoint — 6 September 2026

The first bounded implementation adds the governance-first verified human request path and permitted Group list/detail operations. It reuses current Identity, the central Access decision and existing Group facts. It does not deliver mutation endpoints, every administration projection, the IAM interface or the whole task.

The organisation/application change resolvers take the existing organisation write lock before rechecking mutable account and application facts. Only the trusted runtime can call those resolvers. Group readers use the existing exact catalogue permission and return bounded summaries through the restricted request role. No private helper or table is opened to ordinary clients; no second permission engine, approval store or business-domain behaviour is added.

| Evidence                                 | Result                                                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused contract/service tests           | 17 tests pass; contracts and Access typechecks pass                                                                                                                                       |
| Actual restricted-role database coverage | New suite passes all 49 assertions, including permitted/forbidden Group reads, foreign and stale scope, and the real application resolver                                                 |
| Full local database suite                | 41 files, 2,005 assertions pass                                                                                                                                                           |
| Concurrent-change coverage               | All 22 selected proofs pass, including organisation/account locking and actual application withdrawal versus the new application resolver                                                 |
| Security and database lint               | Local security advisors report no issues. All six selected schemas lint without errors; three previously existing Access warnings remain, none introduced here                            |
| Independent actual-patch review          | Sol approved the final implementation and corrected application-resolver proof; no remaining source finding                                                                               |
| Repository-wide check                    | Full verification passes: 1,238 tests, three existing skips, eight fixture checks, 23 package typechecks/builds, formatting/lint and package boundaries                                   |
| Hosted delivery                          | [PR #312](https://github.com/Abzum-NZ/Abzum-Vortex/pull/312) merged into Testing after both normal preview checks passed; the exact hosted database receipt is still pending verification |

The existing local PostgreSQL 17.6 database had 43 migrations before the additive change. The CLI-created migration `20260906101701_protect_organization_access_administration.sql` was applied and iterated locally without resetting data. Once final SQL and concurrency checks passed, the supported local migration-history command recorded that already-applied migration, and the local list confirmed all 44 entries match. No hosted migration history, Production deployment or infrastructure was changed by that local operation.

Review and execution corrected three narrow issues before the passing checkpoint: the application resolver needed an actual database/concurrent-withdrawal test rather than only a transaction mock; the Group-detail SQL output was renamed from the reserved word `group` to `group_summary`; and two assertions were corrected to the existing stale-context error and catalogue-initialised Access version. Public Group results still use the existing `group` property.

One earlier full database run observed a failure in the unchanged Access-version suite: its exhaustion test expected `22003` but received stale-account `40001`. The isolated original suite and the final complete suite both passed without changing that test or its implementation. The cause was not established; this is not evidence that a local clock issue was repaired. A first ad-hoc PowerShell transport also appended a carriage-return line after the new shell proof had passed; running the exact UTF-8 source through the normal Node runner passed. No source workaround was added for either observation.

There is no new user interface to screenshot. Remaining permitted reads, non-grant changes with Activity, private governed handoffs and exact hosted verification remain part of [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40).

## Testing merge

The approved source `9b23a4219e7cd27e99947109c5ba29438cef09e0` merged normally at `2026-09-06T11:11:27Z` as `35b09d1995a56656cbe6f0401666145e4853bd82`; the merge changed no reviewed file bytes. Both Vercel and Vercel Preview Comments succeeded. No required check was bypassed. Read-only inspection of the hosted receipt could not be completed because the Edge browser controller reported a detached/unattached debugger. The ordinary [Kestra KV page](https://kestra.abzum.com/ui/main/kv) opened, but its receipt content was not readable through the connected tool. This is not evidence of a failed hosted run, nor of a successful one. Core implementation continues while the exact result remains unverified; no API workaround, new credential or infrastructure change was attempted.

## Group membership read checkpoint — 6 September 2026

The next bounded slice adds one selected-Group membership page and one exact membership detail. It reuses the existing fixed Group-read permission and shared Access lock; no new permission evaluator or concurrency harness is introduced. Results contain stable references, the existing safe account display name, revision, time window, stored state and descriptive temporal state. `live` storage state is distinct from `active`, `scheduled` or `expired` temporal state; none is an effective-permission decision. Unknown and foreign targets are unavailable without disclosing which case occurred.

Independent Sol review approved the exact six implementation files. The initial transaction-only probe passed all 36 new assertions and rolled back the new index, functions and fixtures. The approved migration was then applied locally: all 42 suites / 2,041 SQL assertions and all 22 existing concurrency proofs passed. All six schemas lint without errors and retain only the same three previous Access warnings; local security advisors report no issues. The supported local history command recorded the already-applied migration, bringing the local total to 45. No hosted database was changed by this local operation.

The engineer's focused contract/service check passes 11 tests, with contracts and Access typechecks plus scoped formatting/lint. The combined working-tree repository gate subsequently passed 1,256 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. That run also included the shared-condition implementation and parallel catalogue runtime/test changes; it is not hosted-delivery evidence. This remains a local implementation checkpoint, not part of the earlier Testing merge.

| Frozen database file                                                                          | SHA-256                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/migrations/20260906110758_protect_organization_group_membership_administration.sql` | `6647b7b991969088557063f4e399666c886cc6f20c398097719b5f02bba790ea` |
| `supabase/tests/335_organization_group_membership_administration.test.sql`                    | `ea9a86b58abcad0b03ac7a291ee9b56b2c2df0b849d32fdfa716dabfba033fc5` |

The membership and shared-condition checkpoint merged normally through [PR #313](https://github.com/Abzum-NZ/Abzum-Vortex/pull/313) at `2026-09-06T11:55:55Z`, after Vercel and Vercel Preview Comments succeeded. Source `2435f3e79991af919b77943413fec21fdd94fd70` and Testing merge `b1cdd1ea466d583e32f561ea9ae0f46de22b587f` have identical file trees. The later catalogue work was excluded from that commit. A bounded read-only retry could list the existing Edge tabs, but selecting the normal Kestra KV tab timed out; the exact hosted database receipt remains unverified. No controller/API bypass, credential change, Production promotion or infrastructure work was performed.

## Group create and rename checkpoint — 7 September 2026

Permitted administrators can now create a Group and rename an existing Group through separate protected commands. Renaming preserves its identity and key and requires the expected revision. Both operations reuse the organisation lock, current account and fixed Group-management permission, update Access once and record one content-free Activity in the same transaction. Creating or renaming a Group does not grant roles, add members or delegate authority. Broader administration and IAM screens remain outside this checkpoint.

Independent Sol review approved the final eight implementation/test files. Focused contract/service checks passed 16 tests, the restricted-role database proof passed 23 assertions, and a new concurrent-rename proof established one winner and one stale refusal with no partial change. The selected hosted verification manifest includes that proof as its 23rd concurrency check; this source change is not evidence that a hosted run executed it.

The final combined local repository verification passed formatting, lint, typechecks, boundaries, tests, fixtures and builds. All 44 database files / 2,087 assertions passed. Local security advisors found no issues; six-schema lint retained only the same three earlier warnings. The concurrency runner passed checks 1–18 before an existing invitation acceptance check failed; an explicit run of checks 19–23 then passed all five, including the new Group check. Thus every selected proof passed, but not in one uninterrupted run. An earlier full SQL run also encountered the existing invitation account-reactivation failure; the isolated test and final complete suite passed unchanged.

Source diagnosis identified an invitation writer using a statement-start audit timestamp sampled before serialization waits, which can be older than the locked invitation/account audit value. [Invitation acceptance #315](https://github.com/Abzum-NZ/Abzum-Vortex/issues/315) records the narrowly scoped follow-up correction, not evidence that the Docker clock was repaired. Revision and Access ordering must remain authoritative; real expiry checks must not use a clamped audit timestamp. No service restart or infrastructure change was made.

The additive migration `20260906115410_protect_organization_group_administration_changes.sql` was applied locally without resetting data. Supported migration history now records all 47 applied entries. The final database proof and race source hashes are recorded below. Hosted Testing receipts remain unverified; no Production promotion is claimed.

The Group-change and catalogue-scope source checkpoint merged normally through [PR #314](https://github.com/Abzum-NZ/Abzum-Vortex/pull/314) at `2026-09-06T12:33:57Z`. Source `87540f7c3414ee295d4c4f0f82702153b7b376a7` and Testing merge `04819359e55d9176eec7fe3665cd3fb76f32af56` have identical file trees. Both normal preview checks passed. The subsequent invitation correction is not included in this merge.

| File                                                                   | SHA-256                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `20260906115410_protect_organization_group_administration_changes.sql` | `3a9d7d4c7f309bfc1fbdfd0223052400f6d63858e0dbaf1b0566b2fe15c3886d` |
| `350_organization_group_administration_changes.test.sql`               | `4b291dda537f3296d64c5b98051bbeee4ccee2c9fda4291fad4cd195b883d3c9` |
| `organization-group-administration-change-concurrency.test.sh`         | `42fe67c792857645da9fbd445da4cd62336af6593eca0bc0304a3026d02cfa3a` |
| `workflows/kestra/database-verification.json`                          | `666c66c3c50e18d11c7f650e7c02e54b5482fd88b566f6d76978906ac8de8c77` |

## Registered permission catalogue checkpoint — 7 September 2026

Permitted administrators can browse and inspect current registered permissions in their selected organisation. The same module permission installed in two applications has distinct contextual references. Only entries from active current registrations appear; withdrawn and historical entries do not. A current declaration awaiting role acceptance remains visible, but catalogue visibility grants no use, assignment or delegation authority. Results exclude raw record scope, publication fingerprints, source preparation and audit internals. No IAM page or granting endpoint is delivered by this checkpoint.

Independent Sol review approved the six frozen implementation/test files. Root's rollback-only database execution found one test defect: concatenating an intentionally null platform application reference made the whole expected cursor string null. The assertion was corrected to compare typed columns, including the actual null, and independently re-reviewed. The corrected rollback proof passes all 25 assertions; the migration itself did not change after review.

The exact reviewed migration was then applied locally without resetting data, and supported local history recorded the 49th migration, `20260906130257`. All 46 database suites / 2,125 assertions pass. Six-schema lint reports no errors and only the same three pre-existing Access warnings. Security advisors report no warnings or errors; their 29 informational notices describe the deliberately policy-free, deny-by-default private tables, not newly exposed access. Full repository verification passes 1,270 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. The runner uses the globally installed Turbo 2.10.12, matching the declared version, and reports its existing local-install warning.

This read-only slice adds no lock path or writer. It reuses the existing governance/read transaction and its previously passing 23 concurrency proofs recorded in [the invitation correction evidence](issue-315-invitation-audit-time.md); that is reused evidence, not a claim of a new concurrency run. The parallel unfinished database-condition migration was not applied or included in these database results. Exact hosted delivery is not yet verified. There is no new interface to screenshot.

The permission-browsing checkpoint merged normally through [PR #317](https://github.com/Abzum-NZ/Abzum-Vortex/pull/317) at `2026-09-06T13:36:12Z`. Both preview checks passed. Reviewed source `a646a3de62d9cb43d51e48e0fa2ece7788bb4c2a` and Testing merge `89f822ae5a53864dad665fd15d0846f7e7ce3880` have identical file trees. No check was bypassed, and unfinished condition work was excluded. This proves source delivery to Testing, not hosted database success or Production promotion.

| Frozen database file                                                                              | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/migrations/20260906130257_protect_organization_permission_catalogue_administration.sql` | `6562a59beb1112b9a8ae4116328c87878e3ebd65fa732ab498dfff8c3f56ef53` |
| `supabase/tests/360_organization_permission_catalogue_administration.test.sql`                    | `2887b58929af6ba04a76bf27a97fa8de3355303a3417921293bbd936f282207e` |

## Local roles and registered application templates — 7 September 2026

Permitted administrators can list and inspect their organisation's current role configuration, including roles awaiting acceptance, unavailable roles and retired roles. Details preserve the exact accepted permission snapshot; pending additions do not silently appear as accepted. Safe policy settings explain standing versus activation-required access without exposing internal evidence. Application role templates are a separate resource, identified by both application and source role, and come only from the exact release selected by the active current registration. Neither view claims effective access or grants authority.

Independent Sol review approved the six implementation/test files. The main architect's rollback proof passes **31 database assertions**, including actual restricted-role permission checks, current versus historical configuration, cross-organisation refusal, bounded complete cursors, removed/withdrawn templates and safe output. Test setup was corrected to follow existing source-evidence constraints, insert accepted entries before sealing revisions, classify administrative custom roles as privileged, and explicitly group a JSON text extraction before concatenation. No production constraint or permission rule was relaxed.

Focused contracts/service checks pass **29 tests**, with both package typechecks and targeted formatting/lint. The prior combined repository gate with this frozen TypeScript implementation passed 1,279 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. The reviewed role migration was applied locally with the separately reviewed [revocation audit correction](issue-318-assignment-revocation-audit-time.md), bringing local history to 52 migrations. Complete regression results and normal Testing delivery are recorded separately when available; no hosted success or usable IAM screen is claimed by these local checks.

| Frozen database file                                                    | SHA-256                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `20260906133622_protect_organization_role_catalogue_administration.sql` | `dbf4f591f89bf654d17ec574e119fe415ce24bb132ca8a3643f4b30bea1c420d` |
| `370_organization_role_administration.test.sql`                         | `86f96900d19a3ad823368ff51cf5919fbfcbecc44e4bffcef2300444270eae2f` |

The final combined run also includes the reviewed current-person condition extension: **49 SQL suites / 2,249 assertions** and **1,280 repository tests** pass, with three existing skips, eight fixture checks and all 23 package typechecks/builds. All 23 existing concurrency checks pass across multiple runs, not one uninterrupted run; [the revocation evidence](issue-318-assignment-revocation-audit-time.md#actual-verification) retains the unrelated intermittent permanent-steward observation and its limited diagnosis. Lint has no errors and only previously reviewed warnings; security advisors report no issues. Local history now contains 53 migrations. No new concurrency framework or clock change was introduced.

The role/template source checkpoint merged normally through [PR #320](https://github.com/Abzum-NZ/Abzum-Vortex/pull/320) at `2026-09-06T14:30:34Z`. Both normal preview checks passed. Reviewed source `ca3d6d6ee89cb143c2986dec1d36d1183d26e748` and Testing merge `e8313abf386338db45dc9cdc9938bba42a78a6a9` have identical file trees. Exact hosted database delivery remains unconfirmed. The next assignment/delegation ledger is not included in this merge, and this checkpoint does not complete #40.

## Role-assignment and delegation ledgers — 7 September 2026

Permitted administrators can list and inspect role assignments and delegation authorities through four protected read operations under the existing assignments-read permission. Results distinguish direct-account and Group holders, standing/eligible assignments, fixed windows, stored states and descriptive temporal states. Revoked, expired and unavailable-source facts remain inspectable. Bounded delegation results contain only exact permission references; internal registration, meaning and continuity evidence is omitted. No result claims effective authority, and no granting endpoint or IAM screen is added.

Independent Sol review approved all six frozen implementation/test files. Focused TypeScript checks pass 37 tests; the main architect's final rollback-only restricted-role proof passes 45 assertions. It covers permitted/denied reads, complete cursor pages, retained holder states, safe output and unknown/foreign refusal. The new response validator rejects UUID-equivalent duplicate delegation references without changing global field-key case rules.

The expired historical delegation fixture cannot use the live-grant insertion path, which correctly refuses already expired grants. It therefore calls the bounded-scope validator explicitly and disables only `organization_delegation_authorities_validate_scope` around one coherent historical insert, then immediately re-enables it. That trigger checks the live window, holder and scope; the fixture separately validates bounded scope and uses an active Group. Structural/FK constraints and the immutable-update protector remain active. No replication-role bypass or immutable expiry update remains; this is a reviewed rollback-only fixture exception, not a production change.

The exact migration was applied only to the local testing database without a reset, alongside the independently reviewed ownership predicate. Local migration history now contains 55 entries. Full repository verification passes 1,288 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. These reads reuse existing locks without a new lock primitive, ordering or write path: the previous governance/read concurrency proof is reused, including its documented multi-run limitation, not claimed as a fresh run. Aggregate database results are recorded below. Source delivery, hosted database success and Production promotion are not yet verified for this checkpoint. There is no new interface to screenshot.

| Frozen database file                                                       | SHA-256                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `20260906142814_protect_organization_assignment_ledger_administration.sql` | `5ad0e0d1594e5a7d658c34493c69c3328dbb4f7410533cde8c64d6a03f2e8984` |
| `380_organization_assignment_ledger_administration.test.sql`               | `37580191e8fa4bb0abb1cad5ca4600bec88677331391fe80de1b946276a8fcb4` |

Final aggregate local verification passes **51 database suites / 2,336 assertions**. Six-schema lint reports no errors and only the same eight previously reviewed warnings; no new warning is introduced by these two migrations. Security advisors report no issues. This remains local evidence, not a hosted receipt.

The ledger and direct-ownership checkpoint merged normally through [PR #321](https://github.com/Abzum-NZ/Abzum-Vortex/pull/321) at `2026-09-06T15:20:45Z`, after both preview checks passed. Reviewed source `20f0ea812c2d00ef94a60f135154b5042983079d` and Testing merge `d60821302149cbe04499116e9c83f4523cb01427` have identical file trees. No check was bypassed. Exact hosted database receipt remains unverified; the next activation reader is not included in this merge and #40 remains open.

## Temporary activation ledger — 7 September 2026

The protected administration service now has bounded activation list/detail operations. Administrators can inspect a beneficiary, the current role label, the historical role revision, retained direct/Group eligibility references and the policy settings that applied at activation. Revoked and expired facts remain inspectable. These descriptive views do not calculate effective access, grant a role, expose private approval/authentication evidence or deliver the later IAM interface.

The six implementation/test files received independent source review. Actual rollback-only execution found a test expression with unparenthesized JSON extraction before string concatenation; only that expression was corrected and independently re-reviewed. The migration and runtime behavior did not change. The corrected focused database proof passes **38 assertions**, including actual permitted/refused request-role access, historical policy retention, complete keyset pages and safe output. Focused contract/service checks pass **41 tests**.

Both this migration and the independently reviewed direct-share migration were applied only to the existing local Vortex database, without reset. The initial combined suite passes **53 SQL files / 2,417 assertions**. All **23 existing concurrency proofs pass in one uninterrupted run**. Six-schema lint passes its error gate with the same eight previously reviewed warnings and no new warning from these migrations. No fresh security-advisor result is claimed here. Full repository verification passes **1,292 tests**, three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting, lint and package boundaries.

This is local checkpoint evidence. Final direct-share test expansion, combined independent review, normal Testing source delivery and the exact hosted receipt are recorded separately when verified. Remaining protected reductions and private governed handoffs remain required by [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40); no task completion or usable IAM screen is claimed. The existing approved access specification requires no new product decision for this ledger.

| Frozen file                                                              | SHA-256                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `20260906152143_protect_organization_role_activation_administration.sql` | `0cf502c68dc10ebbb2b0b1d29b3463553365cde851d13bdcf5529bab63d964da` |
| `390_organization_role_activation_administration.test.sql`               | `f72b387e3789a0aae74866920e96eaf461c3c69b6f0e8975b8a1d1214e240f80` |

Final independent Sol actual-work review approves the activation and direct-share checkpoint with no findings. The final aggregate database result is **53 files / 2,418 assertions**, after the direct-share suite gained its restricted-role proof. The preceding aggregate attempt encountered an intermittent failure in an unchanged stewardship check; [the direct-share evidence](issue-36-record-visibility.md#current-direct-share-contributions--7-september-2026) and [#318](https://github.com/Abzum-NZ/Abzum-Vortex/issues/318#issuecomment-5563910662) retain the failed run and successful isolated/bounded aggregate retry. This is not an unqualified first-run pass or a repair of that separate observation.

## Activation/share Testing source delivery — 7 September 2026

Both normal preview checks passed before [PR #324](https://github.com/Abzum-NZ/Abzum-Vortex/pull/324) merged into Testing at `2026-09-07T02:05:53Z`. Reviewed source `ad3eac494c328317e80c42a1b38ce9cc23dbee93` merged as `e1d9159445c913115618af7e0525b7111320d0ee`; no protection was bypassed. This source contains the reviewed activation ledger and current direct-share contributions, not the subsequent assignment-revocation work.

Read-only inspection through the connected Supabase tool confirms that the intended Testing project contains all 57 migrations through `20260906152638`. This proves schema arrival, not completion of the hosted SQL/concurrency gate. The saved exact-commit Kestra receipt is still unverified: browser inventory shows its existing tab at sign-in, and two bounded attempts to select it timed out. A nonblocking request asks the user to renew the existing session; core implementation continues. No new credential, reset, Production promotion or Kestra change was made.

The Testing security advisor at `2026-09-07T02:10:59.517Z` reports intentional private-table deny-by-default RLS notices, a mutable-search-path warning on the temporary test function `pg_temp_58.vortex_private_schema_assertions`, and the existing hosted Auth leaked-password-protection warning. The new share store has no public/request table grant; do not add a permissive policy to silence its [no-policy notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy). The temporary-function warning requires a post-suite recheck rather than a product migration. [Hosted password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) remains tracked by [security readiness #171](https://github.com/Abzum-NZ/Abzum-Vortex/issues/171), not an assignment-removal change. These observations are not described as a clean advisor report or a completed hosted gate.

## First checkpoint database bytes (historical)

| File                                                                                | SHA-256                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/migrations/20260906101701_protect_organization_access_administration.sql` | `6a38b57e31ac47873c34a4059b81846db53c560b2994e2dc370144465f8f50ee` |
| `supabase/tests/330_organization_access_administration_foundation.test.sql`         | `7d6d6dc530206bbdff6afd9e0d5b76c3b53fa5ad3dfbdf87c9ebe24f01dc90e4` |
| `supabase/tests/organization-access-administration-concurrency.test.sh`             | `c2df5dce569195a4fb98dbb6ac35c438252f76dbe9cf0ac9be0da04caa492d9b` |
| `workflows/kestra/database-verification.json`                                       | `cc8f63971161a2814d83fc6820ca660ef51d2db00ea65fca0d642255366b9adc` |
