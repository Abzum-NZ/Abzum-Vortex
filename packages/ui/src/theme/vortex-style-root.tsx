"use client";

import * as React from "react";

type StyleRootContext = Readonly<{ element: HTMLDivElement | null }>;

const VortexStyleRootContext = React.createContext<StyleRootContext | null>(null);

/** Keep portalled components inside the application root whose style and theme they inherit. */
export function VortexStyleRoot({ children, ...props }: React.ComponentProps<"div">) {
  const [element, setElement] = React.useState<HTMLDivElement | null>(null);

  return (
    <VortexStyleRootContext.Provider value={{ element }}>
      <div ref={setElement} {...props} data-vortex-style-root="">
        {children}
      </div>
    </VortexStyleRootContext.Provider>
  );
}

/** A missing context means a platform screen, whose portal belongs under the document root. */
export function useVortexStylePortalRoot(): StyleRootContext | null {
  return React.useContext(VortexStyleRootContext);
}
