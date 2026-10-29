import { z } from "zod";

/**
 * What a task does. `pure` computes from its inputs, `read` reads under the run's authority,
 * `change` changes data through a protected operation, `background_start` starts a run on
 * the back end, and `interface` talks to the person through the page.
 */
export const flowTaskEffectClassSchema = z.enum([
  "pure",
  "read",
  "change",
  "background_start",
  "interface",
]);
export type FlowTaskEffectClass = z.infer<typeof flowTaskEffectClassSchema>;

/** The safe result a task or protected operation reports. */
export const safeFlowResultKindSchema = z.enum([
  "completed",
  "committed",
  "refused",
  "conflict",
  "validation",
  "partial",
  "uncertain",
  "background_pending",
  "failed",
]);
export type SafeFlowResultKind = z.infer<typeof safeFlowResultKindSchema>;
