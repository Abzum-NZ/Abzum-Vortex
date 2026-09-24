import {
  applicationSourceDocumentV2Schema,
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  FORM_CONTAINER_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
  type ProtectedReadModelKey,
  type SourceBlockPropertyValueV2Contract,
} from "@vortex/contracts";

const placementLayout = {
  visible: true,
  width: { kind: "fill" as const },
  height: { kind: "content" as const },
};

/** Authored V2 block placement: exact block release, typed settings and named child slots. */
const placement = (
  release: PlatformBlockReleaseV2,
  settings: Record<string, SourceBlockPropertyValueV2Contract> = {},
  slots: Record<string, unknown> = {},
) => ({
  block: { block_id: release.blockId, release_version: release.releaseVersion },
  settings,
  theme_overrides: {},
  responsive: { desktop: placementLayout },
  slots,
});

const emptySlot = { placements: {} as Record<string, unknown>, order: { desktop: [] as string[] } };

const slot = (alias: string, value: unknown) => ({
  placements: { [alias]: value },
  order: { desktop: [alias] },
});

const usedBlockReleases = [
  TEXT_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
];

const platformBlockDependencies = usedBlockReleases
  .map((release) => ({
    kind: "platform_block" as const,
    block_id: String(release.blockId),
    release_version: release.releaseVersion,
    content_fingerprint: release.contentFingerprint,
    catalogue_fingerprint: release.catalogueFingerprint,
  }))
  .sort((left, right) => (left.block_id < right.block_id ? -1 : left.block_id > right.block_id ? 1 : 0));

const theme = {
  base: {
    kind: "platform_theme" as const,
    catalogue_theme_id: String(DEFAULT_PLATFORM_THEME_RELEASE_V2.catalogueThemeId),
    release_version: DEFAULT_PLATFORM_THEME_RELEASE_V2.releaseVersion,
    content_fingerprint: DEFAULT_PLATFORM_THEME_RELEASE_V2.contentFingerprint,
    catalogue_fingerprint: DEFAULT_PLATFORM_THEME_RELEASE_V2.catalogueFingerprint,
  },
  token_overrides: {},
};

const shell = {
  id: "shell_tenant_administration",
  key: "tenant_administration_shell",
  name: "Tenant administration shell",
  layout: {
    placements: {
      shell_root: placement(
        TABS_BLOCK_RELEASE,
        { title: { kind: "text", value: "Tenant administration" } },
        { tab_one: emptySlot },
      ),
    },
    order: { desktop: ["shell_root"] },
  },
  content_slots: [
    {
      id: "slot_primary",
      key: "primary",
      label: "Primary",
      required: true,
      allowed_child_categories: ["content", "data", "figures", "record", "actions", "input", "layout"],
      parent_placement: "shell_root",
      parent_slot: "tab_one",
    },
  ],
};

const dashboardStates = ["normal", "loading", "empty", "refused", "failure", "recovery"];
const listStates = ["normal", "loading", "empty", "refused", "access_ended", "failure", "recovery"];
const formStates = ["normal", "loading", "validation", "refused", "conflict", "failure", "recovery"];

const textBlock = (title: string, text: string) =>
  placement(TEXT_BLOCK_RELEASE, {
    title: { kind: "text", value: title },
    text: { kind: "text", value: text },
  });

/**
 * A protected read-model placement. The closed placement binding names one declared platform read
 * model and reads it live under the viewer's current authority. It never carries a query, so live
 * protected data is never copied into an application record.
 */
const readModelBlock = (key: ProtectedReadModelKey, title: string) => ({
  ...placement(TABLE_BLOCK_RELEASE, { title: { kind: "text", value: title } }),
  read_model: key,
});

/**
 * The Tenant Administration application definition. Every visible region is
 * definition-led. Ordinary lifecycle requests come from the bound module; the
 * protected tenant-structure and role assignment ledger regions read live protected
 * read models. No region offers a parallel access-grant control: grants run in IAM.
 */
