"use client";

import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { Separator } from "./separator";
import { Icon } from "../icons/icon";

/*
 * The shadcn Sidebar parts of the pinned shadcn 4.21.0 Base UI registry, carrying the same cn-*
 * style slot classes so the shared component stylesheet can paint them from the application theme.
 *
 * Vortex places navigation as a block inside an application shell whose geometry the definition
 * declares, so the sidebar is the registry's static (`collapsible="none"`) form: it fills the
 * placement it is given and never fixes itself to the viewport. The registry's provider, trigger,
 * rail, inset, input, skeleton and menu action parts, and the collapsed-icon tooltip, exist for a
 * page-owned off-canvas sidebar and are not part of this port; the navigation block supplies its
 * own compact phone disclosure over the same menu.
 */

type SidebarContextValue = Readonly<{
  open: boolean;
  collapsible: "none" | "icon";
  toggle: () => void;
}>;

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function SidebarProvider({
  defaultCollapsed,
  collapsible,
  children,
}: React.PropsWithChildren<Readonly<{ defaultCollapsed: boolean; collapsible: "none" | "icon" }>>) {
  const [open, setOpen] = React.useState(!defaultCollapsed);
  const value = React.useMemo(
    () => ({
      open: collapsible === "none" ? true : open,
      collapsible,
      toggle: () => setOpen((current) => !current),
    }),
    [collapsible, open],
  );
  return (
    <SidebarContext.Provider value={value}>
      <div
        data-sidebar-provider=""
        data-vortex-sidebar-state={value.open ? "expanded" : "collapsed"}
        className="group/sidebar-provider flex min-h-svh w-full min-w-0 flex-col"
        style={{ "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" } as React.CSSProperties}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function SidebarTrigger({ className, ...props }: React.ComponentProps<typeof Button>) {
  const context = React.useContext(SidebarContext);
  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      aria-label={context?.open === false ? "Expand sidebar" : "Collapse sidebar"}
      aria-pressed={context?.open === false}
      disabled={context === null || context.collapsible === "none"}
      onClick={context?.toggle}
      className={cn(className)}
      {...props}
    >
      <Icon name="panel-left" aria-hidden="true" />
    </Button>
  );
}

function Sidebar({ className, children, ...props }: React.ComponentProps<"div">) {
  const context = React.useContext(SidebarContext);
  return (
    <div
      data-slot="sidebar"
      data-state={context?.open === false ? "collapsed" : "expanded"}
      data-collapsible={context?.collapsible ?? "none"}
      className={cn(
        "group/sidebar flex h-full w-full flex-col bg-sidebar text-sidebar-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("cn-sidebar-header flex flex-col", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("cn-sidebar-footer flex flex-col", className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn("cn-sidebar-separator w-auto", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn("cn-sidebar-content flex min-h-0 flex-1 flex-col overflow-auto", className)}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("cn-sidebar-group relative flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & React.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "cn-sidebar-group-label flex shrink-0 items-center outline-hidden [&>svg]:shrink-0",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-group-label",
      sidebar: "group-label",
    },
  });
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("cn-sidebar-group-content w-full", className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("cn-sidebar-menu flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "cn-sidebar-menu-button peer/menu-button group/menu-button flex w-full items-center overflow-hidden outline-hidden disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate",
  {
    variants: {
      variant: {
        default: "cn-sidebar-menu-button-variant-default",
        outline: "cn-sidebar-menu-button-variant-outline",
      },
      size: {
        default: "cn-sidebar-menu-button-size-default",
        sm: "cn-sidebar-menu-button-size-sm",
        lg: "cn-sidebar-menu-button-size-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function SidebarMenuButton({
  render,
  isActive = false,
  variant = "default",
  size = "default",
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    isActive?: boolean;
  } & VariantProps<typeof sidebarMenuButtonVariants>) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(sidebarMenuButtonVariants({ variant, size }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-menu-button",
      sidebar: "menu-button",
      size,
      active: isActive,
    },
  });
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "cn-sidebar-menu-badge flex items-center justify-center tabular-nums select-none",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn("cn-sidebar-menu-sub flex min-w-0 flex-col", className)}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("group/menu-sub-item relative", className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  render,
  size = "md",
  isActive = false,
  className,
  ...props
}: useRender.ComponentProps<"a"> &
  React.ComponentProps<"a"> & {
    size?: "sm" | "md";
    isActive?: boolean;
  }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "cn-sidebar-menu-sub-button flex min-w-0 -translate-x-px items-center overflow-hidden outline-hidden disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:shrink-0",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-menu-sub-button",
      sidebar: "menu-sub-button",
      size,
      active: isActive,
    },
  });
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarProvider,
  SidebarTrigger,
};
