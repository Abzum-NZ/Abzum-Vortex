import { recordChangeListSchema } from "../records/record-change-list";
import { recordIdSchema } from "../catalogue/identifiers";
import type { FlowValue } from "../workflows/flow-values";
import type { FlowRuntimeValues } from "./flow-interpreter";
import type { FlowRuntimeValue } from "./flow-formula";

/** Copy endpoints are FlowValues inside the one authored change-list shape. */
export const evaluateRecordChangeValues = (
  properties: FlowRuntimeValues,
  evaluate: (value: FlowValue) => FlowRuntimeValue,
): FlowRuntimeValues | undefined => {
  const changes = recordChangeListSchema.safeParse(properties.changes?.value);
  if (!changes.success) return undefined;
  const resolved = [];
  for (const change of changes.data) {
    const subject = evaluate(change.subject);
    const target = evaluate(change.target);
    if (
      subject.type !== "record_reference" ||
      target.type !== "record_reference" ||
      !recordIdSchema.safeParse(subject.value).success ||
      !recordIdSchema.safeParse(target.value).success
    )
      return undefined;
    resolved.push({ ...change, subject: subject.value, target: target.value });
  }
  return { ...properties, changes: { type: "json", value: resolved } };
};