export const tenantAdministrationApplication: ApplicationSourceDocumentV2 =
  applicationSourceDocumentV2Schema.parse({
    source_contract_version: "2.0.0",
    root_alias: "app_tenant_administration",
    key: "vortex.app.tenant_administration",
    kind: "application",
    body: {
      name: "Tenant Administration",
      description:
        "Tenant structure and organisation lifecycle for a tenant administrator, entirely definition-led.",
      icon: "building-2",
      home_page: "tenant_overview",
      module_bindings: [
        {
          module: "vortex.tenant_administration",
          version: { selection: "exact", version: "1.0.0" },
          purpose: "primary",
        },
      ],
      permissions: [
        {
          id: "app_permission_open",
          key: "application.tenant_administration.open",
          label: "Open Tenant Administration",
          description: "Allows opening the Tenant Administration application.",
          action_kind: "named",
          named_action: "open",
          administrative: false,
        },
        {
          id: "app_permission_manage",
          key: "application.tenant_administration.manage",
          label: "Manage Tenant Administration",
          description: "Allows managing Tenant Administration definition-level administration.",
          action_kind: "manage",
          administrative: true,
        },
      ],
      roles: [
        {
          id: "role_tenant_administrator",
          key: "tenant_administrator",
          name: "Tenant administrator",
          home_page: "tenant_overview",
          permissions: [
            "application.tenant_administration.open",
            "vortex.tenant_administration.organization_lifecycle_request.create",
            "vortex.tenant_administration.organization_lifecycle_request.read",
            "vortex.tenant_administration.organization_lifecycle_request.update",
            "vortex.tenant_administration.organization_lifecycle_request.soft_delete",
            "vortex.tenant_administration.organization_lifecycle_request.restore",
            "vortex.tenant_administration.organization_lifecycle_request.export",
            "vortex.tenant_administration.organization_lifecycle_request.submit",
          ],
        },
      ],
      navigation: [
        {
          id: "nav_tenant",
          type: "heading",
          label: "Tenant",
          children: [
            {
              id: "nav_overview",
              type: "page",
              label: "Overview",
              page: "tenant_overview",
              permission: "application.tenant_administration.open",
            },
            {
              id: "nav_structure",
              type: "page",
              label: "Tenant structure",
              page: "tenant_structure",
              permission: "application.tenant_administration.open",
            },
            {
              id: "nav_requests",
              type: "page",
              label: "Lifecycle requests",
              page: "organization_lifecycle_requests",
              permission: "vortex.tenant_administration.organization_lifecycle_request.read",
            },
          ],
        },
        {
          id: "nav_access",
          type: "heading",
          label: "Access",
          children: [
            {
              id: "nav_administrators",
              type: "page",
              label: "Tenant administrators",
              page: "tenant_administrators",
              permission: "application.tenant_administration.open",
            },
          ],
        },
      ],
      queries: [
        {
          id: "qry_lifecycle_requests",
          key: "organization_lifecycle_requests",
          record_type: "vortex.tenant_administration:organization_lifecycle_request",
          select: [
            "subject_display_name",
            "change_kind",
            "requested_display_name",
            "requested_parent_reference",
            "state",
          ],
          filter: null,
          group_by: [],
          aggregates: [],
          sort: [{ field: "subject_display_name", direction: "ascending" }],
          page_size: 50,
          relationship_hops: 0,
        },
      ],
      workflows: [],
      pipelines: [],
      connection_bindings: [],
      interfaces: [],
      actions: [],
      rules: [],
      events: [],
      public_addresses: [],
      platform_block_dependencies: platformBlockDependencies,
      shells: [shell],
      pages: [
        {
          id: "page_tenant_overview",
          key: "tenant_overview",
          name: "Tenant overview",
          type: "dashboard",
          permission: "application.tenant_administration.open",
          states: dashboardStates,
          composition: {
            shell_kind: "application",
            shell: "shell_tenant_administration",
            content: {
              slot_primary: slot(
                "overview_text",
                textBlock(
                  "Tenant overview",
                  "Review tenant structure and organisation lifecycle requests. Protected tenant structure and the organisation's role assignment ledger are read live on their own pages; nothing is copied into application records. A tenant administrator listing is not yet available.",
                ),
              ),
            },
          },
        },
        {
          id: "page_tenant_structure",
          key: "tenant_structure",
          name: "Tenant structure",
          type: "dashboard",
          permission: "application.tenant_administration.open",
          states: dashboardStates,
          composition: {
            shell_kind: "application",
            shell: "shell_tenant_administration",
            content: {
              slot_primary: slot(
                "structure_region",
                readModelBlock("tenant_structure", "Tenant structure"),
              ),
            },
          },
        },
        {
          id: "page_tenant_administrators",
          key: "tenant_administrators",
          name: "Tenant administrators",
          type: "dashboard",
          permission: "application.tenant_administration.open",
          states: dashboardStates,
          composition: {
            shell_kind: "application",
            shell: "shell_tenant_administration",
            content: {
              slot_primary: {
                placements: {
                  administrators_text: textBlock(
                    "Tenant administrators",
                    "A tenant administrator listing is not yet available: no protected read model provides one. The role assignment ledger below is not that list; it is the organisation's role assignment ledger, including revoked and expired entries, read live from protected Access. Granting and revoking tenant-administrator access runs through IAM, never from this application.",
                  ),
                  administrators_region: readModelBlock(
                    "effective_assignments",
                    "Role assignment ledger",
                  ),
                },
                order: { desktop: ["administrators_text", "administrators_region"] },
              },
            },
          },
        },
        {
          id: "page_organization_lifecycle_requests",
          key: "organization_lifecycle_requests",
          name: "Organisation lifecycle requests",
          type: "list",
          record_type: "vortex.tenant_administration:organization_lifecycle_request",
          permission: "vortex.tenant_administration.organization_lifecycle_request.read",
          query: "organization_lifecycle_requests",
          arrangements: ["table", "summary"],
          states: listStates,
          composition: {
            shell_kind: "application",
            shell: "shell_tenant_administration",
            content: {
              slot_primary: slot(
                "requests_table",
                {
                  ...placement(TABLE_BLOCK_RELEASE, {
                    title: { kind: "text", value: "Organisation lifecycle requests" },
                  }),
                  query: "organization_lifecycle_requests",
                },
              ),
            },
          },
        },
        {
          id: "page_record_lifecycle_request",
          key: "record_lifecycle_request",
          name: "Submit organisation lifecycle request",
          type: "form",
          record_type: "vortex.tenant_administration:organization_lifecycle_request",
          permission: "vortex.tenant_administration.organization_lifecycle_request.submit",
          commit_action: "vortex.tenant_administration.organization_lifecycle_request.submit",
          states: formStates,
          composition: {
            shell_kind: "application",
            shell: "shell_tenant_administration",
            content: {
              slot_primary: slot(
                "request_form",
                placement(
                  FORM_CONTAINER_BLOCK_RELEASE,
                  { title: { kind: "text", value: "Submit organisation lifecycle request" } },
                  {
                    content: slot(
                      "request_reason",
                      placement(TEXT_INPUT_BLOCK_RELEASE, {
                        name: { kind: "text", value: "reason" },
                        label: { kind: "text", value: "Reason" },
                        required: { kind: "boolean", value: true },
                        multiline: { kind: "boolean", value: true },
                      }),
                    ),
                  },
                ),
              ),
            },
          },
        },
      ],
      theme,
      flows: [],
      flow_bindings: [],
    },
  });
