import type {
  InstalledRuntimeContext,
  ProjectedNavigation,
  PrivateFormDraftFieldValidation,
  PermittedApplicationsRead,
  PermittedApplication,
} from "@web/platform-server";
import type {
  ApplicationShell,
  JsonValue,
  BoardColumnContinuationRequest,
  PageDefinition,
} from "@vortex/platform/schema";
import type { PageWebMcpTool } from "./webmcp-projection";
export type { PageWebMcpTool } from "./webmcp-projection";

export type PageDataState = Readonly<Record<string, unknown>>;

/** One flow binding a placement holds, described only by identities and the caller inputs it takes. */
export type PlacementFlowBinding = Readonly<{
  bindingId: string;
  eventId: string;
  event: string;
  flowId: string;
  /** The names of the caller inputs the bound flow declares; the surface may fill only these. */
  callerInputs: readonly string[];
  /** The installed record type of this placement's selected row or enclosing form context. */
  recordTypeId?: string;
  /** Caller inputs consumed by a declared `record.read_fields` task in this exact flow. */
  selectedReadInputs?: readonly Readonly<{
    callerInputName: string;
    recordTypeId: string;
  }>[];
}>;

export type ApplicationPageModel = Readonly<{
  page: Readonly<Record<string, unknown>>;
  pageId: string;
  pageName: string;
  shells: readonly ApplicationShell[];
  applicationShell?: ApplicationShell;
  applicationName: string;
  applicationHomePageKey: string;
  /** Whether the installed release configures search, so a page without a search request needs no search read. */
  searchEnabled: boolean;
  availableApplications: readonly Readonly<{ key: string; name: string; homePageKey: string }>[];
  theme: InstalledRuntimeContext["releaseSet"]["application"]["content"]["theme"];
  navigation: ProjectedNavigation;
  /** Structural body visibility only; absence on guided pages preserves their active-step UI. */
  bodyContentAvailable?: boolean;
  /** Current Access revision used to re-register page tools after a permission change. */
  accessVersion: number;
  /** Permission-filtered tools that map to one usable control on this page. */
  webMcpTools: readonly PageWebMcpTool[];
  /** Ready display data per data placement, by stable placement identity. */
  data: Readonly<Record<string, PageDataState>>;
  /** Each placement's flow bindings, by stable placement identity. */
  bindings: Readonly<Record<string, readonly PlacementFlowBinding[]>>;
  /** Data placements to re-read after a write from each installed flow binding. */
  refreshPlacementsByBinding: Readonly<Record<string, readonly string[]>>;
  /** Displayed values of readable edit fields, used only to omit unchanged fields on submit. */
  editFormBaselines: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  /** Dynamic reference-choice placements within the viewer's projected page. */
  referenceChoiceInputs: readonly Readonly<{
    placementId: string;
    formId: string;
    fieldKey: string;
    releaseVersion: "1.1.0" | "1.2.0";
    dependency?: Readonly<{ fieldKey: string; placementId: string }>;
  }>[];
  guidedForm?: Readonly<{
    draftId: string;
    revision: number;
    flowId: string;
    activeStepId: string;
    computedStepId: string;
    values: Readonly<Record<string, JsonValue>>;
    validation: Readonly<Record<string, PrivateFormDraftFieldValidation>>;
  }>;
  /** Permitted pages of this application, so a menu or navigate intent can be turned into an address. */
  pages: readonly Readonly<{ pageId: string; key: string }>[];
  /**
   * The record a detail or form page is about, when its address names one the viewer could read,
   * with the revision the viewer was shown. Flows started on the page carry it as evidence for
   * their record tasks and named actions; the protected record paths decide what it may do.
   */
  subject?: Readonly<{ recordId: string; revision: number }>;
  /**
   * The deliberate adoption offer, present only for a caller who may manage installations and
   * only when the application root publishes a release newer than the installed one. Its presence
   * is a rendering hint; the adoption action re-checks everything on the server.
   */
  adoption?: Readonly<{
    offeredReleaseRevision: number;
    offeredReleaseVersion: string;
    installedReleaseRevision: number;
  }>;
  invocation: Readonly<{
    tenantShortName: string;
    organizationShortName: string;
    applicationKey: string;
    pageKey: string;
    installationRevision: number;
    releaseKey: string;
  }>;
}>;

export type ApplicationPageResult =
  | Readonly<{ kind: "available"; model: ApplicationPageModel }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type ApplicationPagePlacementReadResult =
  | Readonly<{
      kind: "available";
      data: Readonly<Record<string, PageDataState>>;
      editFormBaselines: Readonly<Record<string, Readonly<Record<string, JsonValue>> | null>>;
      subject: ApplicationPageModel["subject"] | null;
    }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type ApplicationPageInternalResult = ApplicationPageResult | Readonly<{ kind: "reload" }>;

export type ApplicationPageLoaderAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  pageKey: string;
}>;

export type SearchParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

export type BoardContinuationTarget = Readonly<{
  placementId: string;
  request: BoardColumnContinuationRequest;
}>;

export type TableContinuationTarget = Readonly<{
  placementId: string;
  request: Readonly<{ page: number; continuationToken?: string }>;
}>;

export type ModuleRelease = InstalledRuntimeContext["releaseSet"]["modules"][number];

export type ModuleField = ModuleRelease["content"]["recordTypes"][number]["fields"][number];

export type PermissionEntry = InstalledRuntimeContext["permissionRegistration"]["entries"][number];

export type DateTimeZones = { personTimeZone?: string; organizationTimeZone?: string };

export type InstalledFlow =
  InstalledRuntimeContext["releaseSet"]["application"]["content"]["flows"][number];

/** The resolved record type the page's own address names the subject of. */
export type PageSubjectType = Extract<
  NonNullable<
    Extract<PageDefinition, { type: "detail" | "public" | "form" | "guided_form" }>["recordType"]
  >,
  { state: "resolved" }
>;
