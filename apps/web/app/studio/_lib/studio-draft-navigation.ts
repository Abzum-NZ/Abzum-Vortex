import {
  collectNavigationPermissionKeys, projectNavigation,
  type ApplicationSourceDocument, type NavigationItem, type NavigationPermissionDecisions, type ProjectedNavigation,
} from "@vortex/platform/schema";

/**
 * The canvas frame's menu, from the draft as it is edited rather than from its last compile, so a
 * Menu tab edit shows on the canvas at once. It is projected exactly as the running application
 * projects its menu: in the design view every entry is allowed, so all of them show; previewing a
 * role passes the permissions that role grants, so the canvas shows the menu its people see. A page
 * entry carries the compiled id of its page when the page was compiled (the canvas marks the page
 * being edited as current with it); a page added since the last save has no compiled id yet and
 * carries its draft key, which no compiled page shares.
 */
export const studioDraftNavigation = (
  source: ApplicationSourceDocument,
  compiledPageIds: Readonly<Record<string, Readonly<{ pageId: string }>>> | undefined,
  decisions: NavigationPermissionDecisions | null,
): ProjectedNavigation => {
  const pageIdOf = (key: string): string => {
    const page = source.body.pages.find((candidate) => candidate.key === key);
    return (page === undefined ? undefined : compiledPageIds?.[page.id]?.pageId) ?? `draft:${key}`;
  };
  const item = (entry: ApplicationSourceDocument["body"]["navigation"][number]): NavigationItem => {
    switch (entry.type) {
      case "heading": return { type: "heading", id: entry.id, label: entry.label, icon: entry.icon,
        children: entry.children.map(item) } as unknown as NavigationItem;
      case "page": return { type: "page", id: entry.id, label: entry.label, icon: entry.icon,
        pageId: pageIdOf(entry.page), permissionKey: entry.permission } as unknown as NavigationItem;
      case "external": return { type: "external", id: entry.id, label: entry.label, icon: entry.icon,
        address: entry.address, permissionKey: entry.permission } as unknown as NavigationItem;
    }
  };
  const navigation = source.body.navigation.map(item);
  return projectNavigation(navigation, decisions ??
    Object.fromEntries(collectNavigationPermissionKeys(navigation).map((key) => [key, true])));
};
