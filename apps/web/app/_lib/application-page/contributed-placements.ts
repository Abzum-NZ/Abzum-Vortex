import { createHash, randomUUID } from "node:crypto";
import {
  BUTTON_BLOCK_RELEASE,
  FIELD_INPUT_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  automaticFieldInputSettings,
  collectActionFlowTasks,
  contributedActionControlIds,
  fieldInputSourceField,
  flowPlansOf,
  plainReleaseDefaults,
  type ActionFlowRunner,
  type InstalledRuntimeContext,
  type NamedActionAvailability,
} from "@vortex/platform/server";
import { installedNamedActionReferenceSchema, isRecord, sameId } from "@vortex/platform/schema";
import { collectPlacements, isEditFieldPlacement } from "./placement-helpers";

type Application = InstalledRuntimeContext["releaseSet"]["application"];
type PageDefinition = Application["content"]["pages"][number];
type OwnerFields = InstalledRuntimeContext["recordContributions"][number]["fields"];
type RecordTypeFields =
  InstalledRuntimeContext["releaseSet"]["modules"][number]["content"]["recordTypes"][number]["fields"];

/** The id a contributed placement takes: stable for one form and field, a valid RFC 9562 UUID. */
const contributedPlacementId = (hostId: string, fieldId: string): string => {
  const bytes = createHash("sha256")
    .update(`contributed-placement:${hostId.toLowerCase()}:${fieldId.toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The owner record type this page is about, with the fields other installed Modules added to it. */
const contributedFieldsOf = (
  context: InstalledRuntimeContext,
  pageDefinition: PageDefinition,
): Readonly<{ fields: OwnerFields; recordTypeFields: RecordTypeFields }> | undefined => {
  if (
    (pageDefinition.type !== "detail" && pageDefinition.type !== "form") ||
    pageDefinition.recordType?.state !== "resolved"
  )
    return undefined;
  return contributedFieldsFor(context, pageDefinition.recordType);
};

const contributedFieldsFor = (
  context: InstalledRuntimeContext,
  subject: Readonly<{ moduleRootId: string; recordTypeId: string }>,
): Readonly<{ fields: OwnerFields; recordTypeFields: RecordTypeFields }> | undefined => {
  const contributed = context.recordContributions.find(
    (entry) =>
      sameId(entry.moduleRootId, String(subject.moduleRootId)) &&
      sameId(entry.recordTypeId, String(subject.recordTypeId)),
  );
  const recordType = context.releaseSet.modules
    .find((module) => sameId(String(module.rootId), String(subject.moduleRootId)))
    ?.content.recordTypes.find((candidate) =>
      sameId(String(candidate.recordTypeId), String(subject.recordTypeId)),
    );
  return contributed === undefined || recordType === undefined
    ? undefined
    : { fields: contributed.fields, recordTypeFields: recordType.fields };
};

const installedContributedFields = (owner: {
  fields: OwnerFields;
  recordTypeFields: RecordTypeFields;
}) =>
  owner.fields.flatMap((entry) => {
    const field = owner.recordTypeFields.find((candidate) =>
      sameId(String(candidate.fieldId), entry.fieldId),
    );
    return field === undefined ? [] : [field];
  });

/** The identities of the fields contributed to the record type this page is about. */
export const contributedFieldIdsOf = (
  context: InstalledRuntimeContext,
  pageDefinition: PageDefinition,
): ReadonlySet<string> =>
  new Set(
    (contributedFieldsOf(context, pageDefinition)?.fields ?? []).map((field) =>
      field.fieldId.toLowerCase(),
    ),
  );

const blockIdOf = (vortex: Record<string, unknown>): string | undefined =>
  isRecord(vortex.block) && typeof vortex.block.blockId === "string"
    ? vortex.block.blockId
    : undefined;

/**
 * Places `item` directly after the placement `anchorId` in the item list that holds it, and in the
 * tablet and phone orders of that list's owner, so the new item takes the anchor's place in every
 * layout. False when no list holds the anchor.
 */
const insertAfterPlacement = (
  page: Record<string, unknown>,
  anchorId: string,
  item: Record<string, unknown>,
): boolean => {
  const insertInto = (
    items: unknown[],
    owner: Record<string, unknown>,
    slotKey: string,
  ): boolean => {
    const at = items.findIndex(
      (entry) =>
        isRecord(entry) && isRecord(entry.props) && sameId(String(entry.props.id), anchorId),
    );
    if (at >= 0) {
      items.splice(at + 1, 0, item);
      const orders =
        isRecord(owner.vortex) && isRecord(owner.vortex.slotOrders)
          ? owner.vortex.slotOrders[slotKey]
          : undefined;
      if (isRecord(orders))
        for (const breakpoint of ["tablet", "phone"] as const) {
          const order = orders[breakpoint];
          if (Array.isArray(order)) {
            const position = order.findIndex((entry) => sameId(String(entry), anchorId));
            order.splice(
              position < 0 ? order.length : position + 1,
              0,
              String((item.props as Record<string, unknown>).id),
            );
          }
        }
      return true;
    }
    return items.some(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.props) &&
        Object.entries(entry.props).some(
          ([key, value]) =>
            Array.isArray(value) && insertInto(value, entry.props as Record<string, unknown>, key),
        ),
    );
  };
  const visitData = (data: unknown): boolean => {
    if (!isRecord(data)) return false;
    const root = isRecord(data.root) && isRecord(data.root.props) ? data.root.props : undefined;
    if (
      root !== undefined &&
      Object.entries(root).some(
        ([key, value]) => key !== "vortex" && Array.isArray(value) && insertInto(value, root, key),
      )
    )
      return true;
    return Array.isArray(data.content) && insertInto(data.content, root ?? {}, "content");
  };
  const composition = page.composition;
  if (!isRecord(composition)) return false;
  return isRecord(composition.stepContent)
    ? Object.values(composition.stepContent).some(visitData)
    : visitData(composition);
};

/**
 * Places `item` at the end of a form's own content, and of that content's tablet and phone orders.
 * False when the form holds no content list.
 */
const appendToFormContent = (
  formProps: Record<string, unknown>,
  formVortex: Record<string, unknown>,
  item: Record<string, unknown>,
): boolean => {
  const content = formProps.content;
  if (!Array.isArray(content)) return false;
  content.push(item);
  const orders = isRecord(formVortex.slotOrders) ? formVortex.slotOrders.content : undefined;
  if (isRecord(orders))
    for (const breakpoint of ["tablet", "phone"] as const) {
      const order = orders[breakpoint];
      if (Array.isArray(order)) order.push(String((item.props as Record<string, unknown>).id));
    }
  return true;
};

/** Inserts the same contributed field inputs for a form and its proven record type. */
const insertContributedFormFields = (
  page: Record<string, unknown>,
  context: InstalledRuntimeContext,
  contributed: RecordTypeFields,
  formId?: string,
): boolean => {
  const application = context.releaseSet.application;
  let changed = false;
  const placements = collectPlacements(page);
  const editForms = placements.filter(({ placementId, vortex }) => {
    const block = blockIdOf(vortex);
    return (
      block !== undefined &&
      (formId === undefined || sameId(placementId, formId)) &&
      sameId(block, FORM_CONTAINER_BLOCK_RELEASE.blockId) &&
      (formId !== undefined ||
        application.content.flowBindings.some(
          (binding) =>
            sameId(binding.controlId, placementId) &&
            binding.event === "form_submit" &&
            Object.values(binding.flow.inputs).some(
              (input) => isRecord(input) && input.kind === "caller" && input.name === "record",
            ),
        ))
    );
  });
  for (const form of editForms) {
    // Every placement the form holds, at any depth, in document order.
    const held = placements.filter(
      (placement) =>
        placement.formId !== undefined &&
        sameId(placement.formId, form.placementId) &&
        !sameId(placement.placementId, form.placementId),
    );
    // Contributed inputs follow the form's last field input wherever it sits; a form with no
    // field input gets them at the end of its own content.
    const last = held.filter(isEditFieldPlacement).at(-1);
    if (last === undefined && !Array.isArray(form.props.content)) continue;
    const responsive = (last ?? form).vortex.responsive;
    const shownFields = new Set(
      held.flatMap((placement) =>
        isRecord(placement.settings.field) &&
        placement.settings.field.kind === "field_reference" &&
        typeof placement.settings.field.fieldId === "string"
          ? [placement.settings.field.fieldId.toLowerCase()]
          : [],
      ),
    );
    let anchor = last?.placementId;
    for (const field of contributed) {
      const fieldId = String(field.fieldId);
      if (shownFields.has(fieldId.toLowerCase())) continue;
      const source = fieldInputSourceField(
        field as unknown as Record<string, unknown>,
        (parentId) =>
          contributed.find((candidate) => sameId(String(candidate.fieldId), parentId)) as
            Record<string, unknown> | undefined,
      );
      let settings: Record<string, unknown>;
      try {
        if (source === undefined) throw new Error("FIELD_INPUT_SOURCE_UNAVAILABLE");
        settings = automaticFieldInputSettings(fieldId, source);
      } catch (error) {
        // A field no existing input draws exactly stays out of the form; the failure is logged,
        // and the contributed field still reads and writes through its record paths.
        console.error(
          `[page] contributed field ${fieldId} has no form input: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const id = contributedPlacementId(form.placementId, fieldId);
      const item = {
        type: FIELD_INPUT_BLOCK_RELEASE.rendererKey,
        props: {
          id,
          ...settings,
          vortex: {
            block: {
              blockId: FIELD_INPUT_BLOCK_RELEASE.blockId,
              releaseVersion: FIELD_INPUT_BLOCK_RELEASE.releaseVersion,
            },
            responsive: structuredClone(responsive),
            slotOrders: {},
          },
        },
      };
      const placed =
        anchor === undefined
          ? appendToFormContent(form.props, form.vortex, item)
          : insertAfterPlacement(page, anchor, item);
      if (!placed) continue;
      anchor = id;
      changed = true;
    }
  }
  return changed;
};

