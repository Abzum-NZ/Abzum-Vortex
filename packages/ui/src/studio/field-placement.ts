import {
  applicationSourceDocumentSchema,
  changeableByPeople,
  sourceItemTree,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type SourceBlockPropertyValueContract,
  type SourceItem,
} from "@vortex/platform/schema";
import {
  applyStudioCompositionCommand,
  describeStudioCompositionAddTargets,
  describeStudioCompositionSettings,
  type StudioCompositionContext,
} from "./application-composition-commands";

/**
 * "Also show it on": the places a new field can be shown in the same draft edit that adds it. A
 * place is a block on one of its record type's detail, list or form pages that holds a list of
 * fields (detail fields, table columns, card details), or a form on a form page, which takes an
 * input for the field. Every placement goes through the one composition command path: a list
 * entry is a settings command, a form input is an add command.
 */
export type StudioFieldPlacement = Readonly<{
  id: string;
  pageAlias: string;
  /** "Contact detail page: Contact detail, Detail fields". */
  label: string;
  kind: "list_entry" | "form_input";
  placementAlias: string;
  /** The list setting a list entry is appended to. */
  settingKey?: string;
  /** Why the field cannot be shown here, when it cannot. */
  unavailable?: string;
}>;

type Release = StudioCompositionContext["catalogue"]["releases"][number];
const formContainerKey = "platform.form.container";
const fieldInputKey = "platform.form.field_input";
/** The field types an automatic field input renders: the others are not offered on forms. */
const formInputTypes: ReadonlySet<string> = new Set([
  "text",
  "email_address",
  "phone_number",
  "web_address",
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
  "table",
  "attachment",
]);
const pageTypeWords: Readonly<Record<string, string>> = {
  detail: "Detail page",
  list: "List page",
  form: "Form page",
};

const releaseOf = (context: StudioCompositionContext, item: SourceItem): Release | undefined => {
  const block = item.props.vortex.block;
  return context.catalogue.releases.find(
    (release) =>
      release.blockId === block.block_id && release.releaseVersion === block.release_version,
  );
};

/** The list settings of a release whose entries each show one field. */
const fieldListSettings = (
  release: Release,
): readonly Extract<BlockPropertySchemaContract, { kind: "list" }>[] =>
  release.properties.flatMap((property) =>
    property.kind === "list" &&
    property.item.kind === "group" &&
    property.item.properties.some((nested) => nested.kind === "field_reference")
      ? [property]
      : [],
  );

const blockTitle = (item: SourceItem, release: Release): string => {
  const title = item.props.title;
  return typeof title === "string" && title.trim() !== "" ? title : release.name;
};

/** Every place on the record type's detail, list and form pages a new field of this type can be shown. */
export const studioFieldPlacements = (
  context: StudioCompositionContext,
  moduleKey: string,
  recordKey: string,
  fieldType: string,
): readonly StudioFieldPlacement[] => {
  const qualified = `${moduleKey}:${recordKey}`;
  const result: StudioFieldPlacement[] = [];
  for (const page of context.source.body.pages) {
    if (
      !("record_type" in page) ||
      page.record_type !== qualified ||
      (page.type !== "detail" && page.type !== "list" && page.type !== "form")
    )
      continue;
    const pageLabel = `${pageTypeWords[page.type]} ${page.name}`;
    for (const at of sourcePageSlotAddresses(page)) {
      const zone = sourcePageSlotAt(page, at);
      if (zone === undefined) continue;
      for (const item of sourceItemTree(zone.items)) {
        const release = releaseOf(context, item);
        if (release === undefined) continue;
        for (const setting of fieldListSettings(release))
          result.push({
            id: `${page.id}|${item.props.id}|${setting.key}`,
            pageAlias: page.id,
            kind: "list_entry",
            placementAlias: item.props.id,
            settingKey: setting.key,
            label: `${pageLabel}: ${blockTitle(item, release)}, ${setting.label}`,
          });
        if (page.type === "form" && release.key === formContainerKey)
          result.push({
            id: `${page.id}|${item.props.id}|input`,
            pageAlias: page.id,
            kind: "form_input",
            placementAlias: item.props.id,
            label: `${pageLabel}: ${blockTitle(item, release)}, a new input`,
            ...(formInputTypes.has(fieldType) && changeableByPeople({ type: fieldType as never })
              ? {}
              : { unavailable: "Forms have no input for this type of field." }),
          });
      }
    }
  }
  return result;
};

/** The entry that shows the field in one list setting: its field, its label, and nothing else that is required. */
const listEntry = (
  setting: Extract<BlockPropertySchemaContract, { kind: "list" }>,
  reference: string,
  label: string,
): SourceBlockPropertyValueContract | string => {
  if (setting.item.kind !== "group") return `${setting.label} does not hold fields`;
  const properties: Record<string, SourceBlockPropertyValueContract> = {};
  for (const property of setting.item.properties) {
    if (property.kind === "field_reference")
      properties[property.key] = { kind: "field_reference", field: reference };
    else if (property.key === "label" && property.kind === "text")
      properties.label = { kind: "text", value: label };
    else if (property.required && property.defaultValue === undefined)
      return `each entry of ${setting.label} also needs its ${property.label}, which you set on the page`;
  }
  return { kind: "group", properties };
};

