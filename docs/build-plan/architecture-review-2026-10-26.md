# Architecture review, 26 October 2026

Base `main` 0cdd112b. Phase A read the code and documents; Phase B fixed the findings on
`abzum-admin/arch-batch` (PR #3584) and walked them on lane db3 as the owner and as restricted
members. Findings still open continue on `abzum-admin/arch-batch-2`; the UI review's remaining
findings are split across the FIX batches (`fix-split/partition.md`).

Status: **Fixed** (merged with #3584, commit named), **Batch 2** (ARCH, `arch-batch-2`),
**FIX-x** (another batch), **Not a defect**.

## Architecture findings

| Id | Finding | Status | Change |
|---|---|---|---|
| S1 | Record writes switched the request transaction back to `vortex_runtime` | Fixed c6d7ebac | 18 record write functions granted to `vortex_request`; 13 `set local role vortex_runtime` removed (migration 20261025192000) |
| S2 | Parallel record writers and five activity appenders | Fixed 89739cd3 | one `append_record_activity_internal`; offboarding transfers go through `apply_record_changes` (20261025191000) |
| S3 | Silent catches | Fixed 7ec8ecef, b5eb0ea4 | catches that hide a failure log their cause; the remaining binding-less catches are parse probes |
| S4 | One-implementation service, repository and composition layers | Batch 2 | |
| S5 | Hard-coded UUIDs in SQL | Fixed 459959e1 | `platform_permission_owner_id()` / `platform_permission_id(key)`; guard baseline exemption removed (20261025190000) |
| S6 | `_v1_internal` and "legacy" SQL helpers | Fixed 2053487c | renamed, legacy comments removed (20261025189000) |
| S7 | Dead SQL functions | Fixed 4dc53525 | 14 functions dropped after `pg_depend`, trigger and caller checks (20261025188000) |
| S8 | Summary mode chosen by which optional key is present | Fixed 1390c7e9 | discriminated `mode` |
| S9 | Refusal sentences in a module global; barrel import cycles | Fixed 398fef34, d3de27c1 | 620 internal imports unbarrelled; 0 value-import cycles in platform, ui and web |
| S10 | Builder classification read copied four times | Fixed eca9ad93, 82e83dc6 | `readBuilderApplicationOrigin`; one `databaseCode` reader replaces 14 copies |
| S11 | Query prelude copied seven times | Fixed 0d58b659 | `admitQueryInputs` |
| S12 | Hand-written UI payload parsers | Batch 2 | |
| S13 | Canonical file identity | Fixed 2053487c | one function per file |
| N1 | `flow-validation.ts` over 1,500 lines | Fixed | split into `flow-structure-validation.ts` |
| N2 | Hot spots | Not a defect | churn metric; the payload split is S12 |
| N3 | Process vocabulary in product code | Batch 2 | |
| N4 | Measurement hook in the request path | Not a defect | kept on purpose |
| N5 | Business names in the connection catalogue | Batch 2 | |
| N6 | Two address writers on the application page | Fixed f7c985ab | documented in `page-address.ts` |
| D1-D7 | Rule documents contradicting the code | Fixed ec2427bd | AGENTS.md, target architecture, grid core design, build-plan index; historical documents removed |

## Issues

| Issue | Status | Change |
|---|---|---|
| #3562 requester group chooser | Fixed 5fb7f904, c51ba93c, 3068b157 | names-only group read for choosers (20261025193000); chooser shows records as they arrive. Walked: the requester sees only the groups they may name |
| #3563 relabel refused at upgrade | Fixed 6a155da6 | storage meaning follows publication (20261025194000). Walked: relabel published 1.0.1 and upgraded |
| #3582 filterable link refused at upgrade | Fixed 6a155da6 | as above. Walked: filtering off (2.0.0) and on (2.1.0) both upgrade, records intact |
| #3581 Studio duplicate input, Board, Auto-size | Fixed 505564ab, 644f724c, f502e5d6 | duplicate disabled on field inputs, scoped block error, publication refuses a field shown twice, Board starts on a stage field, Studio names why a draft cannot run. Walked |
| #3549 T116 default-view provenance | Fixed e694621f, 33c7f9ce | `based_on_default_view_id` (20261025195000) |
| #3539 T146 chart link group | Fixed a4f7a5b7, 374e2c30 | |
| #3540 T104 block setup values | Fixed 78201ab4 | |
| #3541 T056 agent preview | Fixed 07f929c3 | |
| #3548 dependency release | Batch 2 | |
| #3578 wheel scrolling below 60 fps | Fixed 4cc9af13 | direct DOM updates and no hover while scrolling: 48 to 59.6 fps under the same load; gated re-measure belongs to G8 |

## Defects found while walking

| Defect | Status | Change |
|---|---|---|
| Changing a platform operation left installed apps' controls "Unavailable", and publishing answered "no change" | Fixed 3d48b6a9 | publication compares the latest release's platform operation and connection pins and releases again |
| Every application page had two `main` landmarks: the shell's and the Container's content region | Fixed (RV-3584 batch) | the shell draws the one `main`; the Container's `content_landmark` setting is removed from the catalogue, shipped definitions and Studio's shell command |
| Development setup refused the IAM upgrade (role revision not accepted) | Fixed 087579e9 | setup accepts shipped role revisions |

## UI review findings (ARCH part and those fixed before the split)

| Id | Status | Change |
|---|---|---|
| UI-01 registration dead on a fresh setup | Fixed d304960f | setup publishes the privacy notice through the operator (20261026100000); pages tell "not published" from a failure |
| UI-02 deep link signed out | Fixed 3a9bd63c | plain sign-in that returns to the page and record |
| UI-03 nested tile buttons | Fixed 0fa404d6 | |
| UI-04, UI-07, UI-47 shell | Fixed 345bc432 | skip link, one h1, one organisation switch |
| UI-08 developer copy (core apps) | Fixed eba3c05f | |
| UI-11 form error summary and focus | Fixed 7689c502 | |
| UI-12 file field | Fixed c96e4b0c | |
| UI-13 picker texts | Fixed 6a676f4c | reference data part: FIX-R removes the application |
| UI-15, UI-52 save confirmation | Fixed fd3b6e51 | |
| UI-16 stage choices and single refusal | Fixed 7689c502 | |
| UI-22 grid address names | Batch 2 | |
| UI-27 additive changes published as majors | Fixed dafd856e, e86acdb1 | |
| UI-34 App Store dialogs and role summary | Fixed c8e639ac, 136a218f, 703cb920 | per-row text action: FIX-C (grid row actions) |
| UI-35 step-up sign-in | Fixed 3a9bd63c | |
| UI-41 Puck `setData` on every edit | Fixed 74cf1cd0 | |
| UI-42 log noise | Fixed 0b0696b0 | |
| UI-43 invitation acceptance | Fixed f444f9a6 | Join from the organisation chooser (20261026110000) |
| UI-44 invitation duplicates | Fixed f444f9a6 | form part: FIX-D |
| UI-46 member with no applications | Launcher text fixed fe0b531d; server and address states Batch 2 | |
| UI-48 control border contrast | Fixed c5b891c3 | |
| UI-50 empty calendar | Fixed 0034b506 | |
| Other UI findings | FIX-A to FIX-E, FIX-R | `fix-split/partition.md` |

## Review of #3584 (RV-3584: 0 blocking, 9 should-fix, 26 nits)

All 35 are fixed on `arch-batch`; the database ones in migration 20261026120000. Walked on db3 `:3630` after setup republished the shipped applications: S4 (a second invitation is refused, one pending row), S7, S8 (summary first, focus on the first field), N11, N17 (one h1 and one `main` per page; Studio offers levels 2 to 4), N18 ("open for 11 more days"), N19 (joining a closed invitation says why), N20 (Escape keeps the dialog and says how to leave), N21, N22. Scripts and screenshots: `task-5/arch/walk/rv3584*.mjs`, `walk/out/rv-*.png`.

| Id | Change |
|---|---|
| S1 | A contributed field applies a later definition only after its column is checked and a retired field is active again |
| S2 | A unique field drops its sort index when it stops being sortable (walked in a rolled-back transaction: `ix_` gone, `ux_` kept) |
| S3 | The lifecycle entry refuses an offboarding transfer mutation (`command_invalid`); `transfer_offboarding_owned_record` is the one entry |
| S4 | Invitations of one email to one organisation are serialised with a transaction lock |
| S5 | Stale `storedInvitationSchema` and `StoredInvitation` removed |
| S6 | Text, Heading and Launcher pins changed: compiled releases using them are STALE-REBUILD; development and demo setup republish the shipped applications, and Studio-authored applications are republished (see the PR's deploy note) |
| S7 | Launcher `action_label` and `empty_message` are required with catalogue defaults; every placement states them; the renderer has no fallback wording |
| S8 | The form error summary is the form's first element in DOM and tab order |
| S9 | A Postgres missing privilege (`permission denied for ...`) is logged as an error and answered as temporarily unavailable; the access model's refusals stay information |
| N1 | Redundant `set local role vortex_request` removed |
| N2 | Records specification names the one activity appender |
| N3 | `transfer_offboarding_owned_record` no longer repeats the scope check |
| N4 | The envelope function's owner, revoke and comment live in its own file |
| N5 | Migration 189000's allowance reasons say the identities are read from 190000 |
| N6 | Not a defect (as the reviewer notes) |
| N7 | `removal-eligibility.ts` imports once and re-exports nothing |
| N8 | `Path` lives in the structure validator |
| N9 | Only the Data grid's `features` group is versioned feature by feature |
| N10 | A stale continuation and an input the page cannot run log as information |
| N11 | Roles and Groups and Assignments have their own intros |
| N12 | `not_runnable` is uninformative to the preview gate |
| N13 | A draft preview that cannot run says why and links to Studio |
| N14 | A missing session with stale cookies clears them, then shows plain sign-in |
| N15 | Studio derives field inputs from the releases |
| N16 | Doc comments sit on their functions |
| N17 | Headings offer levels 2 to 4; the page name is the one level-1 heading |
| N18 | An invitation says how many days it stays open, the same in every time zone |
| N19 | A join that does not happen says why; invitations that cannot be read never hide the person's organisations |
| N20 | Escape or an outside click keeps typed setup values and says how to leave |
| N21 | One notifications region for every page, so a toast survives opening another application |
| N22 | Labels keep acronyms inside sentences |
| N23 | A message task requires its title; shipped flows are titled; Studio seeds it from the flow's name |
| N24 | A field's focus goes to the control its label names |
| N25 | `next-env.d.ts` restored to main's |
| N26 | Dead prototype link removed |
