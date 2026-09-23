import type { CSSProperties, ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { readControlSettings } from "./control-context";
import { ModalSurface } from "./modal-surface";

export type DrawerProps = PlatformBlockRenderProps;

type DrawerPlacement = "left" | "right" | "top" | "bottom";

const DRAWER_EXTENTS = { small: "20rem", medium: "28rem", large: "40rem" } as const;

/** Layout-only edge placement for the native modal surface. */
const edgeStyle = (placement: DrawerPlacement, extent: string): CSSProperties => {
  const vertical = placement === "left" || placement === "right";
  return {
    margin: 0,
    inset:
      placement === "left"
        ? "0 auto 0 0"
        : placement === "right"
          ? "0 0 0 auto"
          : placement === "top"
            ? "0 0 auto 0"
            : "auto 0 0 0",
    ...(vertical
      ? { width: `min(${extent}, 100%)`, height: "100%", maxHeight: "100%" }
      : { height: `min(${extent}, 100%)`, width: "100%", maxWidth: "100%" }),
  };
};

/**
 * Modal drawer attached to one declared edge, with a required content slot and an optional
 * actions slot. Focus, Escape and dismissal behave exactly as the dialog's.
 */
export function Drawer(props: DrawerProps): ReactElement {
  const placement = readControlSettings(props, {
    placementId: props.placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
  }).choice<DrawerPlacement>("placement", "right");
  return (
    <ModalSurface
      props={props}
      kind="drawer"
      surfaceStyle={(size) => edgeStyle(placement, DRAWER_EXTENTS[size])}
      dataAttributes={{ "data-vortex-drawer-placement": placement }}
    />
  );
}
