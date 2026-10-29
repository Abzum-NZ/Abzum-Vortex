import { PLATFORM_SERVICE_OPERATIONS } from "../catalogue/platform-service-operation-catalogue";
import { platformOperationKey } from "../catalogue/platform-service-operation-catalogue";
import { flowReadFieldsProjectionSchema, type FlowTask } from "../workflows/flow-contracts";
import type { SourceFlowTask } from "../workflows/flow-source-contracts";
import type { FlowValue } from "../workflows/flow-values";

/**
 * The one answer to "which named members does this step's JSON output declare?". The flow
 * validator uses it to refuse a reference to a member the step does not declare; Studio uses it
 * to offer every declared member whether or not anything reads it yet. An output with no declared
 * shape returns `undefined`: it is offered and read as the whole value only. Members are one level;
 * each is read as a whole, including a form answer whose value is a map or JSON object.
 */

export type FlowOutputMember = Readonly<{
  name: string;
  /** The member's value type when the step's contract fixes it; otherwise only the run knows. */
  type: string | undefined;
}>;

export type FlowOutputMembers = Readonly<{
  /** Whether the whole output may be read as one value besides its members. */
  whole: boolean;
  members: readonly FlowOutputMember[];
}>;

export type FlowOutputMemberOptions = Readonly<{
  /**
   * The type of a projected record field written `<record type>.<field>`, for a flow that is not
   * compiled yet. A compiled `record.read_fields` task carries its own types.
   */
  readFieldType?: (field: string) => string | undefined;
}>;

type RegisteredTask = Readonly<{
  type: string;
  properties: Readonly<Record<string, FlowValue>>;
  readFieldTypes?: Readonly<Record<string, string>>;
}>;

export const flowTaskOutputMembers = (
  task: FlowTask | SourceFlowTask,
  outputKey: string,
  options: FlowOutputMemberOptions = {},
): FlowOutputMembers | undefined => {
  if (!("properties" in task)) return undefined;
  const registered = task as unknown as RegisteredTask;
  const { properties } = registered;
  switch (registered.type) {
    case "record.read_fields": {
      if (outputKey !== "values") return undefined;
      const projectionValue = properties.fields;
      const projection =
        projectionValue?.kind === "literal" && projectionValue.literal.type === "json"
          ? flowReadFieldsProjectionSchema.safeParse(projectionValue.literal.value)
          : undefined;
      if (!projection?.success) return undefined;
      return {
        whole: false,
        members: projection.data.map((entry) => ({
          name: entry.alias,
          type: registered.readFieldTypes?.[entry.alias] ?? options.readFieldType?.(entry.field),
        })),
      };
    }
    case "operation.call": {
      if (outputKey !== "result") return undefined;
      const operation = properties.operation;
      const key = operation?.kind === "literal" ? operation.literal.value : undefined;
      const entry = Object.values(PLATFORM_SERVICE_OPERATIONS).find(
        (candidate) => platformOperationKey(candidate.key) === key,
      );
      if (
        entry === undefined ||
        (entry.descriptor.effect !== "read" && entry.descriptor.effect !== "change")
      )
        return undefined;
      const members = Object.entries(entry.descriptor.outputs).map(([name, output]) => ({
        name,
        type: output.type as string | undefined,
      }));
      return members.length === 0 ? undefined : { whole: true, members };
    }
    case "interface.show_form": {
      // The input map is the form's answer declaration: Studio seeds it with every field of the form.
      const inputs = properties.inputs;
      if (outputKey !== "values" || inputs?.kind !== "map") return undefined;
      return {
        whole: true,
        members: Object.entries(inputs.entries).map(([name, value]) => ({
          name,
          type: value.kind === "literal" ? value.literal.type : undefined,
        })),
      };
    }
    default:
      return undefined;
  }
};
