import type { ReactElement } from "react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../components/card";
import { DisplayCellView } from "./cell";
import { DisplayHeader, RowActionControl, SelectionControl } from "./controls";
import { resolveDisplayContext, rowName, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { GroupedPayload } from "./projected-data";

/**
 * Shared browser-safe display component for grouped data.
 * Preserves stable group and record identities and declared semantic event names.
 * Never executes or fetches a Query.
 */
export function GroupedDataDisplay(props: DisplayRenderProps<GroupedPayload>): ReactElement {
  const { placementId, availability } = props;
  const { title, accessibleName, values, state, emptyMessage, events } =
    resolveDisplayContext<GroupedPayload>(
      props,
      (grouped) => grouped.groups.length === 0,
      "No groups to show",
    );

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="grouped_data"
          data-vortex-placement-id={placementId}
          className="flex flex-col gap-4"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          {values.groups.map((group) => (
            <section
              key={group.groupId}
              data-vortex-group-id={group.groupId}
              aria-label={group.label}
            >
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h3 className="m-0 font-heading text-lg font-semibold">{group.label}</h3>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {group.rows.length === 0 ? (
                    <p className="m-0 text-muted-foreground">No items in this group</p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {group.rows.map((row) => {
                        const name = rowName(row, group.headingKey);
                        const heading = row.cells[group.headingKey];
                        const secondary =
                          group.secondaryKey === undefined
                            ? undefined
                            : row.cells[group.secondaryKey];
                        return (
                          <li
                            key={row.recordId}
                            data-vortex-record-id={row.recordId}
                            className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background p-3"
                          >
                            <SelectionControl
                              row={row}
                              name={name}
                              selected={group.selectedRecordIds?.includes(row.recordId) ?? false}
                              events={events}
                            />
                            <div className="flex min-w-0 flex-1 flex-col">
                              <span className="font-semibold">
                                <DisplayCellView value={heading ?? { kind: "empty" }} />
                              </span>
                              {secondary === undefined ? null : (
                                <span className="text-muted-foreground">
                                  <DisplayCellView value={secondary} />
                                </span>
                              )}
                            </div>
                            <RowActionControl
                              recordId={row.recordId}
                              name={name}
                              events={events}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
                {group.summary === undefined || group.summary.length === 0 ? null : (
                  <CardFooter className="w-full">
                    <dl className="m-0 flex w-full flex-wrap gap-4">
                      {group.summary.map((summary) => (
                        <div
                          key={summary.key}
                          data-vortex-summary-key={summary.key}
                          className="flex min-w-40 flex-1 flex-col gap-1"
                        >
                          <dt className="text-muted-foreground">{summary.label}</dt>
                          <dd className="m-0">
                            <DisplayCellView value={summary.value} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </CardFooter>
                )}
              </Card>
            </section>
          ))}
        </section>
      )}
    </DisplayStateContainer>
  );
}
