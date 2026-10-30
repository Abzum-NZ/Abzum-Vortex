import { z } from "zod";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";

const source = {
  code: z.string(),
  flowId: z.uuid(),
  taskPath: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  record: z.object({ recordTypeId: z.uuid(), recordId: z.uuid() }).strict().optional(),
};

/** A dynamic warning stores only its authored identity, never its rendered record values. */
export const storedFlowWarningSchema = z.discriminatedUnion("kind", [
  z.object({ ...source, kind: z.literal("literal"), message: z.string() }).strict(),
  z.object({ ...source, kind: z.literal("dynamic") }).strict(),
]);

export const storeFlowWarning = (
  warning: BeforeSaveRuleWarning,
): z.infer<typeof storedFlowWarningSchema> => {
  const source = { code: warning.code, flowId: warning.flowId, taskPath: [...warning.taskPath],
    ...(warning.record === undefined ? {} : { record: warning.record }) };
  return warning.messageIsLiteral
    ? { ...source, kind: "literal", message: warning.message }
    : { ...source, kind: "dynamic" };
};
