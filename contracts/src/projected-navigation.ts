/**
 * The navigation tree projected for one viewer. It is the compiled contract shape without
 * permission keys: the server already removed every item the viewer may not use and every heading
 * those removals left empty. Both the server projection and the browser renderer share this one
 * definition rather than keeping a copy each.
 */
export type ProjectedNavigationItem =
  | Readonly<{
      type: "heading";
      id: string;
      label: string;
      children: readonly ProjectedNavigationItem[];
    }>
  | Readonly<{ type: "page"; id: string; label: string; pageId: string }>
  | Readonly<{ type: "external"; id: string; label: string; address: string }>;

export type ProjectedNavigation = readonly ProjectedNavigationItem[];
