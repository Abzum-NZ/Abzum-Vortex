/**
 * The icon libraries shadcn/create offers at the pinned shadcn version (`PRESET_ICON_LIBRARIES` in
 * `shadcn/preset` 4.21.0), in the preset's order. An application theme selection names one of them;
 * the shared `ui` package renders every icon through an adapter for the selected library and loads
 * only that library's code. `ui/src/icons/icon-libraries.ts` checks this list against the pinned
 * preset at compile time, so a shadcn upgrade that adds or removes a library cannot drift silently.
 */
export const SHADCN_ICON_LIBRARIES = [
  "lucide",
  "hugeicons",
  "tabler",
  "phosphor",
  "remixicon",
] as const;

export type ShadcnIconLibrary = (typeof SHADCN_ICON_LIBRARIES)[number];

/** Each library's display name, as shadcn/create labels it. */
export const SHADCN_ICON_LIBRARY_LABELS: Readonly<Record<ShadcnIconLibrary, string>> = {
  lucide: "Lucide",
  hugeicons: "HugeIcons",
  tabler: "Tabler Icons",
  phosphor: "Phosphor Icons",
  remixicon: "Remix Icon",
};

/** The pinned preset's default icon library, which a selection that names none renders with. */
export const DEFAULT_SHADCN_ICON_LIBRARY: ShadcnIconLibrary = "lucide";

/** Whether an id names a catalogue icon library. */
export const isShadcnIconLibrary = (id: string | null | undefined): id is ShadcnIconLibrary =>
  (SHADCN_ICON_LIBRARIES as readonly (string | null | undefined)[]).includes(id);

/** The icon library a selection renders with: the one it names, or the catalogue default. */
export const resolveShadcnIconLibrary = (id?: string | null): ShadcnIconLibrary =>
  isShadcnIconLibrary(id) ? id : DEFAULT_SHADCN_ICON_LIBRARY;
