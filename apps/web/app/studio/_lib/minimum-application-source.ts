import {
  applicationSourceDocumentV2Schema,
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";

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

export type MinimumApplicationSourceResult =
  | Readonly<{ kind: "valid"; source: ApplicationSourceDocumentV2 }>
  | Readonly<{ kind: "invalid"; message: string }>;

/** Authored aliases are local identities; permanent root identities come only from Definition. */
export const minimumApplicationSource = (
  inputs: MinimumApplicationInputs,
): MinimumApplicationSourceResult => {
  const applicationKey = inputs.key.trim();
  const permissionKey = `${applicationKey}.home.view`;
  const theme = DEFAULT_PLATFORM_THEME_RELEASE_V2;
  const parsed = applicationSourceDocumentV2Schema.safeParse({
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
          shell_kind: "default",
          main: { placements: {}, order: { desktop: [] } },
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
          catalogue_theme_id: theme.catalogueThemeId,
          release_version: theme.releaseVersion,
          content_fingerprint: theme.contentFingerprint,
          catalogue_fingerprint: theme.catalogueFingerprint,
        },
        token_overrides: {},
      },
    },
  });
  if (!parsed.success)
    return { kind: "invalid", message: "Check the application key, labels and Module version requirement." };
  return { kind: "valid", source: parsed.data };
};
