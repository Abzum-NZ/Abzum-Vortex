import { Suspense, type ReactNode } from "react";
import { BrandLoader } from "@vortex/ui";
import { loadApplicationFrame, loadApplicationStartTheme } from "../../../_lib/application-frame";
import { ApplicationFrame } from "./_components/application-frame";
import { DraftPreviewNotice } from "./_components/draft-preview-notice";

export const dynamic = "force-dynamic";
type Route = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
}>;
type Props = Readonly<{ children: ReactNode; params: Promise<Route> }>;

/**
 * The loader drawn while the frame is composed: the application's own mark in its own theme, as
 * soon as the application is known. Before that the organisation's platform loader shows. The
 * theme's variables are the document root's (the server render writes the addressed application's
 * theme there once), so the loader draws with them and repeats none of them.
 */
async function ApplicationStartLoader({ route }: { route: Route }) {
  const theme = await loadApplicationStartTheme(
    route.tenantShortName,
    route.organizationShortName,
    route.applicationKey,
  );
  if (theme === undefined) return null;
  return (
    <div data-vortex-theme="" className="grid min-h-svh place-items-center" aria-busy="true">
      <BrandLoader {...(theme.loaderMark === undefined ? {} : { mark: theme.loaderMark })} />
    </div>
  );
}

async function CurrentApplicationFrame({ route, children }: { route: Route; children: ReactNode }) {
  const frame = await loadApplicationFrame(
    route.tenantShortName,
    route.organizationShortName,
    route.applicationKey,
  );
  if (frame === undefined) return children;
  return (
    <>
      {frame.preview === undefined ? null : <DraftPreviewNotice {...frame.preview} />}
      <ApplicationFrame model={frame}>{children}</ApplicationFrame>
    </>
  );
}

/**
 * The application frame. It renders once per application and stays mounted while the pages inside
 * it change; only the page content below it is fetched and replaced. When the request addresses no
 * page the viewer may see, there is no frame and the page renders its own state.
 */
export default async function ApplicationLayout({ children, params }: Props) {
  const route = await params;
  return (
    <>
      <Suspense fallback={<ApplicationStartLoader route={route} />}>
        <CurrentApplicationFrame route={route}>{children}</CurrentApplicationFrame>
      </Suspense>
    </>
  );
}