/** The query a block reads gains the field among the fields it selects, when the query is this application's. */
const selectInQuery = (
  source: ApplicationSourceDocument,
  query: string,
  fieldKey: string,
): ApplicationSourceDocument | string => {
  const separator = query.indexOf(":");
  const next = structuredClone(source);
  const owner = next.body.modules.find((module) => module.key === query.slice(0, separator));
  const target = owner?.queries.find((candidate) => candidate.key === query.slice(separator + 1));
  if (target === undefined)
    return "its data comes from a query of another application, which is changed there";
  if (!(target.select as string[]).includes(fieldKey)) (target.select as string[]).push(fieldKey);
  return applicationSourceDocumentSchema.parse(next);
};

/**
 * The draft with the field shown at each chosen place, in order, or every reason a chosen place
 * refused it. Nothing is applied unless every chosen place takes the field.
 */
export const applyStudioFieldPlacements = (
  context: StudioCompositionContext,
  field: Readonly<{
    moduleKey: string;
    recordKey: string;
    key: string;
    label: string;
    type: string;
  }>,
  chosen: readonly string[],
):
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "refused"; reasons: readonly string[] }> => {
  const places = studioFieldPlacements(context, field.moduleKey, field.recordKey, field.type);
  const reference = `${field.moduleKey}:${field.recordKey}.${field.key}`;
  let source = context.source;
  const reasons: string[] = [];
  for (const id of chosen) {
    const place = places.find((candidate) => candidate.id === id);
    if (place === undefined) {
      reasons.push("A place you chose is not on the page any more.");
      continue;
    }
    if (place.unavailable !== undefined) {
      reasons.push(`${place.label}: ${place.unavailable}`);
      continue;
    }
    const current: StudioCompositionContext = { ...context, source };
    const selection = { kind: "placement", placementAlias: place.placementAlias } as const;
    if (place.kind === "list_entry") {
      const model = describeStudioCompositionSettings(current, selection);
      if (model.kind !== "available") {
        reasons.push(`${place.label}: this block's settings can't be changed here.`);
        continue;
      }
      const setting = model.properties.find((property) => property.key === place.settingKey);
      if (setting?.kind !== "list") {
        reasons.push(`${place.label}: the block has no such list.`);
        continue;
      }
      const entry = listEntry(setting, reference, field.label);
      if (typeof entry === "string") {
        reasons.push(`${place.label}: ${entry}.`);
        continue;
      }
      const existing = model.settings[setting.key];
      const items = existing?.kind === "list" ? existing.items : [];
      if (
        items.some(
          (item) =>
            item.kind === "group" &&
            Object.values(item.properties).some(
              (value) => value.kind === "field_reference" && value.field === reference,
            ),
        )
      )
        continue;
      if (items.length >= setting.maximumItems) {
        reasons.push(`${place.label}: the list is full.`);
        continue;
      }
      let withQuery = current;
      if (model.query !== null) {
        const selected = selectInQuery(source, model.query, field.key);
        if (typeof selected === "string") {
          reasons.push(`${place.label}: ${selected}.`);
          continue;
        }
        withQuery = { ...current, source: selected };
      }
      const result = applyStudioCompositionCommand(withQuery, withQuery, selection, {
        kind: "settings",
        settings: { ...model.settings, [setting.key]: { kind: "list", items: [...items, entry] } },
        query: model.query,
      });
      if (result.kind === "applied") source = result.source;
      else
        reasons.push(
          `${place.label}: ${result.kind === "refused" ? result.reason : "the block did not take the field."}`,
        );
    } else {
      const targets = describeStudioCompositionAddTargets(current, place.pageAlias);
      const target =
        targets.kind === "available"
          ? targets.targets.find(
              (candidate) =>
                candidate.destination.kind === "child" &&
                candidate.destination.parentAlias === place.placementAlias &&
                candidate.destination.slotKey === "content",
            )
          : undefined;
      const input = target?.choices.find((choice) => choice.key === fieldInputKey);
      if (target === undefined || input === undefined) {
        reasons.push(`${place.label}: the form does not take new inputs.`);
        continue;
      }
      const page = source.body.pages.find((candidate) => candidate.id === place.pageAlias);
      const form =
        page === undefined
          ? undefined
          : sourcePageSlotAddresses(page)
              .flatMap((at) => sourceItemTree(sourcePageSlotAt(page, at)?.items ?? []))
              .find((item) => item.props.id === place.placementAlias);
      const content = (form?.props.content ?? []) as SourceItem[];
      if (content.some((item) => item.props.field === reference)) continue;
      // The input goes above the form's Save button, after the inputs already there.
      const submit = content.findIndex((item) => item.props.action_kind === "submit");
      const result = applyStudioCompositionCommand(current, current, null, {
        kind: "add",
        pageAlias: place.pageAlias,
        area: target.area,
        destination: target.destination,
        index: submit < 0 ? content.length : submit,
        blockId: input.blockId,
        releaseVersion: input.releaseVersion,
        settings: { field: { kind: "field_reference", field: reference } },
        query: null,
      });
      if (result.kind === "applied") source = result.source;
      else
        reasons.push(
          `${place.label}: ${result.kind === "refused" ? result.reason : "the form did not take the input."}`,
        );
    }
  }
  return reasons.length > 0 ? { kind: "refused", reasons } : { kind: "applied", source };
};
