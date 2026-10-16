import type { ApplicationSourceDocument, ProjectedNavigation, ProjectedNavigationItem } from "@vortex/platform/schema";

/**
 * The canvas frame's menu, from the draft as it is edited rather than from its last compile, so a
 * Menu tab edit shows on the canvas at once. It is the design view: every entry the draft declares
 * is shown, whoever may see it. A page entry carries the compiled id of its page when the page was
 * compiled (the canvas marks the page being edited as current with it); a page added since the last
 * save has no compiled id yet and carries its draft key, which no compiled page shares.
 */
export const studioDraftNavigation = (
  source: ApplicationSourceDocument,
  compiledPageIds: Readonly<Record<string, Readonly<{ pageId: string }>>> | undefined,
): ProjectedNavigation => {
  const pageIdOf = (key: string): string => {
    const page = source.body.pages.find((candidate) => candidate.key === key);
    return (page === undefined ? undefined : compiledPageIds?.[page.id]?.pageId) ?? `draft:${key}`;
  };
  const project = (item: ApplicationSourceDocument["body"]["navigation"][number]): ProjectedNavigationItem => {
    switch (item.type) {
      case "heading": return { type: "heading", id: item.id, label: item.label, icon: item.icon, children: item.children.map(project) };
      case "page": return { type: "page", id: item.id, label: item.label, icon: item.icon, pageId: pageIdOf(item.page) };
      case "external": return { type: "external", id: item.id, label: item.label, icon: item.icon, address: item.address };
    }
  };
  return source.body.navigation.map(project);
};
