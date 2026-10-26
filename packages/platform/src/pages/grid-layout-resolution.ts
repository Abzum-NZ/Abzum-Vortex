import type { RecordsTableContract } from "../definition/application-composition/records-display";
import type { GridLayout } from "./grid-view-state";

/*
 * How a grid's layout is resolved from its authored columns and a person's stored layout: plain
 * functions over the layout types, apart from the layout contracts, so the grid in the browser
 * resolves its layout without loading the contracts.
 */

/** The most personal formatting rules one view stores. */
export const GRID_VIEW_MAXIMUM_FORMAT_RULES = 20;

/** The declared columns of a Records table, once each, as lower-cased field identities. */
const declaredColumns = (contract: RecordsTableContract) => {
  const seen = new Set<string>();
  return contract.columns.flatMap((column) => {
    const fieldId = column.field.toLowerCase();
    if (seen.has(fieldId)) return [];
    seen.add(fieldId);
    return [{ fieldId, visible: column.visible, pin: column.pin }];
  });
};

/**
 * The authored layout: the declared columns in declared order, with their default visibility.
 * `readable`, when given, is the person's current field policy (the fields they can read on at
 * least one record): a column they can never read is left out, so it is never requested, listed
 * or offered to show, and when that leaves no column shown, the first remaining one shows. A row
 * on which a remaining field is withheld still shows it as Restricted. Undefined when the person
 * can read none of the declared columns.
 */
export const authoredGridLayout = (
  contract: RecordsTableContract,
  readable?: ReadonlySet<string>,
): GridLayout | undefined => {
  const columns = declaredColumns(contract).filter(
    (column) => readable === undefined || readable.has(column.fieldId),
  );
  const [first, ...rest] = columns;
  if (first === undefined) return undefined;
  return {
    columns: columns.some((column) => column.visible)
      ? columns
      : [{ ...first, visible: true }, ...rest],
  };
};

/**
 * The layout a person sees: their stored layout checked against the authored layout of the
 * current release and their current field policy. A permitted column the stored layout does not
 * name (added by a later release, or readable again) joins at the end with its authored
 * visibility. A stored layout that names a column the release no longer declares or the person
 * can no longer read, or another query's layout, is not applied: the authored layout shows and
 * `reset` says so, so the person is told why their layout changed.
 */
export const resolveGridLayout = (
  authored: GridLayout,
  stored: Readonly<{ queryId: string; layout: GridLayout }> | undefined,
  queryId: string,
): Readonly<{ layout: GridLayout; reset: boolean }> => {
  if (stored === undefined) return { layout: authored, reset: false };
  const permitted = new Set(authored.columns.map((column) => column.fieldId));
  if (
    stored.queryId.toLowerCase() !== queryId.toLowerCase() ||
    stored.layout.columns.some((column) => !permitted.has(column.fieldId))
  )
    return { layout: authored, reset: true };
  const named = new Set(stored.layout.columns.map((column) => column.fieldId));
  return {
    layout: {
      columns: [
        ...stored.layout.columns,
        ...authored.columns.filter((column) => !named.has(column.fieldId)),
      ],
      ...(stored.layout.density === undefined ? {} : { density: stored.layout.density }),
    },
    reset: false,
  };
};