/** Adds a row form's contributed fields after its query membership has proved the record type. */
export const withContributedFormPlacements = (
  projected: Readonly<Record<string, unknown>>,
  context: InstalledRuntimeContext,
  subject: Readonly<{ moduleRootId: string; recordTypeId: string }>,
  formId: string,
): Readonly<Record<string, unknown>> => {
  const owner = contributedFieldsFor(context, subject);
  if (owner === undefined || owner.fields.length === 0) return projected;
  const contributed = installedContributedFields(owner);
  if (contributed.length === 0) return projected;
  const page = structuredClone(projected) as Record<string, unknown>;
  return insertContributedFormFields(page, context, contributed, formId) ? page : projected;
};

/**
 * The page the viewer's projection becomes once the fields other installed Modules contributed to
 * its record type are placed on it: every Record detail of the page's record is extended by the
 * contributed fields, and every edit form of the page's record gets a field input for each, after
 * the form's last field input at any depth, or at the end of the form's content when it has none. A
 * contributed field is placed exactly as the compiler would place that field, from the same field
 * definition, so it reads and writes through the same display, form, flow and record paths as an
 * authored one; what the viewer may read or change is decided afterwards by the same field policy
 * and the record writer. Returns the projection itself when nothing is contributed, and otherwise a
 * private copy.
 */
