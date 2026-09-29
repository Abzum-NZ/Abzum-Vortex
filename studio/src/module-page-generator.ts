import {
  flowContractVersion,
  flowTaskRegistry,
  immutablePlatformBlockCatalogueV2Schema,
  moduleDraftV3Schema,
  namespacedKeySchema,
  queryIdSchema,
  recordTypeIdSchema,
  sourceComponentFlowBindingSchema,
  sourceFlowSchema,
  sourcePageDefinitionV2Schema,
  sourcePlacementEntriesV2,
  sourcePlacementSlotV2Schema,
  sourcePlatformBlockDependenciesV2Schema,
  type ImmutablePlatformBlockCatalogueV2,
  type ModuleDraftV3,
  type ModuleFieldV3,
  type ModuleQueryDefinitionV3,
  type RecordTypeDefinitionV3,
  type SourceApplicationBodyV2,
  type SourceBlockPropertyValueV2Contract,
  type SourceFlow,
  type SourcePageDefinitionV2,
} from "@vortex/contracts";

/** The four normal Application page kinds projected from one bound Module record type. */
export type ModuleGeneratedPageKind = "list" | "detail" | "create" | "edit";

/**
 * Exact inputs required to generate one record type's source fragments. The Module must already
 * be bound by the target Application; its read/create/update permission keys remain Application
 * policy decisions and are only referenced here. `listQueryId` selects an existing input-free
 * Module Query whose projection includes the record title field.
 */
export type ModulePageGeneratorInput = Readonly<{
  module: ModuleDraftV3;
  recordTypeId: string;
  listQueryId: string;
  permissions: Readonly<{
    read: string;
    create: string;
    update: string;
  }>;
  catalogue: ImmutablePlatformBlockCatalogueV2;
  /** Replacements keep the generated page identity and each form's bound submit control. */
  authoredPageOverrides?: Readonly<Partial<Record<ModuleGeneratedPageKind, SourcePageDefinitionV2>>>;
}>;

type ParsedFlowBinding = ReturnType<typeof sourceComponentFlowBindingSchema.parse>;
type ParsedPlatformDependencies = ReturnType<typeof sourcePlatformBlockDependenciesV2Schema.parse>;
type SourceApplicationEvent = SourceApplicationBodyV2["events"][number];

/** Ordinary authored Application source. Callers merge these fragments into the current draft. */
export type ModulePageFragments = Readonly<{
  pages: readonly SourcePageDefinitionV2[];
  events: readonly SourceApplicationEvent[];
  flows: readonly SourceFlow[];
  flow_bindings: readonly ParsedFlowBinding[];
  platform_block_dependencies: ParsedPlatformDependencies;
}>;

export type ModulePageGeneratorErrorCode =
  | "record_type_missing"
  | "unsupported_record_actions"
  | "list_query_missing"
  | "list_query_not_usable"
  | "unsupported_required_field"
  | "no_editable_fields"
  | "catalogue_release_missing"
  | "composition_policy_too_small"
  | "authored_page_identity_changed";

/** A fail-closed input or catalogue limitation with a stable caller-facing code. */
export class ModulePageGeneratorError extends Error {
  override readonly name = "ModulePageGeneratorError";

