"use client";
import type { ReactElement } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { StudioIconButton } from "./studio-entry-list";

type Props = Readonly<{
  /** The tooltip and accessible name, for example "Add value". */
  label: string;
  disabled?: boolean | undefined;
  onClick: () => void;
}>;

/** The plus icon button of an inspector section header. */
export function StudioAddButton(props: Props): ReactElement {
  return (
    <StudioIconButton {...props}>
      <Plus />
    </StudioIconButton>
  );
}

/** The pencil icon button of a row whose editor opens in a dialog. */
export function StudioEditButton(props: Props): ReactElement {
  return (
    <StudioIconButton {...props}>
      <Pencil />
    </StudioIconButton>
  );
}

/** The trash icon button of a row that can be removed. */
export function StudioRemoveButton(props: Props): ReactElement {
  return (
    <StudioIconButton {...props} destructive>
      <Trash2 />
    </StudioIconButton>
  );
}
