import {
  fieldBindingValueType,
  recordPageTypes,
  sourceItemTree,
  sourcePageItems,
  sourcePageShell,
  type QueryBindingPageFacts,
  type QueryBindingPageParameter,
  type QueryBindingControl,
} from "@vortex/platform/schema";
import type { StudioCompositionContext } from "./application-composition-commands";
import type { StudioQueryChoice } from "./contextual-palette";

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
  const subject =
    owner !== undefined && "record_type" in owner.page ? owner.page.record_type : undefined;
  const hasSubject =
    owner !== undefined && recordPageTypes.has(owner.page.type) && subject !== undefined;
  const parameters: QueryBindingPageParameter[] = hasSubject
    ? [{ name: "record_id", type: { kind: "record", recordTypes: [subject] } }]
    : [];
  const controls: QueryBindingControl[] = [];
  for (const item of owner?.items ?? []) {
    const props = item.props;
    const release = context.catalogue.releases.find(
      (candidate) =>
        candidate.blockId === props.vortex.block.block_id &&
        candidate.releaseVersion === props.vortex.block.release_version,
    );
    const key = release?.key;
    let type: QueryBindingPageParameter["type"] | undefined;
    if (key === "platform.form.text_input" || key === "platform.form.choice_input")
      type = { kind: "text" };
    if (key === "platform.form.date_input") type = { kind: "date" };
    if (key === "platform.form.link_input")
      type = {
        kind: "record",
        recordTypes: Array.isArray(props.record_types)
          ? props.record_types.filter((value): value is string => typeof value === "string")
          : [],
      };
    if (key === "platform.form.field_input")
      type = fields.find((field) => field.field === props.field)?.type;
    if (
      key === "platform.display.table" &&
      typeof props.row_click === "object" &&
      props.row_click !== null &&
      "mode" in props.row_click &&
      props.row_click.mode === "select"
    ) {
      const query = queries.find((candidate) => candidate.reference === props.vortex.query);
      if (query !== undefined) type = { kind: "record", recordTypes: [query.recordType] };
    }
    if (type === undefined) continue;
    const parameter =
      typeof props.publishes_parameter === "string" && props.publishes_parameter !== ""
        ? props.publishes_parameter
        : undefined;
    controls.push({
      placement: props.id,
      label: String(props.label ?? props.title ?? props.id),
      ...(parameter === undefined ? {} : { parameter }),
    });
    if (parameter !== undefined) parameters.push({ name: parameter, type, control: props.id });
  }
  const item = owner?.items.find((entry) => entry.props.id === placementAlias);
  const release = context.catalogue.releases.find(
    (candidate) =>
      candidate.blockId === item?.props.vortex.block.block_id &&
      candidate.releaseVersion === item?.props.vortex.block.release_version,
  );
  return {
    blockLabel: String(item?.props.title ?? release?.name ?? "This block"),
    parameters,
    controls,
    recordFields: hasSubject
      ? fields.filter((field) => field.field.startsWith(`${subject}.`))
      : undefined,
    rowFields: undefined,
    recordTypeLabel: (reference) =>
      records.find((record) => record.reference === reference)?.record.name ?? reference,
  };
}
