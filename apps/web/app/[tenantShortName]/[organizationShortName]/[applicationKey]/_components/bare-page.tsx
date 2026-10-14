import type { ReactElement, ReactNode } from "react";

// While a state that is not a page of this application shows, the application frame around the
// outlet is hidden (also from assistive technology) and the state covers the whole viewport. A state
// that is only fading out of the outlet (a page already left) no longer hides the frame.
const barePageCss = `
[data-vortex-puck-root]:has([data-vortex-bare-page]:not([data-vortex-page-leaving] [data-vortex-bare-page])) { visibility: hidden; }
[data-vortex-bare-page] { visibility: visible; }
`;

/**
 * A page-level state shown on its own (a refusal, a suspended account, an unavailable read or the
 * application's not-found page). When the application frame is mounted around the outlet, this
 * covers it instead of nesting a second full page inside it; without a frame it is the page.
 */
export function BarePage({ children }: Readonly<{ children: ReactNode }>): ReactElement {
  return (
    <div data-vortex-bare-page="" className="fixed inset-0 z-50 overflow-auto bg-background">
      <style>{barePageCss}</style>
      {children}
    </div>
  );
}
