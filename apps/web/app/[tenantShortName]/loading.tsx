import { DEFAULT_PLATFORM_THEME_RELEASE } from "@vortex/platform/server";
import { BrandLoader } from "@vortex/ui";

/**
 * The first load of an organisation address (its launcher or one of its applications). The shape
 * of the page is not known yet, so only the platform loader is drawn, centred, in place of a blank
 * screen; it stays invisible for its first moment, so a quick load shows nothing. The frame and page
 * then arrive together, and a placement whose own data is still being read shows its own skeleton.
 * Moving between pages of an application never shows this; the current page stays until the next
 * one is ready.
 */
export default function Loading() {
  return (
    <div className="grid min-h-svh place-items-center" aria-busy="true">
      <BrandLoader mark={DEFAULT_PLATFORM_THEME_RELEASE.loaderMark} />
    </div>
  );
}
