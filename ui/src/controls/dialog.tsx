import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { ModalSurface } from "./modal-surface";

export type DialogProps = PlatformBlockRenderProps;

const DIALOG_WIDTHS = { small: "24rem", medium: "36rem", large: "52rem" } as const;

/**
 * Modal dialog with a required content slot and an optional actions slot. It opens from its
 * authored initial state or projected open state; its semantic identity is its placement.
 */
export function Dialog(props: DialogProps): ReactElement {
  return (
    <ModalSurface
      props={props}
      kind="dialog"
      surfaceStyle={(size) => ({
        width: `min(${DIALOG_WIDTHS[size]}, calc(100% - 2rem))`,
        maxHeight: "calc(100% - 2rem)",
      })}
    />
  );
}
