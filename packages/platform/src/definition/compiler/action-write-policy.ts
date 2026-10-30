import { compareCanonicalStrings } from "../canonical-json-definition";
import type { Resolution } from "./resolution";
import { asObject, fail, type JsonObject } from "./shared";

const literalText = (value: unknown): string => {
  const literal = asObject(asObject(value).literal);
  if (asObject(value).kind !== "literal" || typeof literal.value !== "string")
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  return literal.value;
};

const mapKeys = (value: unknown): string[] => {
  const map = asObject(value);
  if (map.kind !== "map")
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  return Object.keys(asObject(map.entries));
};

/**
 * What an authored action flow may write, read from the flow's own record steps: the subject
 * fields set, a subject delete, each creation with its fields (in flow order), each relationship
 * copy and each announced Event. An action flow is a linear list of these steps, so nothing else
 * is possible. The database checks every write of a run against this policy.
 */
export function actionWritePolicy(
  flow: JsonObject | undefined,
  subjectRecordKey: unknown,
  qualifiedForRecord: (recordKey: string) => string,
  resolution: Resolution,
): JsonObject {
  if (flow === undefined)
    return fail("vortex.definition.workflow_node_references", "broken_reference");
  const subject = qualifiedForRecord(String(subjectRecordKey));
  const subjectFieldIds = new Set<string>();
  const creates: JsonObject[] = [];
  const relationshipCopies: JsonObject[] = [];
  const eventKeys: string[] = [];
  let deletesSubject = false;
  for (const task of flow.tasks as JsonObject[]) {
    const properties = asObject(task.properties);
    switch (String(task.type)) {
      case "record.set_fields":
        for (const key of mapKeys(properties.values))
          subjectFieldIds.add(resolution.field(subject, key));
        break;
      case "record.create": {
        const target = literalText(properties.record_type);
        const owner = target.includes(":") ? target : qualifiedForRecord(target);
        creates.push({
          recordTypeId: resolution.recordType(owner).recordTypeId,
          fieldIds: mapKeys(properties.values)
            .map((key) => resolution.field(owner, key))
            .sort(compareCanonicalStrings),
        });
        break;
      }
      case "record.changes": {
        const literal = asObject(asObject(properties.changes).literal);
        for (const change of literal.value as JsonObject[]) {
          const target = asObject(asObject(change.target).reference);
          relationshipCopies.push({
            relationshipIds: (change.relationshipIds as string[]).map((alias) =>
              resolution.relationship(subject, alias),
            ),
            targetInputKey: String(target.name),
          });
        }
        break;
      }
      case "record.delete":
        deletesSubject = true;
        break;
      case "stop":
        break;
      case "event.announce":
        eventKeys.push(literalText(properties.event));
        break;
      default:
        return fail("vortex.definition.invalid_compilation_output", "invalid_value");
    }
  }
  return {
    subjectFieldIds: [...subjectFieldIds].sort(compareCanonicalStrings),
    deletesSubject,
    creates,
    relationshipCopies,
    eventKeys,
  };
}
