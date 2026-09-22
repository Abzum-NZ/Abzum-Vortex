# Vortex implementation instructions

Read the assigned issue, its linked specification, and the source before editing. The current issue description defines the work; dated comments and historical handovers do not add requirements.

Vortex is a new, definition-led application platform. Correct contracts, engines and schema at their owning boundary. Use one current representation; do not retain V1 readers, conversion layers or obsolete shapes for backward compatibility. Published application versions, explicit activation and draft revision checks remain product functionality.

Implement the assigned functionality and obtain code review against its acceptance criteria. Do not create or run tests, request database review, require hosted evidence, or add verification gates. Existing test files are not additional scope. Development completion does not claim a production release.

Keep organisation isolation, permission checks, atomic writes, safe errors and secret handling in the implementation. Business-specific behaviour belongs in definitions, not generic engines.

Use the issue's planned agent, estimate, pickup order and worktree metadata. Preserve existing drafts. At the estimate, inspect actual progress and report the remaining work; never kill or restart solely because time elapsed. See [coordination](docs/build-plan/agent-coordination.md) and [fleet operation](docs/build-plan/agent-fleet.md).
