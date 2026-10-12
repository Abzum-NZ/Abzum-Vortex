## What changed

Issue #
Describe the behaviour implemented and its scope.

## Walkthrough

Pages exercised on a freshly reset local database (sign-in, then each affected page), with screenshots when the change is visible.

## Checklist ([target architecture](../docs/build-plan/target-architecture.md))

- [ ] Root cause fixed, not a workaround at the symptom.
- [ ] No new layer, `V2`/`V3` copy, receipt, fingerprint or other process artefact.
- [ ] No business application names in engines; no absent-setting behaviour; no hard-coded shell, navigation or theme.
- [ ] Errors keep their cause in the server log; no silent `null` on platform data.
- [ ] Organisation isolation, current permission checks, atomic writes and revision checks preserved.
- [ ] Schema changes ship as a new migration; changed functions keep the `supabase/schemas` file identical to the migration.
- [ ] `pnpm guard` and `pnpm typecheck` pass.
