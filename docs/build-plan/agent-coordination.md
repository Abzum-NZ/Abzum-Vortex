# Agent coordination

Effective 29 September 2026. This is the authoritative development workflow for the Vortex roadmap. [Fleet operations](agent-fleet.md) gives the operating procedure; the [roadmap](README.md) defines phases. The latest direct owner instruction takes precedence over these documents. The owner authorizes bounded Orca-hosted Codex Luna Extra High, Antigravity Gemini 3.8 Flash, OpenCode Kimi K3 and OpenCode Space Bunny workers under this same Desktop lead. Authorization is not proof that a provider, model, effort, permission or worker session is available; verify each before counting or dispatching it.

## Objective

Build the roadmap outcome from dependency-ready, bounded work. By the end of Phase 6, an authorized user can sign in and use installed applications whose navigation, pages, records, forms, actions and theme come from definitions. A static mockup, or source that only type-checks, does not meet this objective. Phase labels are planning and reporting metadata, not dispatch gates.

## Control plane, roles and ownership

Codex Desktop is the control plane. The lead uses native Codex subagents first and may use bounded workers from the owner-authorized provider pool when useful work and verified capacity allow. Codex lanes run headlessly (`codex exec`), not in interactive daemon-backed Codex terminals. Deterministic local helpers may persist evidence, cache data, format status and run requested checks; they do not choose priorities, dispatch agents or form a second scheduler or agent fleet.

| Role | Model and effort | Owns | Boundaries |
| --- | --- | --- | --- |
| Lead | GPT-6 Sol, High | Readiness, scope, priority, dispatch, migration allocation, shared checkpoint and journal, every Project-field write, final merge decisions, cleanup decisions and owner reports | Does not implement product changes in parallel with an assigned editor |
| Read-only helper | GPT-6 Luna, Extra High, or a verified owner-authorized provider when delegation saves work | Bounded inventories, source summaries and backlog hygiene with evidence | No edits, board writes or completion claims based only on summaries |
| Implementer | GPT-6 Luna, Extra High, or a verified owner-authorized bounded external worker | One bounded issue in its lead-assigned isolated managed worktree; implementation, self-review and handoff evidence | No Project-field writes or merges; no work outside assigned paths; external self-review never replaces independent Sol review |
| Reviewer and fixer | Fresh independent GPT-6 Sol, High for ordinary bounded review; Extra High for sensitive or cross-layer work | Review the full change, fix findings in its own isolated worktree, re-review and return verification evidence | Must be a different session from the implementer; no Project-field writes or merges |
| Planner | GPT-6 Sol, High or Extra High | Difficult cross-layer design analysis and issue shaping | Bounded planning only; no implementation or board writes |
| Independent monitor | GPT-6 Sol, High; use the Luna read-only helper role for inventory | Independent preview evidence and phase acceptance | Created only when needed; no dispatch, board writes or merges |
| Exceptional design consultation | GPT-6 Astra, High | A specific unresolved design question when Sol analysis is insufficient | Optional and exceptional, not routine implementation |

The lead is the sole Project-board writer and merge owner. Workers return evidence to the lead. The lead alone updates Project fields, closes issues and merges PRs. Reviewers may fix their own findings, but their verdict and check evidence go to the lead for the merge decision. Product decisions remain recorded on the issue or PR.

Keep Luna at Extra High for implementation, self-review and corrections. External model and effort selection must match verified runtime availability and the bounded task; a configured model, catalog entry or accepted startup request does not prove the worker ran. Do not silently substitute a lower effort or different model for the owner's request. Use Sol Extra High for privilege, authentication, SQL ownership, tenant boundaries, transactions, architecture or unresolved cross-layer failures. Ordinary Sol High review is a five-candidate routing pilot, not a weaker review gate; after those candidates, compare review corrections and acceptance outcomes before continuing or changing the routing. A handoff records the actual runtime model and effort. Every implementer completes the [self-review packet](agent-fleet.md#worker-handoffs) before the lead assigns independent Sol review.

