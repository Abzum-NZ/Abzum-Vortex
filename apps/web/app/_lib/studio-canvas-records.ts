import "server-only";

import { createRecordChoiceReader, DefinitionError } from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  compiledItemSlots,
  describeFailure,
  fingerprintSchema,
  organizationIdSchema,
  readRecordDetailContract,
  recordIdSchema,
  revisionSchema,
  sameId,
  sourceItemChildSlots,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type CompiledItem,
  type IdentitySession,
  type PageDefinition,
  type SourceItem,
} from "@vortex/platform/schema";
import { z } from "zod";
import { pageCompiledSlotsFor } from "./studio-application-draft";
import { collectPlacements, pageSubjectParameter } from "./application-page/placement-helpers";
import { findModuleQuery, pageQueryBindingContext } from "@vortex/platform/server";
import {
  applicationLauncherQueryRowsToListValues,
  parseBoardPayload,
  parseDisplayData,
} from "@vortex/ui";
import {
  isStreamablePlacement,
  readPlacement,
  type PlacementReaderInput,
} from "./application-page/placement-reader";
import { openStudioPreviewRead } from "./studio-preview-read";
import type { PageDataState } from "./application-page/types";

const requestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    draftRevision: revisionSchema,
    sourceFingerprint: fingerprintSchema,
    pageAlias: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z][a-z0-9_]*$/),
    area: z.string().min(1).max(400),
    /**
     * The value the builder chose in each control on the canvas, by the control's placement name.
     * They are candidate values only: each is typed and validated by the one binding resolver
     * exactly like a running page's address value, and none can carry the viewer's identity.
     */
    controlValues: z.record(z.string().min(1).max(160), z.string().max(400)),
  })
  .strict()
  .refine((request) => Object.keys(request.controlValues).length <= 32);

/**
 * The records the data blocks of one content area of a saved draft page show, by block name, for
 * exactly that draft revision, including a detail page's sample subject.
 */
