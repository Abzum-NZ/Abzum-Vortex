"use client";

import { createContext, use, useContext, type ReactNode } from "react";
import { DEFAULT_SHADCN_ICON_LIBRARY, type ShadcnIconLibrary } from "@vortex/platform/schema";

import { loadIconAdapter } from "./icon-libraries";
import type { VortexIconName, VortexIconProps } from "./icon-names";

/** Only a screen outside any application root (sign-in, account pages) renders with the platform default. */
const IconLibraryContext = createContext<ShadcnIconLibrary>(DEFAULT_SHADCN_ICON_LIBRARY);

/**
 * Selects the icon library for everything it contains: an application root passes the library its
 * theme selected. It starts loading that library's adapter as it renders, so the icons below it do
 * not each wait for the chunk in turn.
 */
export function IconLibraryProvider({
  library,
  children,
}: Readonly<{ library: ShadcnIconLibrary; children: ReactNode }>) {
  void loadIconAdapter(library);
  return <IconLibraryContext value={library}>{children}</IconLibraryContext>;
}

/**
 * One semantic icon, drawn by the selected icon library. An icon is decorative unless the caller
 * names it with `aria-label`, so it is hidden from assistive technology by default.
 */
export function Icon({ name, ...props }: VortexIconProps & Readonly<{ name: VortexIconName }>) {
  const library = useContext(IconLibraryContext);
  const Glyph = use(loadIconAdapter(library))[name];
  const decorative = props["aria-label"] === undefined && props["aria-labelledby"] === undefined;
  return <Glyph aria-hidden={decorative ? true : undefined} data-icon-name={name} {...props} />;
}
