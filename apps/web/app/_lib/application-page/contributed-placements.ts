import { createHash } from "node:crypto";
import {
  FIELD_INPUT_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  automaticFieldInputSettings,
  fieldInputSourceField,
  type InstalledRuntimeContext,
} from "@vortex/platform/server";
import { isRecord, sameId } from "@vortex/platform/schema";
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
  const subject = pageDefinition.recordType;
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
 * The page the viewer's projection becomes once the fields other installed Modules contributed to
 * its record type are placed on it: every Record detail of the page's record is extended by the
 * contributed fields, and every edit form of the page's record gets a field input for each. A
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
  const contributed = owner.fields.flatMap((entry) => {
    const field = owner.recordTypeFields.find((candidate) =>
      sameId(String(candidate.fieldId), entry.fieldId),
    );
    return field === undefined ? [] : [field];
  });
  if (contributed.length === 0) return projected;

  const page = structuredClone(projected) as Record<string, unknown>;
  const application = context.releaseSet.application;
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

  if (pageDefinition.type === "form") {
    const placements = collectPlacements(page);
    const editForms = placements.filter(({ placementId, vortex }) => {
      const block = blockIdOf(vortex);
      return (
        block !== undefined &&
        sameId(block, FORM_CONTAINER_BLOCK_RELEASE.blockId) &&
        application.content.flowBindings.some(
          (binding) =>
            sameId(binding.controlId, placementId) &&
            binding.event === "form_submit" &&
            Object.values(binding.flow.inputs).some(
              (input) => isRecord(input) && input.kind === "caller" && input.name === "record",
            ),
        )
      );
    });
    for (const form of editForms) {
      const content = form.props.content;
      if (!Array.isArray(content)) continue;
      const inputs = content.filter(
        (item) =>
          isRecord(item) &&
          isRecord(item.props) &&
          isEditFieldPlacement({
            vortex: isRecord(item.props.vortex) ? item.props.vortex : {},
            props: item.props,
            settings: {},
          }),
      );
      const last = inputs.at(-1);
      if (!isRecord(last) || !isRecord(last.props) || !isRecord(last.props.vortex)) continue;
      const shownFields = new Set(
        placements
          .filter((placement) => placement.formId !== undefined && sameId(placement.formId, form.placementId))
          .flatMap((placement) =>
            isRecord(placement.settings.field) &&
            placement.settings.field.kind === "field_reference" &&
            typeof placement.settings.field.fieldId === "string"
              ? [placement.settings.field.fieldId.toLowerCase()]
              : [],
          ),
      );
      const orders = isRecord(form.vortex.slotOrders) && isRecord(form.vortex.slotOrders.content)
        ? form.vortex.slotOrders.content
        : undefined;
      let anchor = String(last.props.id);
      let insertAt = content.indexOf(last) + 1;
      for (const field of contributed) {
        const fieldId = String(field.fieldId);
        if (shownFields.has(fieldId.toLowerCase())) continue;
        const source = fieldInputSourceField(field as unknown as Record<string, unknown>);
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
        content.splice(insertAt, 0, {
          type: FIELD_INPUT_BLOCK_RELEASE.rendererKey,
          props: {
            id,
            ...settings,
            vortex: {
              block: {
                blockId: FIELD_INPUT_BLOCK_RELEASE.blockId,
                releaseVersion: FIELD_INPUT_BLOCK_RELEASE.releaseVersion,
              },
              responsive: structuredClone((last.props.vortex as Record<string, unknown>).responsive),
              slotOrders: {},
            },
          },
        });
        insertAt += 1;
        if (orders !== undefined)
          for (const breakpoint of ["tablet", "phone"] as const) {
            const order = orders[breakpoint];
            if (Array.isArray(order)) {
              const at = order.indexOf(anchor);
              order.splice(at < 0 ? order.length : at + 1, 0, id);
            }
          }
        anchor = id;
        changed = true;
      }
    }
  }
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
