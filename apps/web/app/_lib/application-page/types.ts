import type {
  InstalledRuntimeContext,
  PrivateFormDraftFieldValidation,
  PermittedApplicationsRead,
  PermittedApplication,
} from "@vortex/platform/server";
import type {
  ApplicationShell,
  ProjectedNavigation,
  JsonValue,
  BoardColumnReadRequest,
  PageDefinition,
  RecordsTablePageRequest,
} from "@vortex/platform/schema";
import type { PageWebMcpTool } from "./webmcp-projection";
import type { PlacementFlowBinding } from "@vortex/ui";
export type { PageWebMcpTool } from "./webmcp-projection";
export type { PlacementFlowBinding } from "@vortex/ui";

export type PageDataState = Readonly<Record<string, unknown>>;

/** What a read of selected placements returns: the page without the menu and the page tools. */
export type PlacementReadModel = Readonly<{
  page: Readonly<Record<string, unknown>>;
  pageId: string;
  pageName: string;
  theme: InstalledRuntimeContext["releaseSet"]["application"]["content"]["theme"];
  /** Structural body visibility only; absence on guided pages preserves their active-step UI. */
  bodyContentAvailable?: boolean;
  /**
   * Where a draft preview's builder adds the first record type: present only on the empty home
   * page of a preview whose application has no record types.
   */
  firstRecordTypeHref?: string;
  /** Current Access revision used to re-register page tools after a permission change. */
  accessVersion: number;
  /** Ready display data per data placement, by stable placement identity. */
  data: Readonly<Record<string, PageDataState>>;
  /**
   * Placements whose read was not awaited before the page was sent: their `data` entry is loading
   * and the settled state follows on the same response, by stable placement identity.
   */
  streamedData?: Readonly<Record<string, Promise<PageDataState>>>;
  /**
   * The table query state of the address this data was read for: every sort, filter, search,
   * visible-column and page parameter of a table placement, by parameter name. A client that finds
   * its address holding another state for a table rereads only that table.
   */
  tableAddress: Readonly<Record<string, string>>;
  /** Each placement's flow bindings, by stable placement identity. */
  bindings: Readonly<Record<string, readonly PlacementFlowBinding[]>>;
  /** Data placements to re-read after a write from each installed flow binding. */
  refreshPlacementsByBinding: Readonly<Record<string, readonly string[]>>;
  /** Pending states declared by a protected projection; only displayed values trigger a reread. */
  refreshWhileByPlacement: Readonly<
    Record<
      string,
      Readonly<{
        fieldId: string;
        values: readonly string[];
        intervalMilliseconds: number;
      }>
    >
  >;
  /**
   * The parameters the page declares that its controls publish and its blocks' bindings read: the
   * placements reading each parameter, by name, and the parameter each control writes, by placement.
   * A control change rereads exactly the placements bound to it.
   */
  pageParameters: Readonly<{
    dependents: Readonly<Record<string, readonly string[]>>;
    controls: Readonly<Record<string, string>>;
    controlKinds: Readonly<Record<string, string>>;
    /** Each drawer's Open with control, by placement identity. */
    drawers: Readonly<Record<string, string>>;
    tableIds: readonly string[];
  }>;
  /** Displayed values of readable edit fields, used only to omit unchanged fields on submit. */
  editFormBaselines: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  /** Dynamic reference-choice placements within the viewer's projected page. */
  referenceChoiceInputs: readonly Readonly<{
    placementId: string;
    formId: string;
    fieldKey: string;
  }>[];
  /** The link fields' record pickers within the viewer's projected page, by placement identity. */
  linkInputPlacementIds: readonly string[];
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
  invocation: Readonly<{
    tenantShortName: string;
    organizationShortName: string;
    applicationKey: string;
    pageKey: string;
    installationRevision: number;
    releaseKey: string;
  }>;
}>;

export type ApplicationPageModel = PlacementReadModel &
  Readonly<{
    /** Client page changes replace the mounted frame's navigation; documents use its own copy. */
    navigation?: ProjectedNavigation;
    /** Permission-filtered tools that map to one usable control on this page. */
    webMcpTools: readonly PageWebMcpTool[];
  }>;

export type PageLoadOptions = Readonly<{
  /** Omit navigation from a document's page payload; the frame carries the shared projection. */
  includeNavigation?: boolean;
  /** Send the page before the placements that only show their own query's rows have read. */
  streamPlacementReads?: boolean;
}>;

export type ApplicationPageResult =
  | Readonly<{
      kind: "available";
      model: ApplicationPageModel;
      /** Server-only definitions used to split the projection and resolve guided-form steps. */
      shells: readonly ApplicationShell[];
      applicationShell?: ApplicationShell;
    }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>
  /** A draft preview whose saved draft cannot run: `sentence` names what to fix in Studio. */
  | Readonly<{ kind: "not_runnable"; sentence: string }>;

export type ApplicationPagePlacementReadResult =
  | Readonly<{
      kind: "available";
      data: Readonly<Record<string, PageDataState>>;
      editFormBaselines: Readonly<Record<string, Readonly<Record<string, JsonValue>> | null>>;
      subject: ApplicationPageModel["subject"] | null;
      /** The page's own placements as projected now, present only when the caller asked for them. */
      content?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type ApplicationPageInternalResult =
  | ApplicationPageResult
  | Readonly<{
      kind: "placements";
      model: PlacementReadModel;
      applicationShell?: ApplicationShell;
    }>
  | Readonly<{ kind: "reload" }>;

export type ApplicationPageLoaderAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  pageKey: string;
  /**
   * The installed bundle context the address resolution of this same request already read under
   * the viewer's own HUMAN scope. When present (and of the expected revision) it is used instead
   * of reading the bundle a second time.
   */
  installedContext?: InstalledRuntimeContext;
  /**
   * The application navigation the address resolution of this request decided for the viewer.
   * A whole-page load shows it; a placement read shows no menu.
   */
  navigation?: ProjectedNavigation;
}>;

export type SearchParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

/** The columns one board shows (their first pages), or the one column it continues. */
export type BoardReadTarget = Readonly<{
  placementId: string;
  request: BoardColumnReadRequest;
}>;

export type TableContinuationTarget = Readonly<{
  placementId: string;
  /** The position came from the page address, so a cursor that no longer opens falls back to page one. */
  fromAddress?: true;
  request: RecordsTablePageRequest;
}>;

export type ModuleRelease = InstalledRuntimeContext["releaseSet"]["modules"][number];

export type ModuleField = ModuleRelease["content"]["recordTypes"][number]["fields"][number];

export type InstalledFlow =
  InstalledRuntimeContext["releaseSet"]["application"]["content"]["flows"][number];

/** The resolved record type the page's own address names the subject of. */
export type PageSubjectType = Extract<
  NonNullable<
    Extract<PageDefinition, { type: "detail" | "public" | "form" | "guided_form" }>["recordType"]
  >,
  { state: "resolved" }
>;
