export const contractIndex = [
  {
    group: "identifiers, envelopes, references, storage and lineage",
    layer: "canonical_runtime",
    specification: "appendices/data-contracts.md#identifier-rules",
    owner: "#11",
  },
  {
    group: "tenant, identity and organisation accounts",
    layer: "canonical_runtime",
    specification: "02-people-organisations-and-sign-in.md",
    owner: "#12",
  },
  {
    group: "permissions, roles, grants and approvals",
    layer: "canonical_runtime",
    specification: "04-access-and-permissions.md",
    owner: "#12",
  },
  {
    group: "modules, record types, fields, actions and rules",
    layer: "canonical_runtime",
    specification: "05-modules-fields-and-relationships.md",
    owner: "#12",
  },
  {
    group: "applications, pages, blocks, queries and pipelines",
    layer: "canonical_runtime",
    specification: "07-applications-pages-and-themes.md",
    owner: "#12",
  },
  {
    group: "workflows and protected operations",
    layer: "canonical_runtime",
    specification: "09-workflows-and-pipelines.md",
    owner: "#12",
  },
  {
    group: "files, connections and interfaces",
    layer: "canonical_runtime",
    specification: "11-files-and-attachments.md; 12-connections-and-interfaces.md",
    owner: "#12",
  },
  {
    group: "federation",
    layer: "canonical_runtime",
    specification: "17-runtime-storage-and-caching.md#vortex-federation-between-clusters",
    owner: "#12",
  },
  {
    group: "activity, privacy, retention, plans, usage and announcements",
    layer: "canonical_runtime",
    specification: "14-activity-privacy-and-retention.md; 15-plans-billing-and-usage.md",
    owner: "#12",
  },
  {
    group: "CRM and Service Desk authored JSON",
    layer: "definition_source",
    specification: "appendices/worked-examples.md",
    owner: "#12",
  },
] as const;
