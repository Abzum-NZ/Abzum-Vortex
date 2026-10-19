"use client";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../components/dropdown-menu";
import { Icon } from "../../icons/icon";
import type { GridFeatureColumnProps, GridFeatureModule } from "./registry";

function PinItems({ context, column }: GridFeatureColumnProps) {
  const pin = context.layout.state.pins[column.key.toLowerCase()];
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem
          disabled={pin === "start"}
          onClick={() => context.layout.setPin(column.key, "start")}
        >
          <Icon name="chevron-left" aria-hidden="true" />
          Pin to start
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={pin === "end"}
          onClick={() => context.layout.setPin(column.key, "end")}
        >
          <Icon name="chevron-right" aria-hidden="true" />
          Pin to end
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={pin === "unpinned"}
          onClick={() => context.layout.setPin(column.key, "unpinned")}
        >
          <Icon name="close" aria-hidden="true" />
          Unpin
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
}

export const gridFeature: GridFeatureModule = { ColumnMenuItems: PinItems };
