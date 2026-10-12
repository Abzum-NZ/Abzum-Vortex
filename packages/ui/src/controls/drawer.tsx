"use client";

import type { ReactElement } from "react";
import { readControlSettings, type ControlRenderProps } from "./control-context";
import { ModalSurface, type DrawerPlacement } from "./modal-surface";
import type { DrawerPayload } from "./projected-data";

export type DrawerProps = ControlRenderProps<DrawerPayload>;

/**
 * Modal drawer attached to one declared edge, with a required content slot and an optional
 * actions slot, rendered by the shadcn Sheet component on its declared side. Focus, Escape and
 * dismissal behave exactly as the dialog's.
 */
export function Drawer(props: DrawerProps): ReactElement {
  const placement = readControlSettings(props, {
    placementId: props.placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
  }).choice<DrawerPlacement>("placement", "right");
  return (
    <ModalSurface<DrawerPayload>
      props={props}
      kind="drawer"
      drawerPlacement={placement}
      dataAttributes={{ "data-vortex-drawer-placement": placement }}
    />
  );
}
