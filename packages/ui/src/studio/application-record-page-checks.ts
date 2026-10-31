import { sourcePageItems, type SourceItem } from "@vortex/platform/schema";
import {
  companions,
  controlOpens,
  recordTables,
  resolveRecordType,
} from "./application-record-page-shared";
import { StructureRefusal, type Source } from "./application-structure-common";

/**
 * What a saved draft still needs before its record pages work for people: the Edit pages and row
 * actions the generator now makes, the Cancel of every generated form, and a home page with
 * content. Publish lists each as a plain sentence with a one-click offer where the fix is a page
 * edit; a check with no fix is a warning the builder acts on in Studio.
 */
export type StudioRecordPageCheck =
  | Readonly<{ kind: "missing_edit_page"; recordType: string; label: string }>
  | Readonly<{
      kind: "missing_row_edit";
      recordType: string;
      listAlias: string;
      label: string;
    }>
  | Readonly<{ kind: "missing_form_cancel"; pageAlias: string; label: string }>
  | Readonly<{ kind: "empty_home"; pageAlias: string; label: string }>;

const formContainers = (items: readonly SourceItem[]): SourceItem[] =>
  items.filter((item) => String(item.type) === "platform.form.container");

/** The record pages a saved draft still needs, in the order Publish lists them. */
export const studioRecordPageChecks = (source: Source): readonly StudioRecordPageCheck[] => {
  const checks: StudioRecordPageCheck[] = [];
  const pages = source.body.pages;
  for (const module of source.body.modules)
    for (const record of module.record_types) {
      const qualified = `${module.key}:${record.key}`;
      let resolved: ReturnType<typeof resolveRecordType>;
      try {
        resolved = resolveRecordType(source, qualified);
      } catch (error) {
        if (!(error instanceof StructureRefusal)) throw error;
        continue;
      }
      const found = companions(source, qualified);
      const update = record.standard_actions.includes("update");
      if (update && found.create !== undefined && found.edit === undefined)
        checks.push({
          kind: "missing_edit_page",
          recordType: qualified,
          label: `${record.plural_name}: create page but no edit page`,
        });
      if (update && found.edit !== undefined)
        for (const list of found.list) {
          const table = recordTables(source, list, resolved)[0];
          // A board opens a card through its row click, so it has no row menu to add Edit to.
          const features = table?.props.features as { board?: { enabled?: boolean } } | undefined;
          if (
            table === undefined ||
            features?.board?.enabled === true ||
            controlOpens(source, table.props.id, [found.edit.key])
          )
            continue;
          checks.push({
            kind: "missing_row_edit",
            recordType: qualified,
            listAlias: list.id,
            label: `${record.plural_name} list: row menu has no Edit`,
          });
        }
      for (const page of pages) {
        if (
          !("record_type" in page) ||
          page.record_type !== qualified ||
          (page.type !== "form" && page.type !== "guided_form")
        )
          continue;
        const forms = formContainers(sourcePageItems(page.composition));
        if (forms.length === 0) continue;
        const submits = source.body.flow_bindings.some(
          (binding) =>
            binding.event === "form_submit" &&
            forms.some((form) => form.props.id === binding.control),
        );
        if (!submits) continue;
        const cancelled = new Set(
          source.body.flow_bindings
            .filter((binding) => binding.event === "form_cancel")
            .map((binding) => binding.control),
        );
        if (forms.every((form) => cancelled.has(form.props.id))) continue;
        const mode =
          page.type === "guided_form"
            ? "guided form"
            : found.edit?.id === page.id
              ? "edit form"
              : "create form";
        checks.push({
          kind: "missing_form_cancel",
          pageAlias: page.id,
          label: `${record.name}: ${mode} has no Cancel`,
        });
      }
    }
  const home = pages.find((page) => page.key === source.body.home_page);
  if (home !== undefined && sourcePageItems(home.composition).length === 0)
    checks.push({
      kind: "empty_home",
      pageAlias: home.id,
      label: `${home.name} page has no content`,
    });
  return checks;
};
