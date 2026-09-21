# Agent fleet operation

The current GitHub issue is the implementation contract. This policy supersedes older fleet prompts, proof requirements and fixed Codex-only routing.

## Models and usage

| Work | Preferred implementation lane |
| --- | --- |
| Mechanical edits, explicit schemas, catalogues and small adapters | OpenCode GLM 5.3 Flash |
| Bounded UI components, pages, visual wiring and straightforward application code | Antigravity Gemini 3.8 Flash (High) |
| Normal runtime, service and contract implementation | Claude Sonnet 5 (High) |
| Complex authorization, transactions and cross-service implementation | Claude Opus 5 (High), or GPT 5.6 Sol (Codex - High) when capacity favours Codex |
| Alternative bounded implementation | GPT 5.6 Terra or Luna when their capacity and task fit justify it |
| Every final code review and its fixes | Claude Opus 5 (High) or GPT 5.6 Sol (Codex - High), in a separate session from the implementer |

Choose the least expensive suitable lane. Planned assignments are provisional. Before every pickup and review handoff, read `orca account list --json`: check Claude and Codex session/weekly usage, reset times, freshness and errors. During longer work, refresh at the 30-minute checkpoint. Unknown quota is not unlimited quota. GLM/Antigravity capacity may require observing the actual provider response.

Prefer the suitable provider with more remaining capacity; keep 15% weekly headroom for necessary review and recovery. Below 25% remaining, avoid routine implementation on that provider. At 15% remaining or less, move new work to another suitable provider. Never consume reset credits or buy capacity automatically. If both permitted reviewers are unavailable, keep the candidate in review and report the capacity blocker; do not substitute a cheaper reviewer or claim Done. Do not repeatedly probe a provider that has already returned a limit.

Verify the actual model in the launch receipt or terminal. Installed identifiers at this reset: OpenCode `dahl/zai-org/GLM-5.3-Flash`; Antigravity `gemini-3.8-flash-high`. Claude aliases must resolve visibly to Sonnet 5 or Opus 5; never label another version as the requested model. Use the installed Orca CLI and its version-matched orchestration guide.

## Sequential pickup and review ownership

1. Pick one implementation leaf: the lowest Pickup Order whose dependencies and prerequisite child scopes are complete. Parent and phase issues are rollups, never parallel implementation assignments.
2. Read its current body, specification and source, plus its salvage entry. Select the agent using difficulty and current usage. Update Planned agent, estimate, worktree/branch metadata and current owner before dispatch. A reassignment updates the issue body, board fields and parent subtask row together.
3. Create a fresh issue worktree from current `origin/main`. Extract only applicable product code from the preserved archive. Do not revive old agent conversations or merge old branches wholesale. Confirm the actual branch returned by Orca and record it; never publish a planned branch as the actual branch.
4. Stop and settle the implementer after a committed candidate. Hand exclusive edit ownership of that same candidate to a fresh Opus 5 or Sol review agent. No competing editors remain.
5. The review agent reads the complete diff against the issue, fixes findings itself, and re-reviews the final changed code. It does not send ordinary fixes back to the implementer. It owns PR preparation/integration and closes its assigned issue when the final implementation satisfies acceptance and is integrated. It must not close unrelated issues. An earlier review does not cover newly changed code.
6. The coordinator consumes the reviewer's completion, updates the board once, rolls up completed parents and releases worker sessions. Remove the finished task worktree after its commits and any useful notes are preserved. Then pick the next issue. Keep only the active coordinator and current task worktree.

Code review is the only development acceptance activity. Do not create or run tests, request database/hosted reviews, require proof receipts or add testing gates. Product access checks, atomicity and correct error handling remain functionality. No backward-compatibility scaffolding is required for unused representations.

## Estimates and stalls

Estimates are planning estimates of active implementation plus review/fix work. Recalibrate at pickup when changing models or importing salvage. At the estimate or 30 minutes, inspect actual progress and remaining work. Help resolve a concrete blocker; continue useful progress with a revised estimate. Elapsed time alone never kills a worker. On confirmed provider failure, preserve the candidate and stop the old editor before selecting a replacement. Never launch a duplicate after an ambiguous send.

## Metadata and completion

Use the issue number in its title and worktree display name. Record planned implementation agent, review agent, active-minute estimate, phase, numeric pickup, actual branch/worktree, and current owner/dispatch separately. Parent estimates are child totals. An implementer's completion is In review, never Done. Only the Opus/Sol review-and-fix owner can close the task after final review and integration. Cancelled scope remains Not planned.

The coordinator alone makes shared board/planning changes; the review owner may close its assigned issue and prepare/integrate its PR. Before merge, account for repository automation. This development instruction does not authorize database execution, hosted administration or Production deployment; do not trigger those incidentally. Report a concrete integration conflict instead of silently weakening this boundary.

## Clean fleet

The old fleet is retired. Historical commits, working files and terminal snapshots are preserved at `C:/Users/vijay/orca/archives/vortex-20260922-reset`. See its `SALVAGE.md` and `archive-manifest.json`. Historical instructions there are reference only. Keep no idle workers, superseded owner worktrees or stale automatic relaunches. Preserve useful changes before removing a workspace.