export const withContributedPlacements = (
  projected: Readonly<Record<string, unknown>>,
  context: InstalledRuntimeContext,
  pageDefinition: PageDefinition,
): Readonly<Record<string, unknown>> => {
  const owner = contributedFieldsOf(context, pageDefinition);
  if (owner === undefined || owner.fields.length === 0) return projected;
  const contributed = installedContributedFields(owner);
  if (contributed.length === 0) return projected;

  const page = structuredClone(projected) as Record<string, unknown>;
  let changed = false;

  if (pageDefinition.type === "detail") {
    for (const placement of collectPlacements(page)) {
      if (
        blockIdOf(placement.vortex) === undefined ||
        !sameId(blockIdOf(placement.vortex)!, RECORD_DETAIL_BLOCK_RELEASE.blockId) ||
        placement.vortex.queryId !== undefined ||
        !Array.isArray(placement.props.detail_fields)
      )
        continue;
      const shown: unknown[] = placement.props.detail_fields;
      const present = new Set(
        shown.flatMap((entry) =>
          isRecord(entry) && typeof entry.field === "string" ? [entry.field.toLowerCase()] : [],
        ),
      );
      for (const field of contributed) {
        if (present.has(String(field.fieldId).toLowerCase())) continue;
        shown.push({ field: String(field.fieldId), label: field.label, format: "automatic" });
        changed = true;
      }
    }
  }

  if (pageDefinition.type === "form")
    changed = insertContributedFormFields(page, context, contributed) || changed;

  return changed ? page : projected;
};

/**
 * Drops the contributed fields the viewer cannot read from the Record details of a detail page, so
 * a field they have no permission for is left out rather than shown as restricted. `readable` is
 * the identity set of the fields the subject read returned.
 */
export const omitUnreadableContributedFields = (
  page: Record<string, unknown>,
  contributedFieldIds: ReadonlySet<string>,
  readable: ReadonlySet<string>,
): void => {
  if (contributedFieldIds.size === 0) return;
  for (const placement of collectPlacements(page)) {
    if (
      blockIdOf(placement.vortex) === undefined ||
      !sameId(blockIdOf(placement.vortex)!, RECORD_DETAIL_BLOCK_RELEASE.blockId) ||
      !Array.isArray(placement.props.detail_fields)
    )
      continue;
    placement.props.detail_fields = placement.props.detail_fields.filter(
      (entry: unknown) =>
        !(
          isRecord(entry) &&
          typeof entry.field === "string" &&
          contributedFieldIds.has(entry.field.toLowerCase()) &&
          !readable.has(entry.field.toLowerCase())
        ),
    );
  }
};

