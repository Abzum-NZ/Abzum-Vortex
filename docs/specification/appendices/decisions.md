# Open decision register

[Specification index](../README.md) · [Data contracts](data-contracts.md) · [Build plan](../../build-plan/README.md)

There is one open product decision in this register.

The choices formerly numbered D01–D36 have been incorporated into the permanent requirements, contracts, examples, acceptance tests, build phases, and linked GitHub work. They are intentionally absent here so implementation cannot mistake a resolved option for an open question.

## D37 — Who sets a module or application release number?

**Question:** After Vortex compares the current published revision with the proposed revision and identifies the required patch, minor, or major impact, who chooses the next release number?

- **A — Vortex assigns the minimum valid next version (recommended).** The builder reviews the detected changes and confirms publication but cannot type a different release number. This removes an unnecessary choice and prevents accidental compatibility claims.
- **B — The builder proposes the release version.** Vortex refuses any version below the detected minimum but permits a larger jump. This gives publishers more control but adds another editable field and more validation states.

**Recommendation:** A. Vortex should explain every reason for the calculated impact and keep the builder's decision to publish or cancel, not ask the builder to perform version arithmetic.

**Blocked work:** The version-impact implementation in [issue #14](https://github.com/Abzum-NZ/Abzum-Vortex/issues/14). The complete domain schemas in [issue #12](https://github.com/Abzum-NZ/Abzum-Vortex/issues/12) can proceed.

**Decision owner and review point:** Abzum product owner, before issue #14 moves to Ready.

## Adding an open decision

Add an entry only when different reasonable answers would materially change product behaviour, data ownership, security, privacy, billing, delivery, or build order. Each entry must state:

- The plain-language question.
- The viable options and their consequences.
- The recommended option, if one is supportable.
- The specification, contract, build-plan, and GitHub work that remain blocked.
- The named decision owner and review date.

Once decided, update every affected permanent document and GitHub task, add or revise acceptance evidence, and remove the entry in the same change.
