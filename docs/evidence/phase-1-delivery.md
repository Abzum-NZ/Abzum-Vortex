# Phase 1 delivery evidence

This record proves the final integration gate around the Phase 1 implementation. Detailed contract, compiler, fixture, versioning and boundary evidence remains with [Phase 1 issues #10–#16 and #186](https://github.com/Abzum-NZ/Abzum-Vortex/issues/9); this document does not restate or redefine those requirements.

The final `testing` and `main` merge identities do not exist until after this document is reviewed and merged. The [#17 completion record](https://github.com/Abzum-NZ/Abzum-Vortex/issues/17) therefore supplies those final immutable pull-request, commit, deployment and route links.

## One gate and one deployment root

| Item | Verified state |
|---|---|
| Next.js application | `apps/web`; the only deployable application and composition root |
| Vercel Root Directory | `apps/web`, with files outside the directory included for the monorepo build |
| Vercel configuration | `apps/web/vercel.json` |
| Install | Return to the workspace root, enable Corepack and run `pnpm install --frozen-lockfile` |
| Build gate | Return to the workspace root and run `pnpm verify` |
| Vercel output | `.next`, relative to `apps/web` |
| Turborepo output | `.next/**` excluding `.next/cache/**`; safe if optional task caching is enabled |
| Node | Repository major `24`; Vercel project setting `24.x` |
| Package manager | Exact `pnpm@10.32.1` |
| Turborepo | Exact workspace development dependency `2.10.12` |
| Other CI | None; Vercel Git integration is the pull-request gate |

This follows the [official Vercel Turborepo layout](https://vercel.com/docs/monorepos/turborepo): the deployable project is under `apps/`, Vercel knows its application root, and the build can include its workspace dependencies. Task caching remains an optional optimisation rather than a release condition.

## Clean-checkout proof

A disposable local clone of feature commit `23429402076d4733627fce641baa2532f8e55fb4` was created outside the working repository on Windows. It had no local environment file or database process. The clone installed from the committed lockfile and completed `pnpm verify` without a database call, migration, runtime credential or external application service after installation.

| Evidence | Result |
|---|---|
| Git status after verification | Clean |
| Node actually used | `v24.14.0` |
| pnpm actually used | `10.32.1` |
| Turbo resolved through the clone's `node_modules/.bin` | `2.10.12` |
| Lockfile SHA-256 | `66eefd26e5a605adfca33135bef2e19a78239a64fdcf5aeb3f5a87bb86d8c16c` |
| Line endings | Index and worktree LF for `.nvmrc`, `.node-version`, `pnpm-lock.yaml` and `apps/web/vercel.json` |
| Type checking | 23 packages passed |
| Package boundaries | 23 packages passed |
| Automated tests | 9 files, 388 tests passed |
| Complete fixture gate | 8 checks passed over all 13 authored source documents |
| Production builds | 23 packages passed, including Next.js 16.3.3 |
| Built routes | `/`, `/_not-found` and `/health` |

The machine already had the exact declared pnpm version. Windows refused Corepack permission to rewrite the protected system shim, so the existing exact pnpm executable performed the frozen install. Vercel's Linux build successfully ran the committed `corepack enable` command. This host-specific permission difference did not change the package manager, lockfile, source or gate.

## Feature Preview using the corrected root

Vercel built the committed application-local configuration after its live project Root Directory was set to `apps/web`.

| Evidence | Result |
|---|---|
| Commit | [`2342940`](https://github.com/Abzum-NZ/Abzum-Vortex/commit/23429402076d4733627fce641baa2532f8e55fb4) |
| GitHub deployment | [`6235404059`](https://github.com/Abzum-NZ/Abzum-Vortex/deployments/6235404059) |
| Vercel build | [Successful Preview](https://vercel.com/abzumdevteam/abzum-vortex/5UMv3HfJRP2yvwpnNmbRjA2GjokH) |
| Preview | [`abzum-vortex-9tqj8x6un-abzumdevteam.vercel.app`](https://abzum-vortex-9tqj8x6un-abzumdevteam.vercel.app) |
| `/` | HTTP 200 |
| `/health` | HTTP 200 |

The Vercel log records the full workspace path, the exact lockfile/package-manager detection and `pnpm verify`. Vercel also reports future runtime-variable names as unavailable to Turborepo tasks because they are intentionally absent from `turbo.json`; the Phase 1 gate succeeds without consuming those values. No secret value is copied into this evidence.

## Required-check refusal proof

[Temporary PR #193](https://github.com/Abzum-NZ/Abzum-Vortex/pull/193) added one harmless, deliberately unformatted JSON file. The `Vercel` status failed, GitHub reported the pull request as blocked, and the merge control was disabled. The pull request was closed without merge and its temporary branch was deleted. No failure-probe file entered `testing`, `main` or the #17 implementation branch.

This single integration probe proves the real required-check connection. Permanent artificial format, lint, type, boundary, test and fixture failures would duplicate the tools' own tests and are deliberately not part of the repository.

## Protected branches and GitHub-held state

The GitHub branch-protection API was read for both `testing` and `main`.

| Protection | `testing` | `main` |
|---|---:|---:|
| Pull request required | Yes | Yes |
| Branch must be current before merge | Yes | Yes |
| Required status | `Vercel` | `Vercel` |
| Expected status provider | Vercel GitHub App `8329` | Vercel GitHub App `8329` |
| Conversations resolved | Yes | Yes |
| Force pushes | Disabled | Disabled |
| Branch deletion | Disabled | Disabled |
| Administrator bypass | Break-glass only | Break-glass only |

The repository has no `.github/workflows` directory, GitHub Actions secret, Dependabot secret, Codespaces secret or repository variable. The documented administrator bypass remains available for recovery but cannot turn a failed required status into an acceptable ordinary release.

## Existing full Phase 1 promotion proof

The final implementation issue supplied a complete successful path immediately before #17:

| Stage | Evidence |
|---|---|
| Feature | [Commit `8bbc493`](https://github.com/Abzum-NZ/Abzum-Vortex/commit/8bbc493), [PR #191](https://github.com/Abzum-NZ/Abzum-Vortex/pull/191), and its successful feature Preview |
| Testing | [Merge `62ebb734`](https://github.com/Abzum-NZ/Abzum-Vortex/commit/62ebb7340f760c692f49536ad5c86566fe031206) and [successful Testing Preview](https://abzum-vortex-6svit3i83-abzumdevteam.vercel.app) |
| Production | [PR #192](https://github.com/Abzum-NZ/Abzum-Vortex/pull/192), [merge `b53b7864`](https://github.com/Abzum-NZ/Abzum-Vortex/commit/b53b78646fdc933454830807e45e955f0035169f), and [successful Production deployment](https://abzum-vortex-8d5si2z1i-abzumdevteam.vercel.app) |

The feature, Testing and Production URLs each returned HTTP 200 for `/` and `/health`. Issue #17 repeats the promotion only for its corrected `apps/web` Vercel-root revision, then closes the Phase 1 epic.