export type StudioCanvasRecordsResult =
  | Readonly<{
      kind: "available";
      draftRevision: number;
      sourceFingerprint: string;
      pageAlias: string;
      area: string;
      records: Readonly<Record<string, PageDataState>>;
      /**
       * On a page of one record (a detail page), the record its blocks show: the first record of
       * its type the builder can read in the preview, or none when the preview has none yet.
       */
      sample?: Readonly<{ recordTypeName: string; title?: string }>;
    }>
  | Readonly<{ kind: "conflict" }>
  /** The builder may not edit or preview this application, so the canvas reads no records. */
  | Readonly<{ kind: "refused" }>
  /** The preview does not run this revision's data shape yet: read once it is ready. */
  | Readonly<{ kind: "following" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** The compiled slot of one page area beside its stored items, and the block name of each compiled placement. */
const placementAliases = (
  stored: readonly SourceItem[],
  compiled: readonly CompiledItem[],
  aliases: Map<string, string>,
): void => {
  if (stored.length !== compiled.length) throw new Error("STUDIO_CANVAS_RECORDS_SLOT_MISMATCH");
  stored.forEach((item, index) => {
    const compiledItem = compiled[index]!;
    aliases.set(String(compiledItem.props.id).toLowerCase(), item.props.id);
    const children = new Map(compiledItemSlots(compiledItem));
    for (const [key, items] of sourceItemChildSlots(item))
      placementAliases(items, children.get(key) ?? [], aliases);
  });
};

type Placement = ReturnType<typeof collectPlacements>[number];
type StudioPreview = Extract<
  Awaited<ReturnType<typeof openStudioPreviewRead>>,
  { kind: "available" }
>;
type CanvasSample = Readonly<{
  recordTypeName: string;
  recordId?: string;
  title?: string;
}>;

/**
 * The first record of a page's record type the builder can read in the preview, by its title, as a
 * record picker reads it; only the record type's name when the preview holds none of them yet.
 * Undefined while the preview does not have the record type yet: it follows once it has moved.
 */
const readSample = async (
  session: IdentitySession,
  preview: StudioPreview,
  recordType: Readonly<{ moduleRootId: unknown; recordTypeId: unknown }>,
): Promise<CanvasSample | "temporarily_unavailable" | undefined> => {
  const module = preview.context.releaseSet.modules.find((candidate) =>
    sameId(String(candidate.rootId), String(recordType.moduleRootId)),
  );
  const record = module?.content.recordTypes.find((candidate) =>
    sameId(String(candidate.recordTypeId), String(recordType.recordTypeId)),
  );
  if (module === undefined || record === undefined) return undefined;
  const read = await createRecordChoiceReader(preview.services.queries).read(
    session,
    preview.selection,
    {
      targets: [
        {
          moduleRootId: String(module.rootId),
          recordTypeId: String(record.recordTypeId),
          titleFieldId: String(record.titleFieldId),
          label: record.singularLabel,
        },
      ],
      pageSize: 1,
    },
  );
  if (read.kind === "temporarily_unavailable") return "temporarily_unavailable";
  if (read.kind !== "available") {
    console.error(
      `[studio] canvas sample record unread: STUDIO_CANVAS_SAMPLE_REFUSED cause=${read.kind}`,
    );
    return "temporarily_unavailable";
  }
  if (read.value.outcome !== "completed") {
    console.error(
      `[studio] canvas sample record unread: STUDIO_CANVAS_SAMPLE_REFUSED cause=${read.value.reasonCode}`,
    );
    return "temporarily_unavailable";
  }
  const first = read.value.choices[0];
  return first === undefined
    ? { recordTypeName: record.singularLabel }
    : {
        recordTypeName: record.singularLabel,
        recordId: first.recordId,
        title: first.title,
      };
};

/**
 * Reads the records the data blocks of one saved draft page area show, through the builder's own
 * preview installation of that draft. The area's blocks are the saved revision's own compile; the
 * records are read with the running application's own placement reader against the preview, so a
 * block shows on the canvas what it shows in the preview to this builder: the records they may
 * read, a draft-only record type's and those made in the preview included, and nothing of records
 * they may not read.
 */
export const readStudioCanvasRecords = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
  signal?: AbortSignal,
): Promise<StudioCanvasRecordsResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const parsed = requestSchema.safeParse(candidate);
  if (!organization.success || !parsed.success) return { kind: "refused" };
  const request = parsed.data;
  try {
    const preview = await openStudioPreviewRead(
      session,
      organization.data,
      request.rootId,
      request.draftRevision,
      signal,
      true,
    );
    if (preview.kind !== "available") return preview;
    const { draft, content, context, services, selection, dependencies } = preview;
    if (draft.sourceFingerprint !== request.sourceFingerprint) return { kind: "conflict" };
    signal?.throwIfAborted();
    if (content === undefined) throw new Error("STUDIO_CANVAS_COMPILATION_MISSING");
    const pageIndex = draft.source.body.pages.findIndex((page) => page.id === request.pageAlias);
    const page = draft.source.body.pages[pageIndex];
    const compiledPage = content.pages[pageIndex] as PageDefinition | undefined;
    const address =
      page === undefined
        ? undefined
        : sourcePageSlotAddresses(page).find(
            (candidateAddress) => candidateAddress.key === request.area,
          );
    const zone =
      page === undefined || address === undefined ? undefined : sourcePageSlotAt(page, address);
    const slot = pageCompiledSlotsFor(draft.source, content, request.pageAlias)[
      request.pageAlias
    ]?.[request.area];
    if (
      page === undefined ||
      compiledPage === undefined ||
      zone === undefined ||
      slot === undefined
    )
      return { kind: "refused" };
    const aliases = new Map<string, string>();
    placementAliases(zone.items, slot, aliases);

    // The draft's page, drawn as the running page reads it: its content is this area's blocks.
    const areaPage = {
      ...compiledPage,
      composition: { root: { props: {} }, content: slot },
    };
    // A detail page shows one record, named by its address in the running application. The canvas
    // shows the first record of its type the builder can read in the preview, as if it were opened.
    const subjectType =
      compiledPage.type === "detail" && compiledPage.recordType?.state === "resolved"
        ? compiledPage.recordType
        : undefined;
    const sample =
      subjectType === undefined ? undefined : await readSample(session, preview, subjectType);
    if (sample === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    const subjectId = recordIdSchema.safeParse(sample?.recordId);
    const parameters: Record<string, string> = subjectId.success
      ? { [pageSubjectParameter]: subjectId.data }
      : {};
    // The names the compiled placements go by on the canvas, so a control value finds its control.
    const compiledOf = new Map([...aliases].map(([compiled, alias]) => [alias, compiled]));
    const settingsOf = (placement: Placement) =>
      placement.settings as Parameters<typeof readRecordDetailContract>[0];
    // The page's own record, shown by a Record detail that reads no query.
    const readsSubject = (placement: Placement) =>
      subjectId.success &&
      typeof placement.vortex.queryId !== "string" &&
      readRecordDetailContract(settingsOf(placement)) !== undefined;
    // A query the preview does not run yet is read once the preview has moved to this revision.
    // A block whose bindings wait for a value the canvas does not have (a control's choice) shows
    // its awaiting message, exactly as the running page does before the choice.
    const placements = collectPlacements(areaPage).filter(
      (placement) =>
        readsSubject(placement) ||
        (isStreamablePlacement(placement) &&
          findModuleQuery(context, String(placement.vortex.queryId)) !== undefined),
    );
    const data: Record<string, PageDataState> = {};
    let subjectRead: ReturnType<typeof services.subjects.read> | undefined;
    const readSubject = (recordTypeId: string, recordId: string) =>
      (subjectRead ??= services.subjects.read(session, selection, { recordTypeId, recordId }));
    const input: PlacementReaderInput = {
      pageDefinition: compiledPage,
      accessVersion: undefined,
      pageSubjectRecordTypeId:
        subjectType === undefined ? undefined : String(subjectType.recordTypeId),
      data,
      page: areaPage,
      context,
      referenceChoiceInputs: [],
      referenceChoices: services.referenceChoices,
      session,
      selection,
      address: { application: { key: draft.key }, pageKey: page.key },
      subjectType,
      parameters,
      // The bindings resolve against the whole draft page and the sample subject, under the
      // builder's own access in the preview.
      bindings: pageQueryBindingContext({
        context,
        pageDefinition: compiledPage,
        parameters,
        readSubject:
          subjectType === undefined || !subjectId.success
            ? undefined
            : () => readSubject(String(subjectType.recordTypeId), subjectId.data),
        subjectRecordTypeId:
          subjectType === undefined ? undefined : String(subjectType.recordTypeId),
        readTimeZone: async () => {
          const read = await services.readCalendarSettings();
          return read.kind === "available" ? read.value.settings?.timeZone : undefined;
        },
      }),
      dependencies,
      subjectId: subjectId.success ? subjectId.data : undefined,
      services: {
        queries: services.queries,
        linkTiles: services.linkTiles,
        queryNotices: services.queryNotices,
        tables: services.tables,
        resolveRecordLinks: services.recordLinkResolver(context),
        readCalendarSettings: services.readCalendarSettings,
        readSubject,
        launcherValues: applicationLauncherQueryRowsToListValues,
        boardData: (values) => parseDisplayData({ status: "ready", values }, parseBoardPayload),
      },
      permittedApplicationKeys: undefined,
      permittedApplicationsUnavailable: false,
      // The Studio canvas shows the authored layout and reports arrangements for capture; a
      // person's layout belongs to the running app.
      gridLayouts: {
        storage: "canvas",
        stored: {
          roleKeys: new Set(),
          shareable: new Set(),
          layouts: new Map(),
          views: new Map(),
          defaultDocuments: new Map(),
        },
        readable: undefined,
      },
      adoptSubjectRead: () => {},
      markSubjectUnreadable: () => {},
    };
    // A control's chosen value becomes the page parameter that control publishes. A name that is
    // not a control of this area, or that publishes no parameter, is ignored and logged; the
    // viewer's identity parts never come through here.
    for (const [alias, text] of Object.entries(request.controlValues)) {
      const parameter = input.bindings.controls.get(compiledOf.get(alias) ?? "");
      if (parameter === undefined) {
        console.error(
          `[studio] canvas control value ignored: STUDIO_CANVAS_CONTROL_VALUE_REFUSED cause=not_a_control placement=${alias}`,
        );
        continue;
      }
      if (text !== "") parameters[parameter] = text;
    }
    signal?.throwIfAborted();
    await Promise.all(placements.map((placement) => readPlacement(input, placement)));
    const records: Record<string, PageDataState> = {};
    for (const [placementId, state] of Object.entries(data)) {
      const alias = aliases.get(placementId.toLowerCase());
      if (alias !== undefined) records[alias] = state;
    }
    return {
      kind: "available",
      draftRevision: request.draftRevision,
      sourceFingerprint: request.sourceFingerprint,
      pageAlias: request.pageAlias,
      area: request.area,
      records,
      ...(sample === undefined
        ? {}
        : {
            sample: {
              recordTypeName: sample.recordTypeName,
              ...(sample.recordId === undefined ? {} : { title: sample.title }),
            },
          }),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
      return { kind: "conflict" };
    console.error(
      `[studio] canvas records unavailable: STUDIO_CANVAS_RECORDS_FAILED cause=${describeFailure(error)}`,
    );
    return { kind: "temporarily_unavailable" };
  }
};
