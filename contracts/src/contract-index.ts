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
    owner: "#12, corrected by #186",
  },
  {
    group: "permissions, roles, grants and protected grant consent",
    layer: "canonical_runtime",
    specification: "04-access-and-permissions.md",
    owner: "#12, corrected by #186",
  },
  {
    group: "modules, record types, fields, actions and rules",
    layer: "canonical_runtime",
    specification: "05-modules-fields-and-relationships.md",
    owner: "#12, corrected by #186",
  },
  {
    group: "applications, pages, blocks, queries and pipelines",
    layer: "canonical_runtime",
    specification: "07-applications-pages-and-themes.md",
    owner: "#12, corrected by #186",
  },
  {
    group: "workflows and protected operations",
    layer: "canonical_runtime",
    specification: "09-workflows-and-pipelines.md",
    owner: "#12, corrected by #186",
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
    group: "activity, retention, protected removal, entitlements and metering",
    layer: "canonical_runtime",
    specification: "14-activity-privacy-and-retention.md; 15-entitlements-and-metering.md",
    owner: "#186",
  },
  {
    group: "safe definition-validation catalogue and translators",
    layer: "canonical_runtime",
    specification: "appendices/data-contracts.md#definition-validation-errors",
    owner: "#13",
  },
] as const;
