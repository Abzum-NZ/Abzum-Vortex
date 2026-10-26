import {
  fieldBindingValueType,
  pageBindingFacts,
  peopleDirectory,
  recordPageTypes,
  selectionControlSettingKey,
  sourceItemTree,
  sourcePageItems,
  sourcePageShell,
  tablePublishesRecord,
  type QueryBindingField,
  type QueryBindingPageFacts,
  type QueryBindingPlacement,
} from "@vortex/platform/schema";
import type { StudioCompositionContext } from "./application-composition-commands";
import type { StudioQueryChoice } from "./contextual-palette";

/** Every record type of the draft and each of its fields as a binding sees it, by reference. */
const draftBindingFields = (source: StudioCompositionContext["source"]) => {
  const records = source.body.modules.flatMap((module) =>
    module.record_types.map((record) => ({
      reference: `${module.key}:${record.key}`,
      record,
    })),
  );
  const fields = records.flatMap(({ reference, record }) =>
    record.fields.map((field) => ({
      field: `${reference}.${field.key}`,
      label: field.label,
      type: fieldBindingValueType({
        type: field.type,
        ...("settings" in field &&
        "target" in field.settings &&
        typeof field.settings.target === "string"
          ? { linkTargets: [field.settings.target] }
          : {}),
        ...("settings" in field &&
        "result_type" in field.settings &&
        typeof field.settings.result_type === "string"
          ? { resultType: field.settings.result_type }
          : {}),
      }),
    })),
  );
  return { records, fields };
};

/** The fields of one draft record type a This row binding may name. */
export const studioRecordBindingFields = (
  source: StudioCompositionContext["source"],
  recordType: string,
): readonly QueryBindingField[] =>
  draftBindingFields(source).fields.filter((field) => field.field.startsWith(`${recordType}.`));

/** Source identities stay in the draft's namespace; publication checks their compiled identities. */
export function studioQueryBindingFacts(
  context: StudioCompositionContext,
  placementAlias: string,
  queries: readonly StudioQueryChoice[],
): QueryBindingPageFacts {
  const { source } = context;
  const entries = source.body.pages.map((page) => ({
    page,
    items: [
      ...sourcePageItems(page.composition),
      ...sourceItemTree(
        source.body.shells.find((shell) => shell.id === sourcePageShell(page.composition))?.layout
          .content ?? [],
      ),
    ],
  }));
  const owner = entries.find(({ items }) => items.some((item) => item.props.id === placementAlias));
  const { records, fields } = draftBindingFields(source);
  const subject =
    owner !== undefined && "record_type" in owner.page ? owner.page.record_type : undefined;
  const hasSubject =
    owner !== undefined && recordPageTypes.has(owner.page.type) && subject !== undefined;
  const releaseOf = (props: (typeof entries)[number]["items"][number]["props"]) =>
    context.catalogue.releases.find(
      (candidate) =>
        candidate.blockId === props.vortex.block.block_id &&
        candidate.releaseVersion === props.vortex.block.release_version,
    );
  const named = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  // The people directory is usually another application's record type, so it is named here.
  const recordTypeLabel = (reference: string) =>
    records.find((record) => record.reference === reference)?.record.name ??
    (reference === peopleDirectory.recordType
      ? "person"
      : reference === peopleDirectory.groupRecordType
        ? "team"
        : "record");
  const page = pageBindingFacts({
    currentPersonRecordType:
      source.body.uses.some((use) => use.module === peopleDirectory.module) ||
      records.some((record) => record.reference === peopleDirectory.recordType)
        ? peopleDirectory.recordType
        : undefined,
    currentTeamRecordType:
      source.body.uses.some((use) => use.module === peopleDirectory.module) ||
      records.some((record) => record.reference === peopleDirectory.groupRecordType)
        ? peopleDirectory.groupRecordType
        : undefined,
    subject: hasSubject ? { recordType: subject, label: recordTypeLabel(subject) } : undefined,
    placements: (owner?.items ?? []).map(({ props }): QueryBindingPlacement => {
      const release = releaseOf(props);
      const selectionKey = selectionControlSettingKey(release?.key);
      const rowClick = props.row_click;
      return {
        placement: props.id,
        blockKey: release?.key,
        label: named(props.label) ?? named(props.title),
        blockName: release?.name ?? "This block",
        parameter: named(props.publishes_parameter),
        selectionControl:
          selectionKey === undefined
            ? undefined
            : named((props as Readonly<Record<string, unknown>>)[selectionKey]),
        linkTargets: Array.isArray(props.record_types)
          ? props.record_types.filter((value): value is string => typeof value === "string")
          : [],
        fieldType: fields.find((field) => field.field === props.field)?.type,
        selectedRecordType:
          typeof rowClick === "object" &&
          rowClick !== null &&
          "mode" in rowClick &&
          tablePublishesRecord(rowClick.mode, named(props.publishes_parameter))
            ? queries.find((candidate) => candidate.reference === props.vortex.query)?.recordType
            : undefined,
      };
    }),
    recordFields: hasSubject
      ? fields.filter((field) => field.field.startsWith(`${subject}.`))
      : undefined,
    recordTypeLabel,
  });
  const item = owner?.items.find((entry) => entry.props.id === placementAlias);
  const release = item === undefined ? undefined : releaseOf(item.props);
  return {
    ...page,
    blockLabel: named(item?.props.title) ?? release?.name ?? "This block",
  };
}
