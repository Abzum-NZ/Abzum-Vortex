import {
  isIsoCalendarDate,
  isRecord,
  recordIdSchema,
  walkPageComposition,
} from "@vortex/platform/schema";
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
  // A drawer opened by a control is open exactly while the address holds a record id for it.
  const drawerControl = model.pageParameters.drawers[id];
  if (drawerControl !== undefined) {
    const parameter = model.pageParameters.controls[drawerControl];
    const open = parameter !== undefined && recordIdSchema.safeParse(search.get(parameter)).success;
    return { status: "ready", values: { kind: "drawer", open } };
  }
  const name = model.pageParameters.controls[id];
  if (name === undefined) return data;
  const kind = model.pageParameters.controlKinds[id];
  const value = search.get(name);
  const ready = data as { status?: string; values?: Record<string, unknown> } | undefined;
  // A control the server did not publish as ready (disabled, refused, loading) stays as it is: the
  // address never makes it usable.
  if (ready !== undefined && ready.status !== "ready") return data;
  // URL values are untrusted. Static choices live in the projected placement settings; dynamic
  // choices live in its protected payload. Validate against the same list the control renders.
  const choiceValue = (payload: Record<string, unknown> | undefined): string | null => {
    if (value === null) return null;
    let options = payload?.options;
    if (options === undefined)
      walkPageComposition(model.page.composition, ({ placementId, props }) => {
        if (placementId === id) options = props.options;
      });
    return Array.isArray(options) &&
      options.some((option) => isRecord(option) && option.key === value)
      ? value
      : null;
  };
  if (kind === "text_input" || kind === "date_input" || kind === "choice_input")
    return {
      status: "ready",
      values: {
        ...(ready?.values ?? {}),
        kind,
        value:
          kind === "choice_input"
            ? choiceValue(ready?.values)
            : kind === "date_input"
              ? value !== null && isIsoCalendarDate(value)
                ? value
                : null
              : (value ?? ""),
      },
    };
  if (kind === "field_input") {
    if (value === null) return data;
    const payload = ready?.values;
    // A field with no default has no payload; the control it renders names its input kind.
    let control: unknown;
    if (data === undefined)
      walkPageComposition(model.page.composition, ({ placementId, props }) => {
        if (placementId === id) control = props.control;
      });
    const inputKind =
      data === undefined
        ? control === "choice"
          ? "choice_input"
          : control === "text"
            ? "text_input"
            : undefined
        : ready?.status === "ready"
          ? payload?.kind
          : undefined;
    if (inputKind !== "text_input" && inputKind !== "choice_input") return data;
    return {
      status: "ready",
      values: {
        ...payload,
        kind: inputKind,
        value: inputKind === "choice_input" ? choiceValue(payload) : value,
      },
    };
  }
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
