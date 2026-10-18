import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  defaultSaveFlowSource,
  type ApplicationSourceDocument,
  type PlatformBlockReleaseIdentity,
  type SourceItemVortex,
} from "@vortex/platform/schema";
import { loadApplicationSource } from "../application-source-loader";
import { tasksModule } from "./module";

const {
  APPLICATION_NAVIGATION_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  CONTAINER_BLOCK_RELEASE,
  CONTAINER_BLOCK_RELEASE_1_2_0,
  FORM_CONTAINER_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE_1_3_0,
  TEXT_INPUT_BLOCK_RELEASE,
} = PLATFORM_BLOCK_RELEASE_IDENTITIES;

const recordType = "vortex.tasks:task";
const query = "vortex.tasks:tasks";
const readPage = "application.tasks.read";
const createPage = "application.tasks.create";
const layout = {
  visible: true,
  width: { kind: "fill" as const },
  height: { kind: "content" as const },
};
/** One authored item before it is named: renderer, plain settings, child slots and metadata. */
const placement = (
  release: PlatformBlockReleaseIdentity,
  settings: Record<string, unknown> = {},
  slots: Record<string, readonly unknown[]> = {},
  bindings: Partial<Pick<SourceItemVortex, "query">> = {},
) => ({
  type: release.rendererKey,
  props: {
    ...settings,
    ...slots,
    vortex: {
      block: { block_id: release.blockId, release_version: release.releaseVersion },
      ...bindings,
      responsive: { desktop: layout },
    },
  },
});
type Placement = ReturnType<typeof placement>;
/** A slot's items in desktop order, each named by its alias. */
const slot = (entries: Record<string, Placement>) =>
  Object.entries(entries).map(([id, item]) => ({ type: item.type, props: { id, ...item.props } }));
const input = (name: string, label: string, required: boolean) =>
  placement(TEXT_INPUT_BLOCK_RELEASE, {
    name,
    label,
    required,
  });
const page = (
  key: string,
  name: string,
  type: "list" | "form",
  permission: string,
  content: Record<string, Placement>,
) => ({
  id: `page_tasks_${key}`,
  key,
  name,
  type,
  record_type: recordType,
  permission,
  ...(type === "list" ? { query } : {}),
  composition: {
    root: {
      props: { slot_primary: slot(content), vortex: { shell: "shell_tasks", slot_orders: {} } },
    },
    content: [],
  },
});

const shell = {
  id: "shell_tasks",
  key: "tasks_shell",
  name: "Tasks shell",
  presentation: {
    sidebar: { collapsible: "icon", default_collapsed: false },
    top_bar: {
      breadcrumbs: true,
      organization_switcher: true,
      application_switcher: true,
      account_menu: true,
      appearance_toggle: true,
    },
  },
  layout: {
    root: { props: { vortex: { slot_orders: {} } } },
    content: slot({
      shell_root: placement(
        CONTAINER_BLOCK_RELEASE,
        {
          direction: "column",
          gap: "medium",
        },
        {
          header: slot({}),
          content: slot({
            shell_body: placement(
              CONTAINER_BLOCK_RELEASE_1_2_0,
              {
                direction: "row",
                gap: "medium",
                menu_width: 16,
                menu_placement: "sticky",
                content_landmark: true,
                tablet_menu_width: 14,
                phone_direction: "column",
                phone_menu_placement: "flow",
              },
              {
                menu: slot({
                  shell_navigation: placement(APPLICATION_NAVIGATION_BLOCK_RELEASE, {
                    title: "Tasks",
                  }),
                }),
                content: slot({}),
              },
            ),
          }),
        },
      ),
    }),
  },
  content_slots: [
    {
      id: "slot_primary",
      key: "primary",
      label: "Primary",
      required: true,
      allowed_child_categories: [
        "content",
        "data",
        "figures",
        "record",
        "actions",
        "input",
        "layout",
      ],
      parent_placement: "shell_body",
      parent_slot: "content",
    },
  ],
};

/** The module supplies records and queries; this Application supplies navigation and pages. */
export const tasksApplication: ApplicationSourceDocument = loadApplicationSource(
  {
    source_contract_version: "3.0.0",
    root_alias: "app_tasks",
    key: "vortex.app.tasks",
    kind: "application",
    body: {
      name: "Tasks",
      description: "A small task list and creation form.",
      icon: "check-square",
      home_page: "tasks",
      uses: [],
      permissions: [
        {
          id: "perm_app_tasks_read",
          key: readPage,
          label: "Open tasks",
          description: "Opens the task list.",
          action_kind: "named",
          named_action: "read_tasks",
          administrative: false,
        },
        {
          id: "perm_app_tasks_create",
          key: createPage,
          label: "Open task creation",
          description: "Opens the task creation form.",
          action_kind: "named",
          named_action: "create_task",
          administrative: false,
        },
      ],
      roles: [
        {
          id: "role_tasks_user",
          key: "tasks_user",
          default_member: true,
          name: "Tasks user",
          home_page: "tasks",
          permissions: [readPage, createPage, "vortex.tasks.task.create", "vortex.tasks.task.read"],
        },
      ],
      navigation: [
        {
          id: "nav_tasks_list",
          type: "page",
          label: "Tasks",
          icon: "check",
          page: "tasks",
          permission: readPage,
        },
        {
          id: "nav_tasks_create",
          type: "page",
          label: "Create task",
          icon: "plus",
          page: "new_task",
          permission: createPage,
        },
      ],
      connection_bindings: [],
      interfaces: [],
      events: [
        {
          id: "event_task_create",
          key: "vortex.app.events.tasks_create",
          record_type: recordType,
          carries: [],
          personal_or_sensitive_values_allowed: false,
        },
      ],
      public_addresses: [],
      shells: [shell],
      pages: [
        page("tasks", "Tasks", "list", readPage, {
          tasks_table: placement(
            TABLE_BLOCK_RELEASE_1_3_0,
            {
              title: "Tasks",
              columns: (["title", "notes"] as const).map((field) => ({
                field: `${recordType}.${field}`,
                label: field === "title" ? "Title" : "Notes",
              })),
            },
            {},
            { query },
          ),
        }),
        page("new_task", "Create task", "form", createPage, {
          form_new_task: placement(
            FORM_CONTAINER_BLOCK_RELEASE,
            {
              title: "Create task",
            },
            {
              content: slot({
                input_task_title: input("title", "Title", true),
                input_task_notes: input("notes", "Notes", false),
                submit_new_task: placement(BUTTON_BLOCK_RELEASE, {
                  label: "Create task",
                  action_kind: "submit",
                  variant: "primary",
                }),
              }),
            },
          ),
        }),
      ],
      flows: [
        {
          ...defaultSaveFlowSource({
            id: "flow_create_task",
            key: "create_task",
            description: "Saves a task submitted from the creation form.",
            recordType,
            mode: "create",
            ownershipMode: "none",
          }),
          labels: { name: "Create task" },
        },
      ],
      flow_bindings: [
        {
          id: "binding_create_task",
          control: "form_new_task",
          event_id: "event_task_create",
          event: "form_submit",
          flow: "flow_create_task",
          inputs: { values: { kind: "caller", name: "values" } },
        },
      ],
    },
  },
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  [tasksModule],
);
