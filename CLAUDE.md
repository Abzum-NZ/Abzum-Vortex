# Vortex: Claude Code working instructions

Read [the coordination rules](docs/build-plan/agent-coordination.md) and the
specific task brief before acting. The task brief identifies your role, branch,
scope and stopping point. Do not infer a new task from unfinished nearby work.

Start with [README](README.md), the relevant [specification](docs/specification/README.md),
[build plan](docs/build-plan/README.md), and linked GitHub issue. Read actual code
and current changes; old plans and green tests are not proof of delivered behaviour.

Vortex is a generic application builder. Core code contains platform primitives,
not business-application names or special cases. Build engines and definition-led
application execution before the visual App Designer. Preserve existing owning
services, exact definitions, tenant isolation and transaction/revision correctness.

Be concrete and concise. No dramatic wording, vague completion claims, speculative
frameworks or unrelated improvements. Fix demonstrated causes. Report exact changed
behaviour, evidence, remaining gaps and the next required handoff. Do not weaken
checks merely to pass tests or add machinery without a concrete need.

Never use Claude Code to bypass a rejected tool action, filesystem restriction or
prior safety decision. Stop the affected action and report it to the coordinator.
Never expose secrets in prompts, logs, documents or commits.
