"use client";

import type { ReactElement } from "react";
import type { ControlRenderProps } from "./control-context";
import { ModalSurface } from "./modal-surface";
import type { DialogPayload } from "./projected-data";

export type DialogProps = ControlRenderProps<DialogPayload>;

/**
 * Modal dialog with a required content slot and an optional actions slot. It opens from its
 * authored initial state or projected open state; its semantic identity is its placement. It is
 * rendered by the shadcn Dialog component (Base UI), which traps focus inside the surface and
 * returns focus when it closes.
 */
export function Dialog(props: DialogProps): ReactElement {
  return <ModalSurface<DialogPayload> props={props} kind="dialog" />;
}
