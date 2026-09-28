import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import {
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
} from "@vortex/ui";
import { signOut } from "../../../../auth/actions";

type ApplicationFrameProps = Readonly<{
  theme: Parameters<typeof createThemeRootProps>[0];
  organizationShortName: string;
  children: ReactNode;
}>;

/** The addressed page keeps its definition-rendered navigation inside this frame. */
export function ApplicationFrame({
  theme,
  organizationShortName,
  children,
}: ApplicationFrameProps) {
  const resolvedStyle = resolveVortexStyleSelection(theme?.selection);

  return (
    <div
      {...createThemeRootProps(theme)}
      {...createVortexStyleRootProps(resolvedStyle)}
      data-vortex-style-root=""
      data-vortex-application-frame=""
    >
      <style>{`
        [data-vortex-application-frame] [data-vortex-control="container"][data-vortex-direction="row"] > [data-vortex-container-region="menu"]:has([data-slot="sidebar"]) {
          flex: 0 0 var(--sidebar-width);
          width: var(--sidebar-width);
        }
        @media (max-width: 767px) {
          [data-vortex-application-frame] [data-vortex-control="container"][data-vortex-direction="row"]:has(> [data-vortex-container-region="menu"] [data-slot="sidebar"]) {
            flex-direction: column;
          }
          [data-vortex-application-frame] [data-vortex-control="container"][data-vortex-direction="row"] > [data-vortex-container-region="menu"]:has([data-slot="sidebar"]) {
            flex-basis: auto;
            width: 100%;
          }
        }
      `}</style>
      <SidebarProvider>
        <SidebarInset organizationShortName={organizationShortName}>{children}</SidebarInset>
      </SidebarProvider>
    </div>
  );
}

/** Supplies the geometry used by the definition-rendered shadcn Sidebar. */
function SidebarProvider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div
      data-slot="sidebar-wrapper"
      className="group/sidebar-wrapper flex min-h-svh w-full bg-background"
      style={{ "--sidebar-width": "16rem" } as CSSProperties}
    >
      {children}
    </div>
  );
}

function SidebarInset({
  organizationShortName,
  children,
}: Readonly<{ organizationShortName: string; children: ReactNode }>) {
  return (
    <div data-slot="sidebar-inset" className="flex min-h-svh min-w-0 w-full flex-col">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-4 border-b px-4 py-2">
        <span className="min-w-0 truncate font-medium">{organizationShortName}</span>
        <nav aria-label="Account and organisation" className="flex flex-wrap items-center gap-4">
          <Link href="/signed-in" className="font-medium underline underline-offset-4">
            Choose organisation
          </Link>
          <form action={signOut}>
            <button type="submit" className="font-medium underline underline-offset-4">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
