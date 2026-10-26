"use client";

import { lazy, Suspense, type ReactElement } from "react";
import type { GridFeatureInteractionProps, GridFeatureModule } from "./registry";
import { gridFeature as rangeSelection } from "./range-selection";
import { GridToolbarSlot } from "./toolbar";

const Paste = lazy(() => import("./paste"));
const Fill = lazy(() => import("./fill"));
const Undo = lazy(() => import("./undo"));

const RangeSelection = rangeSelection.GridInteraction!;

/**
 * The Spreadsheet feature's one interaction: the range selection (which also loads Find), and the
 * editing chunks the projection turns on for this viewer. Paste, Fill and Undo are lazy chunks of
 * their own, downloaded only when the projection carries them, so a table without them loads none.
 */
function Spreadsheet(props: GridFeatureInteractionProps): ReactElement {
  const settings = props.context.features.spreadsheet;
  return (
    <>
      <RangeSelection {...props} />
      {settings?.paste === true || settings?.fill === true || settings?.undo === true ? (
        <div className="sticky left-0 flex flex-col">
          <Suspense fallback={null}>
            {settings.paste === true ? <Paste {...props} /> : null}
            {settings.fill === true ? <Fill {...props} /> : null}
            {settings.undo === true ? (
              <GridToolbarSlot area="supplement">
                <Undo {...props} />
              </GridToolbarSlot>
            ) : null}
          </Suspense>
        </div>
      ) : null}
    </>
  );
}

export const gridFeature: GridFeatureModule = { GridInteraction: Spreadsheet };
