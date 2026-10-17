import type { VortexIconName } from "../catalogue/icon-names";
import type { NavigationItem } from "../definition/application-contracts";

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
      icon: VortexIconName;
      children: readonly ProjectedNavigationItem[];
    }>
  | Readonly<{ type: "page"; id: string; label: string; icon: VortexIconName; pageId: string }>
  | Readonly<{ type: "external"; id: string; label: string; icon: VortexIconName; address: string }>;

export type ProjectedNavigation = readonly ProjectedNavigationItem[];

/**
 * One permission decision per distinct permission key. At run time each comes from the viewer's
 * live access; Studio's "who can see this" preview passes the keys a role of the draft grants.
 */
export type NavigationPermissionDecisions = Readonly<Record<string, boolean>>;

/** Whether the decisions grant a key. A missing decision is a refusal, so the projections fail closed. */
export const holdsPermission = (decisions: NavigationPermissionDecisions, permissionKey: string): boolean =>
  Object.hasOwn(decisions, permissionKey) && decisions[permissionKey] === true;

/**
 * Whether a placement is shown for its view gate: an ungated placement always is, a gated one only
 * when its view permission is allowed. The page projection and Studio's preview both judge by it.
 */
export const placementViewShown = (viewPermissionKey: unknown, viewAllowed: boolean | undefined): boolean =>
  viewPermissionKey === undefined || viewAllowed === true;

const projectNavigationItem = (
  item: NavigationItem,
  decisions: NavigationPermissionDecisions,
): ProjectedNavigationItem | undefined => {
  switch (item.type) {
    case "page":
      return holdsPermission(decisions, item.permissionKey)
        ? { type: "page", id: item.id, label: item.label, icon: item.icon, pageId: item.pageId }
        : undefined;
    case "external":
      return holdsPermission(decisions, item.permissionKey)
        ? { type: "external", id: item.id, label: item.label, icon: item.icon, address: item.address }
        : undefined;
    case "heading": {
      const children = item.children.flatMap((child) => {
        const projected = projectNavigationItem(child, decisions);
        return projected === undefined ? [] : [projected];
      });
      // An empty heading is not a navigation item: it disappears with its children.
      return children.length === 0
        ? undefined
        : { type: "heading", id: item.id, label: item.label, icon: item.icon, children };
    }
  }
};

/**
 * Filters one compiled navigation tree to the items the viewer holds, preserving definition
 * order. A missing decision is treated exactly like a refusal, so the pure projection fails
 * closed when it is handed incomplete evidence.
 */
export const projectNavigation = (
  navigation: readonly NavigationItem[],
  decisions: NavigationPermissionDecisions,
): ProjectedNavigation =>
  navigation.flatMap((item) => {
    const projected = projectNavigationItem(item, decisions);
    return projected === undefined ? [] : [projected];
  });

/** Every distinct permission key the compiled navigation declares, for one evaluation each. */
export const collectNavigationPermissionKeys = (
  navigation: readonly NavigationItem[],
): readonly string[] => {
  const keys = new Set<string>();
  const visit = (items: readonly NavigationItem[]): void => {
    for (const item of items) {
      if (item.type === "heading") visit(item.children);
      else keys.add(item.permissionKey);
    }
  };
  visit(navigation);
  return [...keys];
};
