"use client";

import type { ReactElement } from "react";
import { Button } from "../../components/button";
import {
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "../../components/dropdown-menu";
import { Icon } from "../../icons/icon";
import type { GridFeatureColumnProps, GridFeatureModule, GridFeaturePointProps } from "./registry";

/**
 * Group by: the table groups its records by the authored choice field, counted on the server. The
 * viewer only switches grouping on or off; the field is the table's own, never chosen here. The
 * groups themselves are drawn by the table's body, which reads them from the same payload.
 */
function GroupToggle({ context }: GridFeaturePointProps): ReactElement | null {
  const grouping = context.grouping;
  const settings = context.features.grouping;
  // A table that reads a grouped query is always grouped: there is nothing to switch.
  if (
    grouping === undefined ||
    settings === undefined ||
    settings.required === true ||
    context.events?.group_changed === undefined
  )
    return null;
  return (
    <Button
      type="button"
      size="sm"
      variant={grouping.grouped ? "default" : "outline"}
      aria-pressed={grouping.grouped}
      onClick={() => grouping.setGrouped(!grouping.grouped)}
    >
      <Icon name="list-tree" aria-hidden="true" />
      {`Group by ${settings.label}`}
    </Button>
  );
}

/** The grouping column's own menu offers the same switch beside its sort and pin items. */
function GroupItems({ context, column }: GridFeatureColumnProps): ReactElement | null {
  const grouping = context.grouping;
  const settings = context.features.grouping;
  if (
    grouping === undefined ||
    settings === undefined ||
    settings.required === true ||
    context.events?.group_changed === undefined ||
    column.key.toLowerCase() !== settings.fieldId.toLowerCase()
  )
    return null;
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuCheckboxItem
          checked={grouping.grouped}
          onCheckedChange={(checked) => grouping.setGrouped(checked)}
        >
          <Icon name="list-tree" aria-hidden="true" />
          {`Group by ${column.label}`}
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
}

export const gridFeature: GridFeatureModule = {
  ToolbarItems: GroupToggle,
  ColumnMenuItems: GroupItems,
};
