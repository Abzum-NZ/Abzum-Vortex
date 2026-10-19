import type { RecordChoicePage } from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";

type Data = ApplicationPageModel["data"][string];
export type PublishedRecordTitles = Map<
  string,
  Readonly<{ recordTypeId: string; recordId: string; title: string }>
>;

/** Only retain titles already returned by the protected picker in this page's request scope. */
export function rememberPublishedChoices(
  titles: PublishedRecordTitles,
  id: string,
  page: RecordChoicePage,
) {
  for (const row of page.choices) titles.set(`${id}:${row.recordId}`, row);
  while (titles.size > 1000) titles.delete(titles.keys().next().value!);
}

export function publishedControlData(
  model: ApplicationPageModel,
  id: string,
  data: Data | undefined,
  search: URLSearchParams,
  titles: PublishedRecordTitles,
): Data | undefined {
  const name = model.pageParameters.controls[id];
  if (name === undefined) return data;
  const kind = model.pageParameters.controlKinds[id];
  const value = search.get(name);
  const ready = data as { status?: string; values?: Record<string, unknown> } | undefined;
  if (kind === "text_input" || kind === "date_input" || kind === "choice_input")
    return {
      status: "ready",
      values: {
        ...(ready?.values ?? {}),
        kind,
        value: value ?? (kind === "text_input" ? "" : null),
      },
    };
  if (kind !== "link_input") return data;
  const seed = ready?.values?.value as { recordTypeId: string; recordId: string } | undefined;
  if (seed?.recordId !== undefined && typeof ready?.values?.title === "string")
    titles.set(`${id}:${seed.recordId}`, { ...seed, title: ready.values.title });
  if (value === null) return { status: "ready", values: { kind, value: null } };
  const known = titles.get(`${id}:${value}`);
  if (known === undefined) return { status: "ready", values: { kind, value: null } };
  return {
    status: "ready",
    values: {
      kind,
      value: { recordTypeId: known.recordTypeId, recordId: known.recordId },
      title: known.title,
    },
  };
}
