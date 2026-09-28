import type { CSSProperties, ReactNode } from "react";
import {
  ApplicationNavigation,
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
  type ProjectedNavigation,
  type ThemeMode,
} from "@vortex/ui";

type ApplicationFrameProps = Readonly<{
  /** The resolved application theme used by the page and its surrounding frame. */
  theme: Parameters<typeof createThemeRootProps>[0];
  /** The theme mode used by the rendered application page. */
  themeMode?: ThemeMode | undefined;
  /** The viewer's already permission-filtered application navigation. */
  navigation: ProjectedNavigation;
  /** Resolves a permitted page identity to the route's address shape. */
  resolvePageHref: (pageId: string) => string;
  /** The current page identity used to mark its navigation entry. */
  currentPageId?: string | undefined;
  /** Server-projected viewer and organisation actions for the application header. */
  viewerMenu: ReactNode;
  /** The addressed application page. */
  children: ReactNode;
}>;

/**
 * The shared frame for an addressed application page. Navigation and viewer actions are supplied
 * by the route after its protected server projections; this component never fetches or filters them.
 */
export function ApplicationFrame({
  theme,
  themeMode,
  navigation,
  resolvePageHref,
  currentPageId,
  viewerMenu,
  children,
}: ApplicationFrameProps) {
  const resolvedStyle = resolveVortexStyleSelection(theme?.selection);

  return (
    <div
      {...createThemeRootProps(theme, themeMode)}
      {...createVortexStyleRootProps(resolvedStyle)}
      data-vortex-style-root=""
    >
      <SidebarProvider>
        <div className="w-full shrink-0 md:w-(--sidebar-width)">
          <ApplicationNavigation
            navigation={navigation}
            label="Application navigation"
            resolvePageHref={resolvePageHref}
            {...(currentPageId === undefined ? {} : { currentPageId })}
          />
        </div>
        <SidebarInset viewerMenu={viewerMenu}>{children}</SidebarInset>
      </SidebarProvider>
    </div>
  );
}

/** Supplies the fixed sidebar geometry expected by the shadcn Sidebar parts. */
function SidebarProvider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div
      data-slot="sidebar-wrapper"
      className="group/sidebar-wrapper flex min-h-svh w-full flex-col bg-background md:flex-row"
      style={{ "--sidebar-width": "16rem" } as CSSProperties}
    >
      {children}
    </div>
  );
}

/** Keeps the viewer menu and application content together in the main frame inset. */
function SidebarInset({
  viewerMenu,
  children,
}: Readonly<{ viewerMenu: ReactNode; children: ReactNode }>) {
  return (
    <div data-slot="sidebar-inset" className="flex min-h-svh min-w-0 flex-1 flex-col">
      <header className="flex min-h-14 items-center justify-end border-b px-4 py-2">
        {viewerMenu}
      </header>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
