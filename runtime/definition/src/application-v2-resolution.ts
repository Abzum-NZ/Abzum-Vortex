import {
  definitionResolutionSnapshotV2Schema,
  type ConditionNode,
  type DefinitionResolutionSnapshotV2,
  type sourceQualifiedConditionSchema,
} from "@vortex/contracts";
import type { z } from "zod";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";

export type ApplicationCompositionResolutionV2 = Readonly<{
  identity(
    kind:
      | "shell"
      | "shell_content_slot"
      | "block_placement"
      | "guided_step"
      | "page"
      | "query"
      | "pipeline"
      | "flow"
      | "flow_node"
      | "flow_edge"
      | "flow_binding",
    alias: string,
    scope?: string,
  ): string;
  field(reference: string): string;
  /**
   * The module field an automatic field input binds, read by permanent field identity. Undefined
   * when the field is not part of an exactly bound module release, so publication refuses it.
   */
  fieldInput(fieldId: string): FieldInputSourceField | undefined;
  relationship(reference: string): string;
  action(reference: string): string;
  permission(reference: string): string;
  condition(authored: z.infer<typeof sourceQualifiedConditionSchema>): ConditionNode;
  recordType(reference: string): Readonly<{
    state: "resolved";
    moduleRootId: string;
    recordTypeId: string;
  }>;
}>;

/**
 * The exact module-field metadata the compiler derives one automatic field input from: its stable
 * key, its label, whether it is required, its module field type, its choices (choice fields only)
 * and the record types it targets (link fields only).
 */
export type FieldInputSourceField = Readonly<{
  key: string;
  label: string;
  required: boolean;
  type: string;
  choices: readonly Readonly<{ key: string; label: string }>[];
  recordTypes: readonly Readonly<{
    state: "resolved";
    moduleRootId: string;
    recordTypeId: string;
  }>[];
}>;

type ResolutionEvidenceV2 = Pick<DefinitionResolutionSnapshotV2, "definitions" | "identities">;

const identityOrder = (identity: DefinitionResolutionSnapshotV2["identities"][number]): string =>
  JSON.stringify([
    identity.definitionKey,
    identity.scope,
    identity.kind,
    identity.componentOwner,
    identity.alias,
    identity.identifier,
  ]);

/** Builds exact V2 resolution evidence without making caller-provided array order authoritative. */
export const createApplicationResolutionSnapshotV2 = (
  input: ResolutionEvidenceV2,
): DefinitionResolutionSnapshotV2 => {
  const definitionKeys = input.definitions.map(({ kind, key }) => `${kind}:${key}`);
  if (new Set(definitionKeys).size !== definitionKeys.length)
    throw new Error("V2 resolution evidence contains duplicate definition selections");
  const identityKeys = input.identities.map(
    ({ definitionKey, scope, kind, alias }) => `${definitionKey}:${scope}:${kind}:${alias}`,
  );
  if (new Set(identityKeys).size !== identityKeys.length)
    throw new Error("V2 resolution evidence contains duplicate identity lookup keys");
  const definitions = [...input.definitions].sort((left, right) =>
    compareCanonicalStrings(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
  const identities = [...input.identities].sort((left, right) =>
    compareCanonicalStrings(identityOrder(left), identityOrder(right)),
  );
  const evidence = { contractVersion: "2.0.0" as const, definitions, identities };
  return definitionResolutionSnapshotV2Schema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
  });
};
