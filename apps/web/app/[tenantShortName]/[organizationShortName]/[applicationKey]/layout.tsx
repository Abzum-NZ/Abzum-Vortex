import type { ReactNode } from "react";
import { withPageReadAttribution } from "../../../_lib/page-read-attribution";
import { loadApplicationFrame } from "../../../_lib/application-frame";
import { ApplicationFrame } from "./_components/application-frame";
import { DraftPreviewNotice } from "./_components/draft-preview-notice";

export const dynamic = "force-dynamic";
type Route = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
}>;
type Props = Readonly<{ children: ReactNode; params: Promise<Route> }>;

async function readCurrentApplicationFrame({
  route,
  children,
}: {
  route: Route;
  children: ReactNode;
}) {
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
 * it change; only the page content below it is fetched and replaced. The frame and its page arrive
 * together, complete, with no loading boundary: a change into another application keeps the
 * current page on screen until the next one is ready. When the request addresses no page the
 * viewer may see, there is no frame and the page renders its own state.
 */
export default async function ApplicationLayout({ children, params }: Props) {
  const route = await params;
  return withPageReadAttribution(() => readCurrentApplicationFrame({ route, children }));
}
