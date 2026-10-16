import {
  applicationSourceDocumentSchema,
  DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";

export type MinimumApplicationInputs = Readonly<{
  key: string;
  name: string;
  description: string;
  moduleKey: string;
  moduleVersionSelection: "exact" | "allowed_range";
  moduleVersion: string;
  roleKey: string;
  roleName: string;
  homeName: string;
}>;

type MinimumApplicationSourceResult =
  | Readonly<{ kind: "valid"; source: ApplicationSourceDocument }>
  | Readonly<{
      kind: "invalid";
      message: string;
      fieldErrors: Readonly<Partial<Record<keyof MinimumApplicationInputs, string>>>;
    }>;

/** The input each authored source path is edited in. */
const inputForPath = (path: readonly PropertyKey[]): keyof MinimumApplicationInputs | undefined => {
  const [head, section, index, leaf] = path.map(String);
  if (head === "key") return "key";
  if (head !== "body") return undefined;
  if (section === "name" || section === "description") return section;
  if (section === "module_bindings" && index === "0")
    return leaf === "module" ? "moduleKey" : leaf === "version" ? "moduleVersion" : undefined;
  if (section === "permissions" && index === "0") return "key";
  if (section === "roles" && index === "0")
    return leaf === "name" ? "roleName" : leaf === "key" ? "roleKey" : "key";
  if (section === "pages" && index === "0") return leaf === "name" ? "homeName" : "key";
  return undefined;
};

/** Authored aliases are local identities; permanent root identities come only from Definition. */
export const minimumApplicationSource = (
  inputs: MinimumApplicationInputs,
): MinimumApplicationSourceResult => {
  const applicationKey = inputs.key.trim();
  const permissionKey = `${applicationKey}.home.view`;
  const parsed = applicationSourceDocumentSchema.safeParse({
    source_contract_version: "2.0.0",
    root_alias: "application_root",
    key: applicationKey,
    kind: "application",
    body: {
      name: inputs.name.trim(),
      description: inputs.description.trim(),
      icon: "layout-dashboard",
      home_page: "home",
      module_bindings: [{
        module: inputs.moduleKey.trim(),
        version: inputs.moduleVersionSelection === "exact"
          ? { selection: "exact", version: inputs.moduleVersion.trim() }
          : { selection: "allowed_range", expression: inputs.moduleVersion.trim() },
        purpose: "primary",
      }],
      permissions: [{
        id: "permission_home",
        key: permissionKey,
        label: "View home",
        description: "View the application's home page.",
        action_kind: "named",
        named_action: "view_home",
        administrative: false,
      }],
      roles: [{
        id: "role_member",
        key: inputs.roleKey.trim(),
        name: inputs.roleName.trim(),
        home_page: "home",
        permissions: [permissionKey],
      }],
      pages: [{
        id: "page_home",
        key: "home",
        name: inputs.homeName.trim(),
        type: "dashboard",
        permission: permissionKey,
        composition: {
          root: { props: { vortex: { shell: null, slot_orders: {} } } },
          content: [],
        },
      }],
      navigation: [],
      queries: [],
      pipelines: [],
      connection_bindings: [],
      interfaces: [],
      actions: [],
      events: [],
      public_addresses: [],
      platform_block_dependencies: [],
      shells: [],
      flows: [],
      flow_bindings: [],
      theme: {
        base: {
          kind: "platform_theme",
          catalogue_theme_id: DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY.catalogueThemeId,
          release_version: DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY.releaseVersion,
        },
        selection: DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
        token_overrides: {},
      },
    },
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<keyof MinimumApplicationInputs, string>> = {};
    for (const issue of parsed.error.issues) {
      const input = inputForPath(issue.path);
      if (input !== undefined && fieldErrors[input] === undefined) fieldErrors[input] = issue.message;
    }
    return {
      kind: "invalid",
      message: Object.keys(fieldErrors).length === 0
        ? "The application could not be built from these inputs."
        : "Fix the highlighted fields.",
      fieldErrors,
    };
  }
  return { kind: "valid", source: parsed.data };
};
