import type { ReactElement } from "react";
import Link from "next/link";
import { readRecordDetailContract } from "@vortex/platform/schema";
import { DefinitionRenderError } from "../definition-error";
import { Badge } from "../components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/card";
import { Separator } from "../components/separator";
import { cn } from "../lib/utils";
import { cellValueToText, DisplayCellView } from "./cell";
import { addLabelOf } from "./add-label";
import { DisplayHeader, RowActionControl } from "./controls";
import { resolveDisplayContext, rowActionEventIdOf, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import { optionToneBadgeClass, optionToneFillClass } from "./option-tone";
import type { DisplayDetailField, RecordDetailPayload } from "./projected-data";

type RecordDetailSection = RecordDetailPayload["sections"][number];
type RecordDetailRelatedList = RecordDetailPayload["relatedLists"][number];

/**
 * The projected sections the placement declares, in declared order, each field's declared label
 * overriding the projected one. A field the viewer cannot read is absent from the projection and
 * stays absent here; a declared section with no readable field is not drawn.
 */
const sectionsOf = (
  values: RecordDetailPayload,
  contract: ReturnType<typeof readRecordDetailContract>,
): readonly RecordDetailSection[] => {
  if (contract === undefined) return values.sections;
  const projected = new Map(
    values.sections.flatMap((section) => section.fields.map((field) => [field.key, field] as const)),
  );
  return contract.sections.flatMap((section): RecordDetailSection[] => {
    const fields = section.fields.flatMap((declared): DisplayDetailField[] => {
      const field = projected.get(declared.field);
      return field === undefined
        ? []
        : [{ ...field, label: declared.label ?? field.label }];
    });
    if (fields.length === 0) return [];
    const projectedSection = values.sections.find((candidate) => candidate.key === section.key);
    return [
      {
        key: section.key,
        ...(section.title === undefined
          ? projectedSection?.title === undefined
            ? {}
            : { title: projectedSection.title }
          : { title: section.title }),
        fields,
      },
    ];
  });
};

/**
 * Shared browser-safe display component for record details. A modern record page: a header with
 * the record's title and its key facts, an optional stage strip in the option colours, sections as
 * cards in a responsive grid, and related lists as cards with their count and add action. The
 * placement's declared shape decides what shows; values stay permission-projected. Never fetches.
 */
export function RecordDetailDisplay(props: DisplayRenderProps<RecordDetailPayload>): ReactElement {
  const { placementId, availability } = props;
  const {
    title: configuredTitle,
    accessibleName,
    values,
    state,
    emptyMessage,
    refusedMessage,
    errorMessage,
    events,
  } = resolveDisplayContext<RecordDetailPayload>(
    props,
    (detail) => detail.sections.length === 0 && detail.heading === undefined,
    "No details to show",
  );
  const contract = readRecordDetailContract(props.settings);
  if (contract?.headingField !== undefined && values !== undefined && values.heading === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "A record heading requires its projected field value",
      { placementId },
    );
  const title =
    contract?.headingField === undefined
      ? configuredTitle
      : values?.heading === undefined
        ? undefined
        : cellValueToText(values.heading);
  const sections = values === undefined ? [] : sectionsOf(values, contract);
  const actions = props.slots.actions ?? undefined;
  const hasHeader = title !== undefined || events?.refresh !== undefined;
  const headerClassName = cn(!hasHeader && "hidden has-[[data-vortex-layout-wrapper]]:block");
  const headerFacts = values?.headerFacts ?? [];
  const stage = values?.stage;
  const relatedLists = values?.relatedLists ?? [];

  const relatedAddHref = (list: RecordDetailRelatedList): string | undefined => {
    if (list.add === undefined || props.resolvePageHref === undefined) return undefined;
    const address = props.resolvePageHref(list.add.pageKey);
    return `${address}${address.includes("?") ? "&" : "?"}${encodeURIComponent(list.add.parentFieldId)}=${encodeURIComponent(values!.recordId)}`;
  };

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
      {...(refusedMessage === undefined ? {} : { refusedMessage })}
      {...(errorMessage === undefined ? {} : { errorMessage })}
    >
      {values === undefined ? null : (
        <Card
          data-vortex-display="record_detail"
          data-vortex-placement-id={placementId}
          data-vortex-record-id={values.recordId}
          role="region"
          aria-label={accessibleName}
          className="overflow-hidden"
        >
          {hasHeader || actions !== undefined ? (
            <div className={headerClassName}>
              <CardHeader className="gap-4 *:mb-0">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 *:mb-0">
                    <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
                  </div>
                  {actions === undefined ? null : (
                    <div className="flex shrink-0 flex-row flex-nowrap items-center justify-end gap-2 [&>div]:flex-row [&>div]:flex-nowrap [&>div]:items-center [&>div]:gap-2">
                      {actions}
                    </div>
                  )}
                </div>
                {headerFacts.length === 0 ? null : (
                  <dl
                    data-vortex-record-header-facts=""
                    className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4"
                  >
                    {headerFacts.map((fact, index) => (
                      <div key={index} className="flex min-w-0 flex-col gap-0.5">
                        <dt className="truncate text-xs font-medium text-muted-foreground">
                          {fact.label}
                        </dt>
                        <dd className="m-0 truncate text-lg font-semibold tracking-tight">
                          <DisplayCellView value={fact.value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </CardHeader>
              <Separator />
            </div>
          ) : null}
          {stage === undefined ? null : (
            <>
              <div
                data-vortex-record-stage=""
                className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3"
                role="group"
                aria-label={`${stage.fieldLabel} stage`}
              >
                <span className="me-1 text-xs font-medium text-muted-foreground">
                  {stage.fieldLabel}
                </span>
                {stage.steps.map((step) => (
                  <span
                    key={step.value}
                    aria-current={step.current ? "step" : undefined}
                    data-vortex-stage-current={step.current ? "true" : undefined}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                      step.current ? "font-semibold" : "font-normal",
                      optionToneBadgeClass(step.tone),
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn("size-2 rounded-full", optionToneFillClass[step.tone])}
                    />
                    {step.label}
                  </span>
                ))}
              </div>
            </>
          )}
          <CardContent className="grid gap-3 bg-muted/20 p-4 sm:p-6 md:grid-cols-2 xl:grid-cols-3">
            {sections.map((section) => (
              <Card key={section.key} className="min-w-0 border-border/70 shadow-none">
                {section.title === undefined ? null : (
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
                  </CardHeader>
                )}
                <CardContent className={cn("grid gap-3", section.title === undefined && "pt-4")}>
                  <dl className="m-0 grid gap-3">
                    {section.fields.map((field) => (
                      <div
                        key={field.key}
                        data-vortex-field-key={field.key}
                        className={cn(
                          "flex min-w-0 flex-col gap-0.5",
                          field.value.kind === "field_table" && "sm:col-span-2",
                        )}
                      >
                        <dt className="text-xs font-medium text-muted-foreground">{field.label}</dt>
                        <dd className="m-0 break-words text-sm">
                          <DisplayCellView value={field.value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            ))}
            {relatedLists.map((list) => {
              const href = relatedAddHref(list);
              return (
                <Card
                  key={list.key}
                  data-vortex-related-list={list.key}
                  className="min-w-0 border-border/70 shadow-none"
                >
                  <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
                    <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                      <span className="truncate">{list.title}</span>
                      <Badge variant="secondary">{list.rows.length}</Badge>
                    </CardTitle>
                    {href === undefined ? null : (
                      <Link
                        href={href}
                        prefetch={false}
                        aria-label={`${addLabelOf(list.add!.pageKey)} to ${list.title}`}
                        className="shrink-0 text-sm font-medium underline-offset-4 hover:underline"
                      >
                        {addLabelOf(list.add!.pageKey)}
                      </Link>
                    )}
                  </CardHeader>
                  <CardContent className="pt-0">
                    {list.rows.length === 0 ? (
                      <p className="m-0 text-sm text-muted-foreground">Nothing yet.</p>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-2 p-0">
                        {list.rows.map((row) => (
                          <li
                            key={row.recordId}
                            data-vortex-related-record-id={row.recordId}
                            className="flex min-w-0 flex-col gap-1 border-b border-border/60 pb-2 last:border-b-0 last:pb-0"
                          >
                            <span className="truncate text-sm font-medium">
                              <DisplayCellView value={row.title} />
                            </span>
                            {row.fields.length === 0 ? null : (
                              <dl className="m-0 flex flex-wrap gap-x-4 gap-y-1">
                                {row.fields.map((field) => (
                                  <div key={field.key} className="flex min-w-0 items-baseline gap-1">
                                    <dt className="text-xs text-muted-foreground">{field.label}</dt>
                                    <dd className="m-0 truncate text-xs">
                                      <DisplayCellView value={field.value} />
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </CardContent>
          {events?.row_action === undefined ? null : (
            <CardContent className="pt-0">
              <RowActionControl
                recordId={values.recordId}
                name={accessibleName}
                eventId={rowActionEventIdOf(props)}
                events={events}
              />
            </CardContent>
          )}
        </Card>
      )}
    </DisplayStateContainer>
  );
}
