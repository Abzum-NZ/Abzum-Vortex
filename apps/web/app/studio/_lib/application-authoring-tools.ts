import {
  moduleFieldTypeLabels,
  personalDataClassSchema,
  publicDisplaySchema,
  revisionSchema,
  searchPrioritySchema,
  sourceApplicationBodySchema,
} from "@vortex/platform/schema";
import { z } from "zod";

const revision = revisionSchema.describe(
  "The saved draftRevision from read_application_draft. Read again after a conflict.",
);
const body = sourceApplicationBodySchema.shape;
const instruction =
  " Supplied collections replace those collections completely; preserve existing ids and entries you want to keep. Omitted collections stay unchanged. Nothing is published. Validation errors identify their location.";
const fieldChange = z
  .object({
    moduleKey: z.string().min(1),
    recordAlias: z.string().min(1),
    label: z.string().min(1),
    helpText: z.string(),
    type: z.enum(Object.keys(moduleFieldTypeLabels) as [string, ...string[]]),
    required: z.boolean(),
    unique: z.boolean(),
    filterable: z.boolean(),
    sortable: z.boolean(),
    searchPriority: searchPrioritySchema
      .nullable()
      .describe(
        "Search index ranking metadata, or null to remove it. Field type and privacy rules still apply.",
      ),
    personalData: personalDataClassSchema,
    publicDisplay: publicDisplaySchema,
    settings: z.record(z.string(), z.json()),
    defaultValue: z.json().optional(),
    cardinality: z.enum(["one_to_one", "many_to_one"]).optional(),
  })
  .strict();

/** These are the current source contracts, also used by Studio's source import and save. */
export const applicationAuthoringTools = {
  add_module_field: {
    description:
      "Add a field to an owned module record type with the Data tab's field command. Read list_module_fields first for aliases and setting declarations. Supply the complete field configuration; keys and aliases are derived from its label. Published record types accept optional fields only.",
    input: z.object({ draftRevision: revision, field: fieldChange }).strict(),
    readOnly: false,
  },
  change_module_field: {
    description:
      "Change an owned module field with the Data tab's field command. Read list_module_fields first and preserve settings you want to keep. Supply the complete configuration and its existing fieldAlias. Published field storage cannot change.",
    input: z
      .object({
        draftRevision: revision,
        field: fieldChange.extend({ fieldAlias: z.string().min(1) }),
      })
      .strict(),
    readOnly: false,
  },
  change_application_pages: {
    description:
      "Create, change or remove pages and their placements using the source returned by read_application_draft. Include navigation, home_page and roles when changing page references atomically." +
      instruction,
    input: z
      .object({
        draftRevision: revision,
        changes: z
          .object({
            pages: body.pages,
            shells: body.shells.optional(),
            navigation: body.navigation.optional(),
            home_page: body.home_page.optional(),
            roles: body.roles.optional(),
            platform_block_dependencies: body.platform_block_dependencies.optional(),
          })
          .strict(),
      })
      .strict(),
    readOnly: false,
  },
  change_application_navigation: {
    description:
      "Change the application's navigation and optionally its home page and role home pages, using their current source keys." +
      instruction,
    input: z
      .object({
        draftRevision: revision,
        changes: z
          .object({
            navigation: body.navigation,
            home_page: body.home_page.optional(),
            roles: body.roles.optional(),
          })
          .strict(),
      })
      .strict(),
    readOnly: false,
  },
  change_application_flows: {
    description:
      "Create or change application flows and bind placement events (including buttons) through flow_bindings. Every binding's event_id names an entry in events; include events when adding a binding. Include pages when adding or changing a bound placement in the same edit. Use the current flow source contract." +
      instruction,
    input: z
      .object({
        draftRevision: revision,
        changes: z
          .object({
            flows: body.flows,
            flow_bindings: body.flow_bindings.optional(),
            events: body.events.optional(),
            pages: body.pages.optional(),
            shells: body.shells.optional(),
            platform_block_dependencies: body.platform_block_dependencies.optional(),
          })
          .strict(),
      })
      .strict(),
    readOnly: false,
  },
  change_application_data_model: {
    description:
      "Create or change owned modules, record types, fields, relationships and saved queries in the application's Data tab source. Borrowed modules are read-only; uses pins their releases. Include permissions and roles when changing access references atomically." +
      instruction,
    input: z
      .object({
        draftRevision: revision,
        changes: z
          .object({
            modules: body.modules,
            uses: body.uses.optional(),
            permissions: body.permissions.optional(),
            roles: body.roles.optional(),
          })
          .strict(),
      })
      .strict(),
    readOnly: false,
  },
} as const;

export type ApplicationAuthoringToolName = keyof typeof applicationAuthoringTools;
