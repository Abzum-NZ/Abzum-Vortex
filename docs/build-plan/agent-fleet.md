# Fleet operations

Read [agent coordination](agent-coordination.md) first: it sets the roles, capacity targets, lifecycle and verification. This file holds the procedures:
- the main orchestrator (GPT-6 Sol, High);
- the planner (Claude Opus 5.5);
- GPT-6 Luna implementers and GPT-6 Sol reviewers (Extra High);
- the independent monitor.

Machine-specific paths (repository checkout, coordination folder, Orca executable, run id) live in the orchestrator's checkpoint, not here.

## Ready-work dispatch algorithm

1. **Resume.** On startup or resume:
   - read the checkpoint and the reconciliation journal;
   - compare them with live state: Orca workers and terminals, `git worktree list`, running `codex exec` processes, open PRs;
   - never duplicate a live or uncertain worker.
2. **Snapshot.** Refresh the roadmap Project snapshot (items, status, phase, native blockers, parents, Pickup Order) once per reporting interval and after structural changes. Between snapshots, update from event read-backs.
3. **Eligibility.** A leaf is eligible when its real native blockers are complete, it is bounded, its owning paths do not overlap an active editor, and capacity exists. Phase and Pickup Order only break ties, except that the current phase's blockers always go first.
4. **Fill review lanes first.** Every open PR without a reviewer gets one now, up to 10 concurrent.
5. **Merge what is ready.** A PR whose review, verification and preview have passed merges this cycle.
6. **Fill implementer lanes.** Dispatch eligible leaves until 6–8 Luna lanes run. Prefer leaves that do not depend on open PRs. Hand unclear or architectural leaves to the planner, and keep 2–3 shaped leaves ready.
7. **Shape** each picked leaf ([shape before dispatch](agent-coordination.md#shape-before-dispatch)). Work that is already implemented goes to a Sol source review and reconciliation, not reimplementation.
8. **Recompute after every event.** After any handoff, merge, closure, board write or cleanup, recompute eligibility and refill.

Never claim an empty queue while an eligible leaf or a free lane exists. A dependency cycle or contradictory dependency is a planning blocker to resolve with a recorded reason. Never delete a real dependency to make an issue Ready.

## Launching lanes

- **Codex lanes run headless:** `codex exec -m <model> -c model_reasoning_effort=<effort> -C <worktree> --add-dir <coordination folder> -o <final report> - < <brief>`. Run it inside an Orca terminal through the coordination launch scripts (`exec-launch.sh` / `exec-lane.sh`).
  - Implementers: `gpt-6-luna` at `xhigh`. Reviewers: `gpt-6-sol` at `xhigh`.
  - Never start interactive daemon-backed Codex terminals for lanes: on Windows they open a console window per command on the owner's desktop.
- **Planner lanes:** Claude Opus 5.5 at High effort, for shaping and design only. They write issue text, comments or design records, never code.
- **Start immediately.** A lane never waits for a heavy lock before starting. It requests the lock only when it reaches a heavy step.
- **Confirm it started.** After launch, confirm the process is running and the log is growing. Record the actual model and effort from the session header, not the planned label.
- **Refused commands.** Codex may refuse some commands "by policy" (lock-file writes, `gh pr create`, deletes). Read every final report the same cycle. The orchestrator performs any refused step itself; lanes never try to work around it.
- **Overflow.** Overflow models (Space Bunny, DeepSeek Flash, Sonnet 5 High) launch through Orca's normal agent launcher when Codex capacity is short. Confirm the actual model and turn start.

## Branches, worktrees and migrations

- **Worktrees and branches:**
  - one issue, one worktree, one editor at a time;
  - create from `origin/main` with `git worktree add --no-track -b abzum-admin/<issue>-<agent>-<slug> <path> origin/main`;
  - reviewers work in `<same name>-2` checkouts of the PR branch.
- **Pushing.** Push only with an explicit refspec: `git push origin HEAD:refs/heads/<branch>`. A branch must never track `origin/main`; check with `git rev-parse --abbrev-ref @{u}`. Main is protected for everyone, including administrators.
- **Up-to-date rule.** Main requires branches to be up to date before merging. Merge PRs in queue order, and merge `origin/main` into the next PR right after each merge.
- **Migrations.**
  - Before dispatch, compute the next free migration number from `git ls-tree --name-only origin/main supabase/migrations`, and reserve a range for the issue in the checkpoint.
  - Every lane, including the monitor's own lanes, takes its numbers from the orchestrator.
  - A migration that sorts before an existing one on main is renumbered before merge.

## Heavy checks and locks

Heavy checks are typecheck, web build and database replay. Two slots:
- `heavy.lock` is for any heavy check;
- `heavy.lock2` is for typecheck and build only.

Rules:
- At most one database replay runs at a time across both slots.
- Do not start a heavy check when less than 3 GB of memory is free; wait and retry.
- The orchestrator holds a lock on a lane's behalf, because Codex refuses lane lock writes. It writes `<issue>-<kind> <UTC>` and releases the lock the moment the command finishes.
- A lane that exits releases any lock naming it.
- A lock older than 25 minutes whose owner has exited is stale: the orchestrator clears it.
- The live order is `heavy-queue.txt` in the coordination folder, kept current by the orchestrator. The current phase's blockers go first.
- When a reservation (for example the monitor's phase walkthrough) lifts, every lane that exited because of it is re-dispatched within one cycle.

## Preview checks and smoke (monitor)

- **Shared preview stack.** The monitor owns the shared local Supabase preview stack. No other agent resets or writes to it.
- **Preview checks run automatically.** The monitor's preview watcher runs a fresh `db reset` plus `setup:local` on a PR's exact head and posts `Fleet monitor preview-stack check of head <sha>: PASS/FAIL` on the PR, usually within 10 minutes. It picks up:
  - any PR comment asking the monitor for a preview or `db:reset` check;
  - any PR number added to `preview-requests.txt` in the coordination folder.
- **A reviewer needing a preview** requests it and waits for that comment on its **current** head. There is no 30-minute timeout. A FAIL means do not merge.
- **Post-merge smoke.** After any merge that touches definitions, migrations or development setup, the watcher smoke-tests main and messages the orchestrator. A FAIL on main is fixed before further merges of that kind.
- **Phase walkthrough.** When the orchestrator reports "Phase N re-check ready", it pauses launches. The monitor walks the phase acceptance in a browser and hands the owner the link only after it passes.

## Metadata

Each leaf title starts `#<issue>`. The issue carries the phase label, numeric Pickup Order, and these sections:
- Summary
- Already built
- Remaining work
- Scope boundaries
- Acceptance criteria
- specification references
- Blocked by and Blocks

No test instructions or proof checklists.

The orchestrator records the rest in the checkpoint and on the board:
- planned and actual agent and effort;
- implementation and review estimates in active minutes;
- worktree, branch and terminal;
- UTC start and finish;
- PR, reviewed and merged commits;
- current blocker.

Parent estimates total their children.

## Board reconciliation

The orchestrator is the only board writer. At every event it writes the affected row, reads it back, and logs a line in `board-reconciliation.jsonl` (issue, intended fields, source commit or PR, UTC, pending or done):

| Event | Board row |
| --- | --- |
| Leaf shaped and dependency-ready | Ready, planned agent and estimate |
| Lane actually started | In progress, actual agent, start time |
| PR opened | In review, substate "awaiting reviewer" |
| Reviewer started, fixing, verifying | In review with the substate |
| Blocked, failed or reassigned | Truthful status, exact reason, next action; dead owner cleared |
| Merged and closed | Done, finish time; dependents unblocked; parents rolled up |

**Hourly reconciliation:** compare every row with issue state, open PRs and running lanes, and fix drift. Examples: an open issue showing Done; a closed issue not showing Done; an issue with an open PR showing Backlog; In progress with no running lane.

**GitHub API budget.** Project reads and writes share one GraphQL point budget across all clients.
- Trust the live `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers and the `errors` array of real GraphQL responses, not cached rate-limit figures.
- Keep a cache of issue-to-item, field and option IDs. Write only changed fields, Status first, batched, with one read-back.
- Split complete refreshes into a slim item inventory and a separate native-relationship pass. Never nest wide connections under every item.
- Reserve one fifth of the hourly budget for live transitions.
- On exhaustion, keep pending writes in the journal and retry after the reset. Honour `Retry-After` on secondary limits.
- Report progress as STALE with its cause while a source is unavailable.

## Stall recovery

| Observation | Action |
| --- | --- |
| Lane asks a scope question | Answer in the issue or PR within one cycle; the lane re-reads before its next step |
| Lane stops on a real design gap | Hand to the planner for options; the owner (or the monitor as delegate) decides; relaunch with the decision |
| No useful progress for 15 minutes | Inspect the log and worktree; ask one bounded question if unclear |
| Lane exited without a PR or report | Read its final report; preserve work; relaunch once or reassign |
| Lane's command refused "by policy" | The orchestrator performs the step (lock write, PR creation, cleanup) |
| Provider capacity or rate-limit response | Retry the same session a few times about 20 seconds apart; after repeated confirmed failures, preserve work and reassign |
| Reviewer finds defects | Reviewer fixes and re-reviews itself |
| Merge rejected: branch not up to date | Merge `origin/main`, re-check what changed, retry |
| Preview check FAIL | Do not merge; fix on the PR; the watcher re-checks the new head |
| Real permission or protection rejection | Report the exact rule and supported resolution; no retry loop or bypass |
| Orchestrator's own session or usage limit approaching | Write resume steps into the checkpoint, notify the owner with the reset time, hand over through the run mailbox |

## Orca lifecycle and cleanup

- **Orca.** Use the installed Orca CLI and its version-matched skills (`orca skills get orchestration`, `orca skills get orca-cli`). Bind one coordinator run. Talk to agents through the run mailbox (`orca orchestration send/check/inbox`). A native agent chat is not a shell terminal.
- **Merged and closed issue.** Every merged-and-closed issue enters the cleanup ledger immediately. For each worktree:
  1. confirm no live agent or terminal is using it;
  2. confirm there are no tracked, untracked or unpushed changes that exist only there (clean git status alone is not enough);
  3. close its terminals;
  4. remove it with `orca worktree rm --force` (or `git worktree remove` for a verified Git-only orphan);
  5. confirm it is gone from both inventories.
- **Implementer worktree.** Remove it as soon as its reviewer's `-2` checkout exists and the work is pushed.
- **Uncertain worktrees.** A worktree with uncertain or unique work stays, with its owner, reason and next action recorded.
- **Never** recursively delete by path, remove the primary checkout, or touch local or remote main as cleanup.
- **Every cycle,** any worktree without a running agent and without a recorded blocked-by reason is either given an agent or removed.
- **Terminals:** keep Orca under 25.

## Implementer brief

```text
Issue #<n>; phase <n>; pickup <n>. GPT-6 Luna (Codex, xhigh), headless.
Read AGENTS.md, docs/build-plan/agent-coordination.md, the full issue and comments, linked spec and current source.
Outcome: <plain functionality>. Already built: <source facts>.
Build: <bounded change>. Owning paths: <paths>. Exclude: <non-goals>.
Dependencies (complete): <list>. Acceptance: <inspectable behaviour>.
Worktree/branch: <path> / abzum-admin/<n>-luna-<slug> (created --no-track). Migration numbers: <range or none>.
If you touch modules/src, run the definition validator (and fix every failure) before committing.
Do NOT run heavy checks (typecheck, build, replay): the reviewer runs them.
Commit, push ONLY with: git push origin HEAD:refs/heads/<branch>. Never push to main. Open the PR titled "#<n> - <title>".
English only. No tests or test edits. No board writes, merges or issue closure.
Final report: PR, candidate commit, acceptance mapping, limitations, and the exact verification the reviewer must run.
If a real scope or design question blocks you: comment it on the issue, report it, and stop without a partial PR.
```

## Reviewer brief

```text
You are the independent GPT-6 Sol (Codex, xhigh) review-and-fix owner of #<n>, PR #<pr>, headless.
Checkout: <path>-2 on the PR branch. The implementer has stopped.
Read the complete live issue, every comment, the linked spec, then the whole diff, current main and affected callers.
Fix your findings yourself, commit, and re-review the final source.
Check the diff, commits, PR text and your comments for non-English text and replace it.
Verify the exact final head as agent-coordination.md "Verification before merge" requires:
  scoped typecheck; web build if web/ui/runtime imports changed; disposable replay if supabase/ changed;
  definition validator + publication compile if definitions changed;
  monitor preview check PASS on the exact head if definitions, migrations or development setup changed
  (request it on the PR or in preview-requests.txt, then wait for the monitor's comment on your head).
Heavy checks: ask the orchestrator for the lock (it holds it for you); run only when told; report results at once.
Merge origin/main into the branch (required: up to date), re-check what changed, push with an explicit refspec, merge the PR.
Post your verdict on the PR before merging. After merge: update the issue with the delivered outcome and close it.
Send one completion report: issue, PR, final reviewed commit, merge commit, checks run and results, fixes made, limitations.
If blocked (failed check, product question, refused command): post the exact cause on the PR, report it, and stop without merging.
```

## Checkpoint and reports

The orchestrator keeps `checkpoint.md` and the reconciliation journal in the coordination folder, outside worktrees, and reads them on every resume. The checkpoint holds facts, not policy:
- UTC time, run and coordinator identity;
- every running lane (issue, role, actual model, worktree, terminal, stage, elapsed and estimate);
- open PRs and their review, verification and preview state;
- lock and queue state;
- migration reservations;
- pending board writes;
- the cleanup ledger;
- blockers with resume conditions;
- the next shaped leaves.

Update it at every completed step and at least every 20 minutes.

Reports to the owner use the owner's four-table format:
1. tasks with evidence;
2. capacity and board, listing every running agent and every idle lane with its reason;
3. progress and operations, including throughput (merges per hour, median PR open-to-merge, open PRs) and the phase percentage from merged and closed facts;
4. coordination issues with cause, correction and prevention.

Never infer progress from lane claims or a partial board read.

## Monitor

The monitor is independent: it verifies facts, runs the preview watcher and phase walkthroughs, checks throughput every 20 minutes (`monitor-throughput.py`), and sends the orchestrator one correction per issue with a prevention step. A flag that repeats in two consecutive checks goes to the owner. It never dispatches or merges. It writes the board only when the owner asks for a reconciliation.