  constructor(
    readonly code: ModulePageGeneratorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const supportedFieldInputTypes: ReadonlySet<ModuleFieldV3["type"]> = new Set([
  "text",
  "email_address",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "link",
  "link_to_one_of_several",
]);

const compactId = (identity: string): string => identity.replaceAll("-", "").toLowerCase();

/** Source aliases are scoped to the Application and anchored to permanent Module identities. */
const sourceIdentity = (
  module: ModuleDraftV3,
  recordType: RecordTypeDefinitionV3,
  suffix: string,
): string =>
  `generated_${compactId(String(module.envelope.rootId))}_${compactId(String(recordType.recordTypeId))}_${suffix}`;

/** Builder keys are short, stable addresses; the source alias above retains the full identity. */
const builderIdentity = (identity: string, suffix: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < identity.length; index += 1) {
    hash = BigInt.asUintN(
      64,
      (hash ^ BigInt(identity.charCodeAt(index))) * 0x100000001b3n,
    );
  }
  return `generated_${hash.toString(16).padStart(16, "0")}_${suffix}`;
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareReleaseVersions = (left: string, right: string): number => {
  const parse = (version: string) => {
    const [coreAndPrerelease, build] = version.split("+");
    const [core, prerelease] = coreAndPrerelease!.split("-");
    return {
      numbers: core!.split(".").map(Number),
      prerelease: prerelease?.split("."),
      build,
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a.numbers[index]! - b.numbers[index]!;
    if (difference !== 0) return difference;
  }
  if (a.prerelease === undefined || b.prerelease === undefined) {
    if (a.prerelease === b.prerelease) return compareText(a.build ?? "", b.build ?? "");
    return a.prerelease === undefined ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) break;
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return compareText(leftPart, rightPart);
  }
  return compareText(a.build ?? "", b.build ?? "");
};

const latestRelease = (
  catalogue: ImmutablePlatformBlockCatalogueV2,
  key: string,
) => {
  const matches = catalogue.releases.filter((release) => release.key === key);
  if (matches.length === 0)
    throw new ModulePageGeneratorError(
      "catalogue_release_missing",
      `The supplied platform catalogue has no '${key}' release`,
    );
  return matches.reduce((latest, candidate) =>
    compareReleaseVersions(candidate.releaseVersion, latest.releaseVersion) > 0
      ? candidate
      : latest,
  );
};

const matchesRecordType = (
  query: ModuleQueryDefinitionV3,
  module: ModuleDraftV3,
  recordType: RecordTypeDefinitionV3,
): boolean => {
  const reference = query.recordType;
  if (reference.state === "resolved")
    return (
      String(reference.moduleRootId).toLowerCase() ===
        String(module.envelope.rootId).toLowerCase() &&
      String(reference.recordTypeId).toLowerCase() ===
        String(recordType.recordTypeId).toLowerCase()
    );
  return reference.qualifiedKey === `${module.envelope.key}:${recordType.key}`;
};

const fieldReference = (
  module: ModuleDraftV3,
  recordType: RecordTypeDefinitionV3,
  field: ModuleFieldV3,
): string => `${module.envelope.key}:${recordType.key}.${field.key}`;

const textValue = (value: string): SourceBlockPropertyValueV2Contract => ({
  kind: "text",
  value,
});

const choiceValue = (value: string): SourceBlockPropertyValueV2Contract => ({
  kind: "choice",
  value,
});

const fieldValue = (field: string): SourceBlockPropertyValueV2Contract => ({
  kind: "field_reference",
  field,
});

const groupValue = (
  properties: Record<string, SourceBlockPropertyValueV2Contract>,
): SourceBlockPropertyValueV2Contract => ({ kind: "group", properties });

const listValue = (
  items: SourceBlockPropertyValueV2Contract[],
): SourceBlockPropertyValueV2Contract => ({ kind: "list", items });

const pageName = (value: string): string => {
  let name = "";
  for (const character of value) {
    if (name.length + character.length > 60) break;
    name += character;
  }
  return name;
};

type SourcePlacementSlot = ReturnType<typeof sourcePlacementSlotV2Schema.parse>;
type SourcePlacement = SourcePlacementSlot["placements"][string];

const findPlacement = (slot: SourcePlacementSlot, alias: string): SourcePlacement | undefined => {
  const direct = slot.placements[alias];
  if (direct !== undefined) return direct;
  for (const placement of Object.values(slot.placements)) {
    for (const child of Object.values(placement.slots)) {
      const found = findPlacement(child, alias);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const withAuthoredPageOverride = (
  kind: ModuleGeneratedPageKind,
  generated: SourcePageDefinitionV2,
  authored: SourcePageDefinitionV2 | undefined,
  boundForm?: Readonly<{ alias: string; blockId: string; releaseVersion: string }>,
): SourcePageDefinitionV2 => {
  if (authored === undefined) return generated;
  const parsed = sourcePageDefinitionV2Schema.parse(authored);
  const expectedType = kind === "list" || kind === "detail" ? kind : "form";
  if (
    parsed.id !== generated.id ||
    parsed.key !== generated.key ||
    parsed.type !== expectedType
  )
    throw new ModulePageGeneratorError(
      "authored_page_identity_changed",
      `The authored '${kind}' page override must retain generated id '${generated.id}', key '${generated.key}', and type '${expectedType}'`,
    );
  if (boundForm !== undefined && parsed.type === "form") {
    const rootSlots =
      parsed.composition.shell_kind === "default"
        ? [parsed.composition.main]
        : Object.values(parsed.composition.content);
    const form = rootSlots.map((slot) => findPlacement(slot, boundForm.alias)).find(Boolean);
    if (
      form?.block.block_id !== boundForm.blockId ||
      form.block.release_version !== boundForm.releaseVersion
    )
      throw new ModulePageGeneratorError(
        "authored_page_identity_changed",
        `The authored '${kind}' page must retain its generated submit form '${boundForm.alias}' and block release`,
      );
  }
  return parsed;
};

const slot = (placements: Readonly<Record<string, unknown>>, order: readonly string[]) => ({
  placements,
  order: { desktop: [...order] },
});

const responsive = {
  desktop: {
    visible: true,
    width: { kind: "fill" },
    height: { kind: "content" },
  },
} as const;

const placement = (
  release: ReturnType<typeof latestRelease>,
  settings: Readonly<Record<string, SourceBlockPropertyValueV2Contract>>,
  slots: Readonly<Record<string, ReturnType<typeof slot>>> = {},
  query?: string,
) => ({
  block: { block_id: release.blockId, release_version: release.releaseVersion },
  ...(query === undefined ? {} : { query }),
  settings: { ...settings },
  theme_overrides: {},
  responsive,
  slots: { ...slots },
});

const freezeRecursively = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeRecursively(child);
  return Object.freeze(value);
};

const flowValueReference = (name: string) => ({
  kind: "reference" as const,
  reference: { source: "input" as const, name },
});

/**
 * Generates list, detail, create and edit page fragments using the exact current Module Query,
 * Flow, Definition and platform component contracts. The returned pages are ordinary editable
 * Application source; no generator marker, runtime route, renderer or permission is introduced.
 */
export const generateModulePageFragments = (
  input: ModulePageGeneratorInput,
): ModulePageFragments => {
  const module = moduleDraftV3Schema.parse(input.module);
  const catalogue = immutablePlatformBlockCatalogueV2Schema.parse(input.catalogue);
  const recordTypeId = recordTypeIdSchema.parse(input.recordTypeId);
  const listQueryId = queryIdSchema.parse(input.listQueryId);
  const permissions = {
    read: namespacedKeySchema.parse(input.permissions.read),
    create: namespacedKeySchema.parse(input.permissions.create),
    update: namespacedKeySchema.parse(input.permissions.update),
  };

  const recordType = module.content.recordTypes.find(
    (candidate) => String(candidate.recordTypeId).toLowerCase() === String(recordTypeId).toLowerCase(),
  );
  if (recordType === undefined)
    throw new ModulePageGeneratorError(
      "record_type_missing",
      `Module '${module.envelope.key}' has no record type '${recordTypeId}'`,
    );

  const missingActions = (["read", "create", "update"] as const).filter(
    (action) => !recordType.standardActions.includes(action),
  );
  if (missingActions.length > 0)
    throw new ModulePageGeneratorError(
      "unsupported_record_actions",
      `Record type '${recordType.key}' must declare read, create and update for all four generated pages`,
    );

  const query = module.content.queries.find(
    (candidate) => String(candidate.queryId).toLowerCase() === String(listQueryId).toLowerCase(),
  );
  if (query === undefined || !matchesRecordType(query, module, recordType))
    throw new ModulePageGeneratorError(
      "list_query_missing",
      `Query '${listQueryId}' must belong to record type '${recordType.key}' in this Module`,
    );
  if (query.inputs.length > 0 || !query.selectedFieldIds.includes(recordType.titleFieldId))
    throw new ModulePageGeneratorError(
      "list_query_not_usable",
      `Query '${query.key}' must have no inputs and must select the record title field`,
    );

  const supportedFields = recordType.fields.filter((field) =>
    supportedFieldInputTypes.has(field.type),
  );
  const unsupportedRequiredFields = recordType.fields.filter(
    (field) => field.required && !supportedFieldInputTypes.has(field.type),
  );
  if (unsupportedRequiredFields.length > 0)
    throw new ModulePageGeneratorError(
      "unsupported_required_field",
      `Required fields have no current automatic input control: ${unsupportedRequiredFields
        .map((field) => `${field.key} (${field.type})`)
        .join(", ")}`,
    );
  if (supportedFields.length === 0)
    throw new ModulePageGeneratorError(
      "no_editable_fields",
      `Record type '${recordType.key}' has no fields supported by the current automatic field input`,
    );

  const tableRelease = latestRelease(catalogue, "platform.display.table");
  const detailRelease = latestRelease(catalogue, "platform.display.record_detail");
  const fieldInputRelease = latestRelease(catalogue, "platform.form.field_input");
  const formRelease = latestRelease(catalogue, "platform.form.container");
  const buttonRelease = latestRelease(catalogue, "platform.action.button");
  const totalInputs = supportedFields.length;
  const maximumFormFields = catalogue.compositionPolicy.maximumPlacements - 2;
  if (totalInputs > maximumFormFields)
    throw new ModulePageGeneratorError(
      "composition_policy_too_small",
      `The catalogue permits ${catalogue.compositionPolicy.maximumPlacements} placements per page, but each generated form needs ${totalInputs + 2}`,
    );

  const fieldsById = new Map(recordType.fields.map((field) => [String(field.fieldId), field]));
  const queryFields = query.selectedFieldIds.map((fieldId) => fieldsById.get(String(fieldId)));
  if (queryFields.some((field) => field === undefined))
    throw new ModulePageGeneratorError(
      "list_query_not_usable",
      `Query '${query.key}' selects a field outside record type '${recordType.key}'`,
    );
  const selectedFields = queryFields as ModuleFieldV3[];
  const titleField = fieldsById.get(String(recordType.titleFieldId));
  if (titleField === undefined)
    throw new ModulePageGeneratorError(
      "record_type_missing",
      `Record type '${recordType.key}' does not contain its declared title field`,
    );
  const displayFields = [
    titleField,
    ...selectedFields.filter((field) => field.fieldId !== titleField.fieldId),
  ].slice(0, 50);
  const detailFields = [
    titleField,
    ...recordType.fields.filter((field) => field.fieldId !== titleField.fieldId),
  ].slice(0, 100);

  const queryReference = `${module.envelope.key}:${query.key}`;
  const recordTypeReference = `${module.envelope.key}:${recordType.key}`;
  const listPageId = sourceIdentity(module, recordType, "list");
  const detailPageId = sourceIdentity(module, recordType, "detail");
  const createPageId = sourceIdentity(module, recordType, "create");
  const editPageId = sourceIdentity(module, recordType, "edit");
  const listKey = builderIdentity(listPageId, "list");
  const detailKey = builderIdentity(detailPageId, "detail");
  const createKey = builderIdentity(createPageId, "create");
  const editKey = builderIdentity(editPageId, "edit");
  const formTaskVersion = flowTaskRegistry["record.save"].version;

  const listPlacementId = sourceIdentity(module, recordType, "list_table");
  const listPlacement = placement(
    tableRelease,
    {
      title: textValue(recordType.pluralLabel),
      columns: listValue(
        displayFields.map((field) =>
          groupValue({ field: fieldValue(fieldReference(module, recordType, field)) }),
        ),
      ),
    },
    {},
    queryReference,
  );
  const listPage = sourcePageDefinitionV2Schema.parse({
    id: listPageId,
    key: listKey,
    name: pageName(recordType.pluralLabel),
    type: "list",
    record_type: recordTypeReference,
    permission: permissions.read,
    query: queryReference,
    composition: {
      shell_kind: "default",
      main: slot({ [listPlacementId]: listPlacement }, [listPlacementId]),
    },
  });

  const detailPlacementId = sourceIdentity(module, recordType, "detail_record");
  const detailPlacement = placement(detailRelease, {
    title: textValue(`${recordType.singularLabel} details`),
    detail_fields: listValue(
      detailFields.map((field) =>
        groupValue({ field: fieldValue(fieldReference(module, recordType, field)) }),
      ),
    ),
  });
  const detailPage = sourcePageDefinitionV2Schema.parse({
    id: detailPageId,
    key: detailKey,
    name: pageName(`${recordType.singularLabel} details`),
    type: "detail",
    record_type: recordTypeReference,
    permission: permissions.read,
    composition: {
      shell_kind: "default",
      main: slot({ [detailPlacementId]: detailPlacement }, [detailPlacementId]),
    },
  });

  const makeForm = (kind: "create" | "edit") => {
    const pageId = kind === "create" ? createPageId : editPageId;
    const pageKey = kind === "create" ? createKey : editKey;
    const permission = kind === "create" ? permissions.create : permissions.update;
    const formPlacementId = sourceIdentity(module, recordType, `${kind}_form`);
    const submitButtonId = sourceIdentity(module, recordType, `${kind}_submit_button`);
    const fieldPlacements = supportedFields.map((field) => {
      const id = sourceIdentity(module, recordType, `${kind}_field_${compactId(String(field.fieldId))}`);
      return [
        id,
        placement(fieldInputRelease, {
          field: fieldValue(fieldReference(module, recordType, field)),
        }),
      ] as const;
    });
    const submitButton = placement(buttonRelease, {
      label: textValue(kind === "create" ? "Create" : "Save changes"),
      action_kind: choiceValue("submit"),
      variant: choiceValue("primary"),
    });
    const childPlacements = Object.fromEntries([
      ...fieldPlacements,
      [submitButtonId, submitButton] as const,
    ]);
    const form = placement(
      formRelease,
      { title: textValue(`${kind === "create" ? "Create" : "Edit"} ${recordType.singularLabel}`) },
      {
        content: slot(childPlacements, [...fieldPlacements.map(([id]) => id), submitButtonId]),
      },
    );
    const page = sourcePageDefinitionV2Schema.parse({
      id: pageId,
      key: pageKey,
      name: pageName(`${kind === "create" ? "New" : "Edit"} ${recordType.singularLabel}`),
      type: "form",
      record_type: recordTypeReference,
      permission,
      composition: {
        shell_kind: "default",
        main: slot({ [formPlacementId]: form }, [formPlacementId]),
      },
    });

    const flowId = sourceIdentity(module, recordType, `${kind}_save_flow`);
    const flowKey = builderIdentity(flowId, `${kind}_save`);
    const eventId = sourceIdentity(module, recordType, `${kind}_submit_event`);
    const event: SourceApplicationEvent = {
      id: eventId,
      key: `vortex.app.events.${builderIdentity(eventId, `${kind}_submit`)}`,
      record_type: recordTypeReference,
      carries: [],
      personal_or_sensitive_values_allowed: false,
    };
    const groupOwnedCreate = kind === "create" && recordType.ownershipMode === "group";
    const flow = sourceFlowSchema.parse({
      contractVersion: flowContractVersion,
      id: flowId,
      key: flowKey,
      description: `Save a ${recordType.singularLabel} through the Record service`,
      labels: {},
      execution: "interactive",
      runAs: { kind: "initiator" },
      inputs: {
        ...(kind === "edit"
          ? {
              record: {
                type: "record_reference",
                recordTypeIds: [recordTypeReference],
                required: true,
              },
            }
          : {}),
        values: { type: "json", required: true },
        ...(groupOwnedCreate
          ? { selected_owner_group_id: { type: "text", required: true } }
          : {}),
      },
      variables: {},
      triggers: [],
      tasks: [
        {
          id: "save",
          type: "record.save",
          version: formTaskVersion,
          properties: {
            record_type: {
              kind: "literal",
              literal: { type: "text", value: recordTypeReference },
            },
            ...(kind === "edit" ? { record: flowValueReference("record") } : {}),
            values: flowValueReference("values"),
            ...(groupOwnedCreate
              ? { selected_owner_group_id: flowValueReference("selected_owner_group_id") }
              : {}),
          },
        },
      ],
      outputs: {},
      errors: [],
      finally: [],
    });
    const flowBinding = sourceComponentFlowBindingSchema.parse({
      id: sourceIdentity(module, recordType, `${kind}_submit_binding`),
      control: formPlacementId,
      event_id: eventId,
      event: "form_submit",
      flow: flowId,
      inputs: {
        ...(kind === "edit" ? { record: { kind: "caller", name: "record" } } : {}),
        values: { kind: "caller", name: "values" },
        ...(groupOwnedCreate
          ? { selected_owner_group_id: { kind: "caller", name: "selected_owner_group_id" } }
          : {}),
      },
    });
    return { page, event, flow, flowBinding };
  };

  const create = makeForm("create");
  const edit = makeForm("edit");
  const pages = [
    withAuthoredPageOverride("list", listPage, input.authoredPageOverrides?.list),
    withAuthoredPageOverride("detail", detailPage, input.authoredPageOverrides?.detail),
    withAuthoredPageOverride("create", create.page, input.authoredPageOverrides?.create, {
      alias: create.flowBinding.control,
      blockId: formRelease.blockId,
      releaseVersion: formRelease.releaseVersion,
    }),
    withAuthoredPageOverride("edit", edit.page, input.authoredPageOverrides?.edit, {
      alias: edit.flowBinding.control,
      blockId: formRelease.blockId,
      releaseVersion: formRelease.releaseVersion,
    }),
  ];
  const usedReleases = new Map<string, (typeof catalogue.releases)[number]>();
  for (const page of pages) {
    const rootSlots =
      page.composition.shell_kind === "default"
        ? [page.composition.main]
        : Object.values(page.composition.content);
    for (const rootSlot of rootSlots)
      for (const [, placed] of sourcePlacementEntriesV2(rootSlot)) {
        const release = catalogue.releases.find(
          (candidate) =>
            candidate.blockId === placed.block.block_id &&
            candidate.releaseVersion === placed.block.release_version,
        );
        if (release === undefined)
          throw new ModulePageGeneratorError(
            "catalogue_release_missing",
            `The supplied platform catalogue has no release '${placed.block.block_id}@${placed.block.release_version}'`,
          );
        usedReleases.set(`${release.blockId}@${release.releaseVersion}`, release);
      }
  }
  const dependencies = sourcePlatformBlockDependenciesV2Schema.parse(
    [...usedReleases.values()]
      .map((release) => ({
        kind: "platform_block",
        block_id: release.blockId,
        release_version: release.releaseVersion,
        content_fingerprint: release.contentFingerprint,
        catalogue_fingerprint: release.catalogueFingerprint,
      }))
      .sort(
        (left, right) =>
          compareText(left.block_id, right.block_id) ||
          compareText(left.release_version, right.release_version),
      ),
  );

  return freezeRecursively({
    pages,
    events: [create.event, edit.event],
    flows: [create.flow, edit.flow],
    flow_bindings: [create.flowBinding, edit.flowBinding],
    platform_block_dependencies: dependencies,
  });
};
