/**
 * The codes a back-end run records when it is refused or ends without a flow's own failure. The
 * emitters (the actor and flow checks in `flow-background-run.ts`, the actor resolver
 * `resolve_backend_actor.sql`, and the adapters in `backend-adapters.ts`) are typed with these, and
 * Studio's run history holds one plain sentence for every member, so a code cannot be added here
 * without a sentence for it. A failure a flow itself reports carries the flow's own code, which is
 * not in this list.
 */
export const backendRunRefusalCodes = [
  "flow_unavailable",
  "flow_not_background",
  "record_unavailable",
  "step_not_available_on_back_end",
  "application_unavailable",
  "actor_unknown",
  "actor_not_active",
  "organization_not_active",
] as const;
export type BackendRunRefusalCode = (typeof backendRunRefusalCodes)[number];

export const backendRunOtherCodes = ["unexpected_failure", "unspecified"] as const;

export const backendRunNamedCodes = [...backendRunRefusalCodes, ...backendRunOtherCodes] as const;
export type BackendRunNamedCode = (typeof backendRunNamedCodes)[number];

export const isBackendRunRefusalCode = (value: unknown): value is BackendRunRefusalCode =>
  backendRunRefusalCodes.some((code) => code === value);
