import { vortexStyleStylesheetHref, type VortexStyle } from "./vortex-style";

/** The resolved stylesheet stays in React's tree across hydration and client navigation. */
export function VortexStyleStylesheet({ style }: Readonly<{ style: VortexStyle }>) {
  return (
    <link rel="stylesheet" href={vortexStyleStylesheetHref(style)} data-vortex-style={style} />
  );
}
