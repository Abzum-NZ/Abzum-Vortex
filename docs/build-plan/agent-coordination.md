# Agent coordination

Effective 27 September 2026. This is the authoritative development workflow. [Fleet operations](agent-fleet.md) has the procedures, launch mechanics, templates and scripts. The [roadmap](README.md) defines the phases. The latest direct instruction from the owner takes precedence over both.

## Objective

Build the roadmap outcome from dependency-ready, bounded work. By the end of Phase 6, an authorized user can sign in and use installed applications whose navigation, pages, records, forms, actions and theme come from definitions. A static mockup, or source that only type-checks, does not meet this objective. Phase labels are planning and reporting metadata, not dispatch gates.

## Roles and ownership

| Role | Model | Owns | Never |
| --- | --- | --- | --- |
| **Main orchestrator** (one session) | GPT-6 Sol (Codex), **High** effort | Readiness, shaping and routing, dispatch, the heavy-run queue, merges of verified PRs when a reviewer cannot, **every board write**, agent lifecycle, cleanup, checkpoint, progress reports | Product implementation |
| **Planner** (on request) | Claude Opus 5.5, High effort | Shaping large or unclear issues, architecture options, design records, split proposals | Coordination, dispatch, merges, board writes, implementation |
| **Implementer** | GPT-6 Luna (Codex), **Extra High** effort | One bounded issue in its own worktree: implementation commit, pushed branch, PR and handoff report | Heavy checks, merges, issue closure, board writes, other issues |
| **Reviewer and fixer** | GPT-6 Sol (Codex), **Extra High** effort, a different session from the implementer | Independent review, fixing its own findings, re-review, verification before merge, merge, issue update and closure | Other issues, board writes, sending ordinary fixes back to the implementer |
| **Monitor** (independent) | Claude, separate session | Preview-stack checks and post-merge smoke, the phase walkthrough, throughput and drift checks, corrections to the orchestrator, reports to the owner | Dispatch, merges, board writes (except an owner-requested reconciliation) |

Overflow when Codex capacity is short: OpenCode Space Bunny, DeepSeek 4.1 Flash (`deepseek/deepseek-flash`, when funded) or Claude Sonnet 5 High implement; Claude Opus 5.5 (Medium) reviews. Never DeepSeek Pro. Never use GPT-6 Sol or Opus 5.5 for routine implementation.

## Capacity targets

