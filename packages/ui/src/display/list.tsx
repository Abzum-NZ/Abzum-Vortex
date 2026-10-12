import type { ReactElement } from "react";
import { DisplayCellView } from "./cell";
import {
  DisplayHeader,
  PaginationControl,
  RecordsEmptyState,
  RecordsLoadingState,
  RowActionControl,
  SelectionControl,
} from "./controls";
import { resolveDisplayContext, rowName, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { ListPayload } from "./projected-data";

/**
 * Shared browser-safe display component for lists of permission-projected records, rendered with the
 * shadcn selection, action and paging parts. It preserves stable row identities and emits declared
 * semantic events only on user interaction. It never executes or fetches a Query.
 */
export function ListDisplay(props: DisplayRenderProps<ListPayload>): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, emptyMessage, events } =
    resolveDisplayContext<ListPayload>(props, (list) => list.rows.length === 0, "No items to show");

  // The list's own loading and no-rows presentations keep the state identity, role and accessible
  // name the standard state container gives them, and the container still owns the refused, error
  // and unavailable states of this placement.
  if (state.status === "loading") return <RecordsLoadingState accessibleName={accessibleName} />;
  if (state.status === "empty")
    return <RecordsEmptyState accessibleName={accessibleName} message={emptyMessage} />;

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="list"
          data-vortex-placement-id={placementId}
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {values.rows.map((row) => {
              const name = rowName(row, values.headingKey);
              const heading = row.cells[values.headingKey];
              const secondary =
                values.secondaryKey === undefined ? undefined : row.cells[values.secondaryKey];
              return (
                <li
                  key={row.recordId}
                  data-vortex-record-id={row.recordId}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 hover:border-foreground"
                >
                  <SelectionControl
                    row={row}
                    name={name}
                    selected={values.selectedRecordIds?.includes(row.recordId) ?? false}
                    events={events}
                  />
                  <div className="flex flex-1 flex-col">
                    <span className="font-semibold">
                      <DisplayCellView value={heading ?? { kind: "empty" }} />
                    </span>
                    {secondary === undefined ? null : (
                      <span className="text-muted-foreground">
                        <DisplayCellView value={secondary} />
                      </span>
                    )}
                  </div>
                  <RowActionControl recordId={row.recordId} name={name} events={events} />
                </li>
              );
            })}
          </ul>
          <PaginationControl
            page={values.page}
            pageCount={values.pageCount}
            accessibleName={accessibleName}
            events={events}
          />
        </section>
      )}
    </DisplayStateContainer>
  );
}
