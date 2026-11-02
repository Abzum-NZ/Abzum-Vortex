"use client";

import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "../lib/utils";

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "cn-resizable-panel-group flex h-full w-full aria-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "cn-resizable-handle relative flex shrink-0 items-center justify-center outline-none",
        className,
      )}
      {...props}
    >
      {withHandle && <div className="cn-resizable-handle-grip z-10 flex shrink-0" />}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
export { usePanelRef } from "react-resizable-panels";