- **Implementers:** 6–8 active Luna lanes, up to 12 when enough bounded, non-overlapping, dependency-ready leaves exist. Leaves come from any phase; a wait on one PR must not idle lanes that could take independent work.
- **Reviewers:** up to **10** concurrent Sol review-and-fix lanes. When the review queue is longer than the free review lanes, open review lanes before new implementer lanes.
- **Heavy checks:** two slots (typecheck and build on either; database replays on one at a time), under the memory floor in [fleet operations](agent-fleet.md#heavy-checks-and-locks).
- **Service levels:**
  - a reviewer starts within **10 minutes** of a PR opening;
  - a merge follows within **one cycle** of review, verification and preview all passing;
  - a finished lane is refilled within one cycle;
  - 2–3 shaped leaves are kept ready at all times.

## Required lifecycle

1. **Pick:** scan unfinished leaves across all phases for real dependency readiness and non-overlapping owning paths. Prefer the current phase's blockers first, then lower Pickup Order. Fill every free lane.
2. **Shape:** make the issue clear and bounded before dispatch ([shape before dispatch](#shape-before-dispatch)). Hand large, unclear or architectural issues to the planner first.
3. **Assign:** create an isolated worktree from `origin/main` with `--no-track`. Assign the migration number range from `origin/main` if one is needed. Launch the lane headless. Record the actual model, worktree, branch, terminal and start time, and write the board row.
4. **Implement:** the implementer changes only the agreed owning paths, runs the definition validator when it touches application definitions, commits, pushes its branch with an explicit refspec, opens the PR and reports. It runs no heavy checks.
5. **Review and fix:** in the same cycle, a fresh Sol reviewer reads the complete issue, every comment, the linked specification, the whole diff, current main and affected callers. It fixes its own findings and re-reviews the final source. Missing product decisions go to the orchestrator, which answers **in the issue or PR** (the owner decides real product questions). After asking, the lane re-reads the issue or PR before its next step.
6. **Verify:** the reviewer runs [verification before merge](#verification-before-merge) on the final head.
7. **Merge and close:** the reviewer updates the branch from main (the branch must be up to date), merges, updates the issue with the delivered outcome and closes it, then sends one completion report. If the merge fails because main moved, it merges main again, re-checks anything the merge changed, and retries.
8. **Reconcile, refill and clean:**
   - write the board row and read it back;
   - unblock dependents and roll up parents;
   - release both agents and close their terminals;
   - remove the finished worktrees safely;
   - refill every free lane;
   - update the checkpoint.

## Verification before merge

Verification is proportional to what the PR changes, and the reviewer runs it on the exact final head.

| The PR changes | Required before merge |
| --- | --- |
| Any TypeScript | Scoped typecheck: `pnpm -r --no-bail --filter "...[origin/main]" typecheck` (changed packages plus dependents). Full workspace typecheck instead when the PR removes types, reasons or exports, or changes `contracts/`. |
| `apps/web`, `ui` or runtime packages the web app imports | `pnpm --filter @vortex/web build` |
| `supabase/migrations` or `supabase/schemas` | Disposable database replay (as the non-superuser `postgres` role, like `supabase db reset`) |
| `modules/src/*/application.json` or module sources | Definition validator plus the offline publication compile, and a check that every create form plus its flow supplies every required field |
| Definitions, migrations or `apps/web/scripts/development-setup` | **Monitor preview check PASS** on the exact head: fresh `db reset` plus `setup:local` on the shared preview stack. Request it and wait for the monitor's PR comment. |

After every merge batch the orchestrator runs the full workspace typecheck on main. The monitor smoke-tests main after every merge that touches definitions, migrations or development setup. A failure on main stops further merges of that kind until it is fixed.

Still forbidden: creating, editing or running tests; hosted verification; Kestra runs; deployment to Testing or Production; new lint or deployment gates.

**Phase ready:** a phase is ready only after the monitor's end-to-end walkthrough of its acceptance passes. For Phase 6 that is: sign in; every installed application opens; create, open and edit a record; run a declared action; see the application's theme; no sign-in loop. The phase epic closes only then.

## Shape before dispatch

Before dispatch the orchestrator reads the complete issue, every comment, the linked specification and the current source, then makes sure the issue states, in plain language:

- **Summary:** the outcome: what a person can do, or is protected from, when the work is done.
- **Already built:** what exists today, with file references.
- **Remaining work:** numbered, concrete changes.
- **Scope boundaries:** the owning paths the implementer may change, and what it must not touch.
- **Acceptance criteria:** behaviour visible in the code that shows the work is complete.
- **Blocked by and Blocks:** matching native GitHub dependencies.

The orchestrator also **verifies the premise against the code**:
- the files, contracts and paths the issue relies on exist;
- the authority and actor model is stated;
- required fields and forms line up;
- every real dependency is a native blocked-by edge.

When a lane stops on a scope question, the fix is in the issue text as well as the answer, so the next reader has it.

An issue is bounded when one implementer can finish it in one session: one outcome, one set of owning paths, an estimate of no more than 180 active minutes. Larger or mixed issues are split before dispatch into sub-issues in the [standard issue format](agent-fleet.md#metadata), each with its own outcome, paths, acceptance and estimate. Each gets a Pickup Order right after the original's and native dependencies where order matters. Parents and phase epics are rollups, never implementation tasks.

## No-choke-point rules

1. **Review starts at handoff.** A PR without a reviewer for more than 10 minutes is drift.
2. **Merges are not left waiting.** A PR that has passed review, verification and preview merges in the next cycle.
3. **No stall on one provider.** A capacity limit on one provider moves new work to the overflow models; it never stops the fleet.
4. **Mail every cycle.** The orchestrator reads its Orca mailbox between steps (at least every 10 minutes) and replies to every monitor message. Mail unprocessed for more than one cycle is drift.
5. **Checkpoint and continuity.** The checkpoint is updated at every completed step and at least every 20 minutes, so another session can take over. Before a known session or usage limit stops the orchestrator, it writes the resume steps into the checkpoint and notifies the owner with the reset time.
6. **One board writer.** The orchestrator writes every board row at every transition, reads it back, and reconciles the whole board at least hourly. An open issue never shows Done, and a closed issue never shows anything but Done or Not planned.
7. **Stalls are visible.** No orchestrator progress for 30 minutes with work pending is escalated by the monitor to the owner.
8. **No stale branches, worktrees or terminals.**
   - A remote branch exists only for an open PR or a running lane, and a worktree only for a running lane or an issue with a recorded blocked-by reason.
   - The implementer's worktree is removed once its reviewer's checkout exists and the work is pushed.
   - Terminals of settled lanes are closed, keeping Orca under 25 terminals.
   - `main` and `testing` are never deleted.

## Status meanings

| Status | Fact required |
| --- | --- |
| Backlog | Not picked up, or a prerequisite is unresolved |
| Ready | Bounded and dependency-ready; no agent yet |
| In progress | A named implementer has actually started |
| In review | A PR exists; the reviewer is queued, reviewing, fixing, verifying or blocked (name the substate) |
| Done | Reviewed, verified, merged, issue closed, row read back |
| Not planned | Explicitly cancelled scope |

A blocker keeps the issue in its truthful status with the exact reason and next action; it never idles unrelated work.

## Boundaries

This is a new application. Correct obsolete contracts and their callers together; do not keep V1/V2 adapters or invent compatibility requirements. No new record-writer variants or effect kinds: a record write uses the single [record-change](../specification/06-records-and-lifecycle.md#record-change-command) engine, and a needed change extends that command.

Respect real repository protections and tool-approval controls. When one rejects an operation, report the exact action, source and supported resolution. Do not disable controls, disguise commands, retry an unchanged denial or switch executors to get around it.

## Instruction precedence

Latest owner instruction, then this file, then [fleet operations](agent-fleet.md), then the bounded issue and specification, then the lane brief. Product specifications define functionality, not fleet procedure. Old comments, runbooks and archived prompts are history, not policy. Checkpoints record facts, not policy.
