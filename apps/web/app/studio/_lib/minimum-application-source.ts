import {
  addOwnedInlineModule,
  applicationSourceContractVersion,
  applicationSourceDocumentSchema,
  DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import { studioStarterFrame } from "@vortex/ui/studio";

/** What a builder enters for a new application; everything else is made from it. */
export type MinimumApplicationInputs = Readonly<{
  name: string;
  description: string;
  /** The permanent key; empty to make it from the name. */
  key: string;
}>;

type MinimumApplicationSourceResult =
  | Readonly<{ kind: "valid"; source: ApplicationSourceDocument }>
  | Readonly<{
      kind: "invalid";
      message: string;
      fieldErrors: Readonly<Partial<Record<keyof MinimumApplicationInputs, string>>>;
    }>;

/** The key a new application gets from its name: `app.` and the name's words, `app.assets_hub`, cut to the 40-character segment limit. */
export const applicationKeyFromName = (name: string): string => {
  const words = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[_0-9]+|_+$/g, "");
  return words === "" ? "" : `app.${words.slice(0, 40).replace(/_+$/, "")}`;
};

/** The input each authored source path is edited in; everything made from the key reports on it. */
const inputForPath = (path: readonly PropertyKey[]): keyof MinimumApplicationInputs | undefined => {
  const [head, section] = path.map(String);
  if (head === "key") return "key";
  if (head !== "body") return undefined;
  if (section === "name" || section === "description") return section;
  if (section === "modules" || section === "permissions" || section === "roles" || section === "pages") return "key";
  return undefined;
};

const invalid = (
  fieldErrors: Partial<Record<keyof MinimumApplicationInputs, string>>,
): MinimumApplicationSourceResult => ({
  kind: "invalid",
  message: Object.keys(fieldErrors).length === 0
    ? "The application could not be built from these inputs."
    : "Fix the highlighted fields.",
  fieldErrors,
});

/**
 * A new application from its name and description: its key (made from the name unless set), a
 * home page, the permission to view it, a Members access group that holds it, and the one Module
 * the application owns, empty until its first record type. It uses no other application's Module.
 * It starts in a layout with the application menu, its home page saying what to do next.
 * Authored aliases are local identities; permanent root identities come only from Definition.
 */
export const minimumApplicationSource = (
  inputs: MinimumApplicationInputs,
  catalogue: ImmutablePlatformBlockCatalogue,
): MinimumApplicationSourceResult => {
  const name = inputs.name.trim();
  const description = inputs.description.trim();
  if (name === "" || description === "")
    return invalid({
      ...(name === "" ? { name: "Enter the application's name." } : {}),
      ...(description === "" ? { description: "Enter what people use this application for." } : {}),
    });
  const applicationKey = inputs.key.trim() === "" ? applicationKeyFromName(name) : inputs.key.trim();
  if (applicationKey === "")
    return invalid({ key: "The name has no letters to make a key from. Set the key under Advanced." });
  const permissionKey = `${applicationKey}.home.view`;
  const candidate = {
    source_contract_version: applicationSourceContractVersion,
    root_alias: "application_root",
    key: applicationKey,
    kind: "application",
    body: {
      name,
      description,
      icon: "layout-dashboard",
      home_page: "home",
      modules: [],
      uses: [],
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
        key: "member",
        name: "Members",
        home_page: "home",
        permissions: [permissionKey],
        default_member: true,
      }],
      pages: [{
        id: "page_home",
        key: "home",
        name: "Home",
        type: "dashboard",
        permission: permissionKey,
        composition: {
          root: { props: { vortex: { shell: null, slot_orders: {} } } },
          content: [],
        },
      }],
      navigation: [],
      connection_bindings: [],
      interfaces: [],
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
      },
    },
  } as unknown as ApplicationSourceDocument;
  const added = addOwnedInlineModule(candidate, {
    key: `${applicationKey}.data`,
    name: `${name} data`.slice(0, 120),
  });
  if (added.kind === "invalid")
    return invalid({ key: "Use lowercase words separated by dots, at most 100 characters, for example team.workspace." });
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<keyof MinimumApplicationInputs, string>> = {};
    for (const issue of parsed.error.issues) {
      const input = inputForPath(issue.path);
      if (input === undefined || fieldErrors[input] !== undefined) continue;
      // Everything made from the key fails with the key: name the key's rule, not the made item.
      fieldErrors[input] = input === "key"
        ? "Use lowercase words separated by dots, at most 100 characters, for example team.workspace."
        : issue.message;
    }
    return invalid(fieldErrors);
  }
  const framed = studioStarterFrame(catalogue, parsed.data);
  if (framed.kind === "refused") {
    console.error("[studio] new application starter frame refused", framed.message);
    return { kind: "invalid", message: `The application could not be built: ${framed.message}`, fieldErrors: {} };
  }
  return { kind: "valid", source: framed.source };
};