/** The contributed actions on the record type a detail page is about. */
const contributedActionsOf = (context: InstalledRuntimeContext, pageDefinition: PageDefinition) => {
  if (pageDefinition.type !== "detail" || pageDefinition.recordType?.state !== "resolved")
    return [];
  const subject = pageDefinition.recordType;
  return (
    context.recordContributions.find(
      (entry) =>
        sameId(entry.moduleRootId, String(subject.moduleRootId)) &&
        sameId(entry.recordTypeId, String(subject.recordTypeId)),
    )?.actions ?? []
  );
};

/**
 * The contributed actions the page subject read previews on the page's record, so the one subject
 * read decides the same preview the named action path decides for the person on this exact record
 * (their own permission on the record, the contributor's permission for the action and the
 * action's precondition). Undefined when nothing is contributed to the page's record type.
 */
export const contributedActionPreviews = (
  context: InstalledRuntimeContext,
  pageDefinition: PageDefinition,
) => {
  const actions = contributedActionsOf(context, pageDefinition);
  if (actions.length === 0) return undefined;
  const library = flowPlansOf(context.releaseSet).library;
  return Object.freeze({
    references: actions.map((action) =>
      installedNamedActionReferenceSchema.parse({
        ownerKind: "module",
        ownerId: action.contributorModuleRootId,
        releaseRevision: action.contributorReleaseRevision,
        actionId: action.actionId,
      }),
    ),
    runFor: (action: Readonly<{ actionId: string }>) => (seed: Parameters<ActionFlowRunner>[0]) =>
      collectActionFlowTasks(library, action.actionId, randomUUID(), seed),
  });
};

/**
 * The identities of the contributed actions the viewer may run now, from the availability the page
 * subject read returned. A record the viewer cannot read previews nothing.
 */
export const availableContributedActions = (
  availability: ReadonlyMap<string, NamedActionAvailability> | undefined,
): ReadonlySet<string> => {
  if (availability === undefined) return new Set();
  // A refusal is an ordinary answer (the person may not run the action); only an undecided
  // preview is worth a trace.
  for (const [actionId, entry] of availability)
    if (entry.kind === "undecided")
      console.info(`[page] contributed action ${actionId} availability undecided: ${entry.reason}`);
  return new Set(
    [...availability]
      .filter(([, entry]) => entry.kind === "available")
      .map(([actionId]) => actionId.toLowerCase()),
  );
};

/**
 * Places a button after the page's record detail for each contributed action the viewer may run
 * on the record. The control is the one the compiled binding of that action on this page names,
 * so a click starts the flow the flow endpoint runs, and the named action path decides again.
 */
export const withContributedActionButtons = (
  page: Record<string, unknown>,
  context: InstalledRuntimeContext,
  pageDefinition: PageDefinition,
  available: ReadonlySet<string>,
): boolean => {
  if (pageDefinition.type !== "detail" || pageDefinition.recordType?.state !== "resolved")
    return false;
  const recordTypeId = String(pageDefinition.recordType.recordTypeId);
  const actions = contributedActionsOf(context, pageDefinition).filter((action) =>
    available.has(action.actionId.toLowerCase()),
  );
  if (actions.length === 0) return false;
  const detail = collectPlacements(page).find(
    ({ vortex }) =>
      blockIdOf(vortex) !== undefined &&
      sameId(blockIdOf(vortex)!, RECORD_DETAIL_BLOCK_RELEASE.blockId) &&
      vortex.queryId === undefined,
  );
  if (detail === undefined || !isRecord(detail.vortex.responsive)) return false;
  let anchor = detail.placementId;
  let placed = false;
  for (const action of actions) {
    const ids = contributedActionControlIds(
      String(pageDefinition.pageId),
      recordTypeId,
      action.actionId,
    );
    if (collectPlacements(page).some((entry) => sameId(entry.placementId, ids.controlId))) continue;
    if (
      insertAfterPlacement(page, anchor, {
        type: BUTTON_BLOCK_RELEASE.rendererKey,
        props: {
          id: ids.controlId,
          ...plainReleaseDefaults(BUTTON_BLOCK_RELEASE),
          label: action.label,
          action_kind: "action",
          variant: "secondary",
          vortex: {
            block: {
              blockId: BUTTON_BLOCK_RELEASE.blockId,
              releaseVersion: BUTTON_BLOCK_RELEASE.releaseVersion,
            },
            responsive: structuredClone(detail.vortex.responsive),
            slotOrders: {},
          },
        },
      })
    ) {
      anchor = ids.controlId;
      placed = true;
    }
  }
  return placed;
};

/** Whether anything is contributed to the record type this page is about. */
export const pageHasContributions = (
  context: InstalledRuntimeContext,
  pageDefinition: PageDefinition,
): boolean =>
  contributedFieldsOf(context, pageDefinition) !== undefined ||
  contributedActionsOf(context, pageDefinition).length > 0;