Target five productive subagents in addition to the lead, native first, then the owner-authorized provider pool after verifying its permissions and actual runtime. Five is not a hard ceiling: add useful bounded workers only when qualified disjoint work, independent Sol review throughput and measured memory allow. The documented native child-thread setting excludes the lead; a saved value does not establish live capacity. Maintain a timestamped roster of actual running, completed, blocked and unknown workers, including exact provider/session/process ownership. Refill useful bounded work on a completion event in the same active turn; do not spend model tokens keeping empty slots busy. Preserve independent Sol review capacity when candidates are ready, with Extra High for sensitive work. Favor current-phase blockers, recover existing candidates, and use idle implementation capacity for dependency/scope/ownership qualification when no leaf is Ready. A fully gated merge is immediate lead work; external waits must not stall independent qualified leaves. Verification uses isolated worktrees and disposable databases in parallel when measured capacity allows; only the shared preview stack and its fixed ports need resource-scoped ownership. See [verification concurrency](agent-fleet.md#verification-concurrency).

Every child needs a lead-assigned isolated managed worktree before editing. A child does not automatically have a private checkout or durable background execution. The lead confirms the checkout, branch, owning paths and active editor before work starts. One issue has one editor at a time.

## Required lifecycle

1. **Resume and reconcile:** read the checkpoint and append-only journal; compare them with native agent status, processes, managed worktrees, open PRs, board state, locks and pending writes. Investigate uncertain workers before dispatching duplicate work.
2. **Choose and shape:** maintain a small verified pickup ledger of two or three shaped leaves. At each active transition, refresh changed issue dependencies and comments, compare text blockers with native edges, and confirm current source and exclusive owning paths. Prefer blockers in the current phase, then Pickup Order. An idle implementer slot with a verified leaf is dispatched in the same active turn; if none qualifies, shape the highest-value Backlog candidate and record its missing prerequisite. Send an unclear or cross-layer design question to a bounded Sol planning session.
3. **Assign:** create or select a lead-owned isolated managed worktree from current `origin/main` with a non-tracking branch. Reserve migration numbers in the checkpoint when needed. Record the assigned session, actual model and effort, worktree, branch, issue, scope and start time.
4. **Implement:** the assigned implementer edits only assigned paths, runs the definition validator when application definitions change, performs a focused self-review of the final diff and affected callers, fixes its findings, then commits and returns the complete handoff packet. It may push an explicit branch ref and open a PR when assigned. It does not run heavy checks, write Project fields, close issues or merge. The lead returns an incomplete packet to the same implementer session before booking independent Sol review.
5. **Review and fix:** after implementation has stopped, a fresh Sol session reads the live issue and all comments, linked specification, whole diff, current main and affected callers. It reviews and fixes its own findings in a separate assigned worktree, re-reviews the resulting source and returns one exact-head evidence packet to the lead. Reuse that reviewer for subsequent product acceptance only if it did not author or fix the product candidate under verification; otherwise assign a separate independent preview owner.
6. **Verify:** obtain every applicable check in [Verification before merge](#verification-before-merge) against the complete final commit. Preview and browser evidence must name that full commit SHA.
7. **Merge and close:** as soon as one exact-head review, check and preview packet is complete, the lead executes the merge decision in the same active turn. It re-reads PR head, base, review and required checks, then merges only the reviewed, verified head through normal protected PR merging. Classify a failure as changed head or base, missing review or verification, conflict, protection, or integration access, with an owner and next action. Update a changed candidate, inspect the merge and repeat affected gates. A real integration 403 is not retried through another identity or executor. The lead updates the issue and board after merge.
8. **Reconcile and preserve:** the lead writes and reads back the Project row, unblocks dependents, rolls up parents, updates the checkpoint, and releases only settled worktrees after confirming unique work is preserved. A blocked child releases capacity after its work is preserved; the lead refills that capacity with unrelated eligible work in the same active turn.

## Verification before merge

Verification is proportional to the change and must run against the exact final head.

| The PR changes | Required before merge |
| --- | --- |
| Any TypeScript | Scoped typecheck: `pnpm -r --no-bail --filter "...[origin/main]" typecheck` (changed packages plus dependents). Use full workspace typecheck instead if the PR removes types, reasons or exports, or changes `contracts/`. |
| `apps/web`, `ui` or runtime packages imported by the web app | `pnpm --filter @vortex/web build` |
| `supabase/migrations` or `supabase/schemas` | Disposable database replay as the non-superuser `postgres` role, like `supabase db reset` |
| `modules/src/*/application.json` or module sources | Definition validator, offline publication compile, and check that every create form and its flow supplies every required field |
| Definitions, migrations or `apps/web/scripts/development-setup` | Independent local preview check PASS on the exact head: fresh `db reset` plus `setup:local` on the shared preview stack |
| Pages, forms or definitions (`apps/web/`, `ui/`, `modules/src/`, `runtime/page|app|record|query|access/`, `contracts/src/`) | Independent browser smoke PASS on the exact head. After the preview reset, headless Edge signs in, opens the CRM Companies list, opens New company and saves. Record the complete head SHA and result. |

Only one owner controls the shared local preview stack; never run concurrent resets. A skipped, failed or stale check is not PASS. The lead verifies every applicable result against the final head before merging. Do not assume GitHub protection enforces a check until its current settings are read back; a posted status alone does not prove the check ran. After every merge batch, the lead runs the full workspace typecheck on main. After a merge touching definitions, migrations or development setup, independently smoke-test main. A main failure holds further merges of that kind until a corrective PR is verified.

Still forbidden: creating, editing or running tests; hosted verification; Kestra runs; deployment to Testing or Production; new lint or deployment gates.

A phase is ready only after an independent end-to-end walkthrough passes. Phase 6 acceptance is: sign in; every installed application opens; create, open and edit a record; run a declared action; see the application's theme; and no sign-in loop. The phase epic closes only then.

## Shape before dispatch

Before dispatch, the lead reads the complete issue, every comment, linked specification and relevant source. The issue must state in plain language:

- **Summary:** what a person can do, or is protected from, when the work is done.
- **Already built:** what exists today, with source references.
- **Remaining work:** numbered, concrete changes.
- **Scope boundaries:** owning paths the implementer may change and explicit exclusions.
- **Acceptance criteria:** inspectable behavior showing completion.
- **Blocked by and Blocks:** matching native GitHub dependencies.

The lead verifies that referenced files, contracts and paths exist; the authority and actor model is clear; required fields and forms line up; and every real dependency has a native blocked-by edge. If an agent raises a scope question, update the issue with the answer so the next reader sees it. Product decisions are made by the owner or an explicitly delegated decision-maker.

An issue is bounded when one implementer can finish one outcome, one owning-path set and acceptance in one session, estimated at no more than 180 active minutes. Split larger or mixed work into sub-issues in the [standard issue format](agent-fleet.md#issue-metadata), each with its own outcome, paths, acceptance and estimate. Set dependencies where order matters. Parents and phase epics are rollups, never implementation tasks. Their Project status reflects child completion and independent phase acceptance, not a worker's In progress, In review or blocked stage.

## Board, continuity and rate limits

Use the existing statuses Backlog, Ready, In progress, In review, Done and Not planned. Checks, fixes, preview, a reviewed local branch without a PR, and merge-ready are substates evidenced in the checkpoint and available issue or PR fields. An implementation leaf is Done only after its PR merges, its issue closes and the board read-back succeeds; a local candidate cannot be Done. A parent or phase rollup need not have its own PR: it is Done only after required children are delivered, independent phase acceptance passes when applicable, its issue closes and the board read-back succeeds. An open issue is never Done; a closed issue is Done or Not planned. A blocker retains the truthful status, exact reason and next action. A pending board write makes board progress STALE in reports. Treat a human board edit as an intended change to reconcile against live issue and PR evidence; never overwrite it blindly.

Every noticed operational or product failure gets a bounded recurrence record: observed symptom, proven cause or explicit hypothesis, correction, durable prevention in the smallest relevant procedure or helper, independent read-back and the next relevant recheck. Repeated failure calls for fresh diagnosis and one owner escalation, not unchanged retries. Preserve the original failure evidence and do not call a diagnostic run full acceptance.

The lead journals an intended board mutation before sending it, serializes mutations, writes only changed fields with Status first, and verifies the result with a targeted read-back. Cache Project item, field and option IDs and share the cache across work. Refresh affected active rows at transitions; take a slim, fully paginated Project snapshot about hourly when useful and after structural changes, subject to live budget. Refresh relationships separately. Refresh active PR facts in a conditional REST batch about every 60–90 seconds only while useful, then re-read the merge candidate immediately before merge. Do not fetch wide nested connections for every board item.

REST and GraphQL budgets are separate. Trust live response headers and GraphQL error arrays, including errors in HTTP-200 responses. Honor Retry-After, reset times, bounded backoff and jitter. Reserve one fifth of the hourly GraphQL budget for transitions. On exhaustion, journal pending writes, verify whether a mutation already succeeded before retrying, then retry after reset. Never rotate credentials to defeat limits. Unknown, partial or stale data never means an empty backlog, successful check, Done or permission to merge.

These cadences guide useful work; they are not promises of background timers. The local journal is the durable execution record, not a competing backlog. Write an event for state transitions and atomically replace checkpoint snapshots. Update the checkpoint after material transitions, periodically while active, and before session end. A Codex Desktop heartbeat may request reconciliation while the app runs; it is not a guaranteed timer or unattended fleet. The machine and app must be available. Shared account limits can pause all Codex models, and changing models is not guaranteed to restore capacity. Reports state the source and age of stale evidence.

Every direct owner question or request receives an explicit answer covering the result, checks performed, verified changes, pending items and any precise owner action. If work remains, name its owner and the evidence needed to finish it. Quiet-on-unchanged heartbeat guidance applies only to unsolicited monitoring; it never suppresses a direct reply.

## Boundaries

This is a new application. Correct obsolete contracts and their callers together; do not keep V1/V2 adapters or invent compatibility requirements. No new record-writer variants or effect kinds: a record write uses the single [record-change](../specification/06-records-and-lifecycle.md#record-change-command) engine, and a needed change extends that command.

Every database-function migration carries the complete canonical `create or replace function` body, comment and grants, with the canonical `supabase/schemas/<schema>/<function>.sql` changed in the same commit. A signature change is an explicit drop then create. Never inspect stored definitions with `pg_get_functiondef`, `prosrc` or `routine_definition`, or patch them with `replace()`. Migration numbers come from the lead and sort after every migration on `origin/main`.

Preserve tenant isolation, permissions, transactions, revisions, safe errors and explicit publication and installation. Never put business application names or special cases into generic engines or expose credentials. Preserve unique work before any cleanup. Never use a blind revert for a regression involving migrations or dependent changes; diagnose and prepare the smallest corrective PR.

Respect real repository protections and tool-approval controls. Report the exact rejected action, source and supported resolution. Do not disable controls, disguise commands, automatically retry the denied invocation unchanged or switch executors to get around it. A later specific owner instruction can authorize a fresh ordinary request through the same controls; record that authorization and stop if the new request is rejected. Provider capacity or rate limits are not denials: retry the same session a few times about 20 seconds apart before reassignment. Do not use hosted services for verification or deployment.

## Instruction precedence

Latest direct owner instruction, then this file, then [fleet operations](agent-fleet.md), then the bounded issue and specification, then the lane brief. Product specifications define functionality, not fleet procedure. Old comments, runbooks, checkpoints and archived prompts are history, not policy. Checkpoints record facts, not policy.
