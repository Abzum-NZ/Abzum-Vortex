import { z } from "zod";
import { containedComponentIdSchema } from "./identifiers";

/**
 * The application flow-binding run-as vocabulary (`application-flow-bindings.ts`):
 * `current_user` always means the original verified initiator, never the actor
 * of the preceding overridden node. The other modes name Access-owned
 * execution bindings.
 */
export const flowNodeRunAsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current_user") }).strict(),
  z
    .object({
      kind: z.literal("specified_user"),
      executionBindingId: containedComponentIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), executionBindingId: containedComponentIdSchema }).strict(),
]);
export type FlowNodeRunAs = z.infer<typeof flowNodeRunAsSchema>;
