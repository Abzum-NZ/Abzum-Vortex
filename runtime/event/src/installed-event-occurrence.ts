import {
  eventOccurrenceEnvelopeV2Schema,
  type EventOccurrenceEnvelopeV2,
  type FieldDefinition,
  type InstalledEventDescriptor,
  type ModuleFieldV2,
} from "@vortex/contracts";
import {
  resolveInstalledEventDefinitionContext,
  type InstalledEventCatalogueInput,
} from "@vortex/definition";
import { persistedRecordFieldValueMatches } from "@vortex/record";

export const installedEventOccurrenceErrorCodes = [
  "INSTALLED_EVENT_OCCURRENCE_INVALID",
  "INSTALLED_EVENT_OCCURRENCE_UNAVAILABLE",
  "INSTALLED_EVENT_OCCURRENCE_CONTEXT_MISMATCH",
  "INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID",
] as const;

export type InstalledEventOccurrenceErrorCode = (typeof installedEventOccurrenceErrorCodes)[number];

export class InstalledEventOccurrenceError extends Error {
  readonly code: InstalledEventOccurrenceErrorCode;

  constructor(code: InstalledEventOccurrenceErrorCode) {
    super(code);
    this.name = "InstalledEventOccurrenceError";
    this.code = code;
  }
}

type ExactRelease = Readonly<{
  rootId: string;
  releaseRevision: number;
  releaseVersion: string;
  contentFingerprint: string;
  resolutionFingerprint: string;
}>;

const releaseMatches = (left: ExactRelease, right: ExactRelease): boolean =>
  left.rootId === right.rootId &&
  left.releaseRevision === right.releaseRevision &&
  left.releaseVersion === right.releaseVersion &&
  left.contentFingerprint === right.contentFingerprint &&
  left.resolutionFingerprint === right.resolutionFingerprint;

const descriptorIdentity = (descriptor: InstalledEventDescriptor): string => {
  if (descriptor.kind === "standard")
    return `standard:${descriptor.eventKind}:${descriptor.recordTypeId}`;
  const owner =
    descriptor.owner.kind === "application"
      ? `application:${descriptor.owner.applicationRootId}`
      : `module:${descriptor.owner.moduleRootId}`;
  return [
    "declared",
    owner,
    descriptor.declarationId,
    descriptor.key,
    descriptor.recordTypeId,
    ...descriptor.carriedFieldIds,
  ].join(":");
};

type DefinitionContext = ReturnType<typeof resolveInstalledEventDefinitionContext>;
type ResolvedRecord =
  DefinitionContext["recordTypes"] extends ReadonlyMap<string, infer Record> ? Record : never;
type ResolvedField = ResolvedRecord["recordType"]["fields"][number];

const fieldValueMatches = (
  record: ResolvedRecord,
  field: ResolvedField,
  value: unknown,
): boolean =>
  record.module.validationContractVersion === "2.0.0"
    ? persistedRecordFieldValueMatches({
        validationContractVersion: "2.0.0",
        field: field as ModuleFieldV2,
        value,
      })
    : persistedRecordFieldValueMatches({
        validationContractVersion: "1.0.0",
        field: field as FieldDefinition,
        value,
      });

const expectedDefinitionRelease = (
  context: DefinitionContext,
  descriptor: InstalledEventDescriptor,
  record: ResolvedRecord,
): Readonly<{ kind: "application" | "module"; release: ExactRelease }> => {
  let moduleRootId: string;
  if (descriptor.kind === "declared") {
    if (descriptor.owner.kind === "application")
      return { kind: "application", release: context.catalogue.application };
    moduleRootId = descriptor.owner.moduleRootId;
  } else moduleRootId = record.module.rootId;
  const binding = context.catalogue.moduleBindings.find(
    (candidate) => candidate.release.rootId === moduleRootId,
  );
  if (binding === undefined)
    throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_UNAVAILABLE");
  return { kind: "module", release: binding.release };
};

/**
 * Validates a candidate against the exact installed definitions without writing
 * an occurrence, queue message, sequence, activity or other delivery state.
 */
export const validateInstalledEventOccurrence = (
  input: InstalledEventCatalogueInput,
  occurrenceCandidate: unknown,
): EventOccurrenceEnvelopeV2 => {
  const context = resolveInstalledEventDefinitionContext(input);
  const occurrence = eventOccurrenceEnvelopeV2Schema.safeParse(occurrenceCandidate);
  if (!occurrence.success)
    throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_INVALID");
  const value = occurrence.data;
  const descriptor = context.catalogue.descriptors.find(
    (candidate) => descriptorIdentity(candidate) === descriptorIdentity(value.descriptor),
  );
  if (descriptor === undefined)
    throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_UNAVAILABLE");

  const record = context.recordTypes.get(String(descriptor.recordTypeId));
  const binding = record
    ? context.bindings.find((candidate) => candidate.moduleRootId === record.module.rootId)
    : undefined;
  if (
    record === undefined ||
    binding === undefined ||
    value.organizationId !== context.catalogue.organizationId ||
    value.installation.applicationRootId !== context.application.rootId ||
    value.installation.applicationReleaseRevision !== context.application.releaseRevision ||
    value.installation.moduleBinding.moduleRootId !== binding.moduleRootId ||
    value.installation.moduleBinding.moduleReleaseRevision !== binding.moduleReleaseRevision ||
    value.installation.moduleBinding.bindingRevision !== binding.bindingRevision
  )
    throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_CONTEXT_MISMATCH");

  const expectedRelease = expectedDefinitionRelease(context, descriptor, record);
  if (
    value.definitionRelease.kind !== expectedRelease.kind ||
    !releaseMatches(value.definitionRelease, expectedRelease.release)
  )
    throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_CONTEXT_MISMATCH");

  const fields = new Map(
    record.recordType.fields.map((field) => [String(field.fieldId), field] as const),
  );
  if (descriptor.kind === "declared") {
    if (value.payload.kind !== "declared")
      throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID");
    const allowed = new Set(descriptor.carriedFieldIds.map(String));
    if (
      Object.entries(value.payload.carriedValues).some(([fieldId, carriedValue]) => {
        const field = fields.get(fieldId);
        return (
          !allowed.has(fieldId) ||
          field === undefined ||
          field.personalData !== "none" ||
          !fieldValueMatches(record, field, carriedValue)
        );
      })
    )
      throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID");
  } else if (descriptor.eventKind === "changed") {
    if (
      value.payload.kind !== "changed" ||
      value.payload.changedFieldIds.some((fieldId) => !fields.has(String(fieldId)))
    )
      throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID");
  } else if (descriptor.eventKind === "state_changed") {
    if (value.payload.kind !== "state_changed")
      throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID");
    const field = fields.get(String(value.payload.fieldId));
    const hasPrevious = value.payload.previousValue !== undefined;
    const hasNew = value.payload.newValue !== undefined;
    const previousValid =
      !hasPrevious ||
      (field !== undefined && fieldValueMatches(record, field, value.payload.previousValue));
    const newValid =
      !hasNew || (field !== undefined && fieldValueMatches(record, field, value.payload.newValue));
    if (
      field === undefined ||
      (field.personalData !== "none" && (hasPrevious || hasNew)) ||
      (field.personalData === "none" && !hasPrevious && !hasNew) ||
      !previousValid ||
      !newValid
    )
      throw new InstalledEventOccurrenceError("INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID");
  }
  return value;
};
