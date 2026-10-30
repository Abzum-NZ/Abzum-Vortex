import { containedComponentIdSchema, recordIdSchema } from "../catalogue/identifiers";

/** The edge identity has one spelling for construction and for reading a task result. */
export const relationshipReference = (
  candidate: string | Readonly<{ relationshipId: string; sourceRecordId: string }>,
): Readonly<{ relationshipId: string; sourceRecordId: string; value: string }> | undefined => {
  const parts =
    typeof candidate === "string"
      ? candidate.split(":")
      : [candidate.relationshipId, candidate.sourceRecordId];
  if (parts.length !== 2) return undefined;
  const relationship = containedComponentIdSchema.safeParse(parts[0]);
  const source = recordIdSchema.safeParse(parts[1]);
  if (!relationship.success || !source.success) return undefined;
  const relationshipId = relationship.data.toLowerCase();
  const sourceRecordId = source.data.toLowerCase();
  return { relationshipId, sourceRecordId, value: `${relationshipId}:${sourceRecordId}` };
};
