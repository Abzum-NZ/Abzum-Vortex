import "server-only";

import type { BoardColumnReadRequest, PageDefinition } from "../../schema";
import type {
  HumanOrganizationRequestResult,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
} from "../../access/index";
import type { InstalledRuntimeContext } from "../../definition/index";
import type { createProtectedQueryService } from "../../queries/index";
import type { RecordLinkResolver } from "../component-data-projection";
import type { createLinkTilesQueryResolver } from "../link-tiles-query";
import type { createQueryNoticeQueryResolver } from "../notice-query-projection";
import type { createRecordsTableQueryResolver } from "../records-table-query";
import type { RecordsTablePageRequest } from "../records-table-state";
import type { StoredGridView } from "../grid-views";
import type { PageSubjectReadResult } from "../page-subject-read";
import type { QueryBindingContext } from "../query-binding-resolver";
import type { RecordsSelectionSealer } from "../records-selection-seal";
import type {
  AddressParameters,
  IdentitySession,
  OrganizationSelectionCandidate,
  PageDataState,
  PageSubjectType,
  PlacementLogPlace,
} from "./shared";

/** A launcher query row as the launcher's cell keys project it. */
export type LauncherQueryRow = Readonly<{
  applicationKey: string | undefined;
  cells: Readonly<Record<string, Readonly<{ kind: "text"; text: string }>>>;
}>;

/** The person's stored layouts of a page's data grids, read once before any grid reads its rows. */
export type PlacementGridLayouts = Readonly<{
  /** False in a preview: changes then stay on screen only. */
  persisted: boolean;
  stored: ReadonlyMap<string, StoredGridView>;
  /**
   * The fields the person can read on at least one record, by lower-cased record type identity;
   * undefined in a preview, whose builder sees every field.
   */
  readable: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}>;

/**
 * The readers a page's data placements use, each reading under the viewer's own protected
 * requests. The running page and the Studio canvas inject the same services, so a block shows the
 * same records, with the same access, in both. The two projections the UI owns (a launcher's list
 * values and a board's payload contract) are injected, so the platform never imports the UI.
 */
export type PlacementReadServices = Readonly<{
  queries: ReturnType<typeof createProtectedQueryService>;
  linkTiles: ReturnType<typeof createLinkTilesQueryResolver>;
  queryNotices: ReturnType<typeof createQueryNoticeQueryResolver>;
  /**
   * The Records table reader. `sealSelection` seals a read's "every matching record" descriptor for
   * the viewer; a host where nothing runs over a selection leaves it out.
   */
  tables: ReturnType<typeof createRecordsTableQueryResolver> &
    Readonly<{ sealSelection?: RecordsSelectionSealer }>;
  resolveRecordLinks: RecordLinkResolver;
  readCalendarSettings: () => Promise<
    HumanOrganizationRequestResult<{
      settings: Awaited<
        ReturnType<typeof readCurrentOrganizationRuntimeSettingsAfterAuthorization>
      >;
      accessVersion: number;
    }>
  >;
  readSubject: (recordTypeId: string, recordId: string) => Promise<PageSubjectReadResult>;
  launcherValues: (
    rows: readonly LauncherQueryRow[],
    permittedApplicationKeys: readonly string[],
    nameKey: string,
    iconKey: string,
  ) => unknown;
  /** A board's ready state, checked against the board block's own payload contract. */
  boardData: (values: unknown) => PageDataState;
}>;

/** One page's placement read: what the server decided for this request, shared by every block. */
export type PlacementReadInput = Readonly<{
  context: InstalledRuntimeContext;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  address: PlacementLogPlace;
  pageDefinition: PageDefinition;
  /**
   * The access version the page was projected under, which a later settings read must match;
   * undefined for the Studio canvas, which projects no page.
   */
  accessVersion: number | undefined;
  subjectType: PageSubjectType | undefined;
  /** The page subject's record identity when the address names a well-formed one. */
  subjectId: string | undefined;
  parameters: AddressParameters;
  bindings: QueryBindingContext;
  data: Record<string, PageDataState>;
  services: PlacementReadServices;
  /** The applications the viewer may open, for a query-bound launcher; undefined when unread. */
  permittedApplicationKeys: readonly string[] | undefined;
  permittedApplicationsUnavailable: boolean;
  /** The columns each named board shows, or the one column it continues; other boards read their first columns. */
  boardReads?: readonly Readonly<{ placementId: string; request: BoardColumnReadRequest }>[];
  /** How many leading stages a board's first read covers: one on a narrow screen, more on a wide one. */
  tableContinuation?: Readonly<{
    placementId: string;
    fromAddress?: true;
    request: RecordsTablePageRequest;
  }>;
  gridLayouts: PlacementGridLayouts;
  markSubjectUnreadable: () => void;
}>;
