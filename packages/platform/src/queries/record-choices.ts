import "server-only";

import { z } from "zod";
import type { HumanOrganizationRequestResult } from "../access/index";
import {
  fieldIdSchema,
  moduleRootIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  sameId,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "../schema";
import type {
  ProtectedQueryCommand,
  ProtectedQueryRefusalReasonCode,
  ProtectedQueryResult,
} from "./protected-query-contracts";

/** A record picker reads 40 records a page unless it asks for more, and never more than 200. */
export const recordChoicePageSizes = Object.freeze({ default: 40, maximum: 200 });

/**
 * One record type a link field may point at, as the installed release declares it: the Module
 * that owns it, its identity, its title field and its singular name.
 */
export const recordChoiceTargetSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    titleFieldId: fieldIdSchema,
    label: z.string().min(1).max(120),
  })
  .strict();
export type RecordChoiceTarget = z.infer<typeof recordChoiceTargetSchema>;

const recordChoiceCommandSchema = z
  .object({
    targets: z.array(recordChoiceTargetSchema).min(1).max(20),
    /** Narrows the records to those whose title or another searchable field holds this text. */
    search: z.string().trim().min(1).max(100).optional(),
    pageSize: z.number().int().min(1).max(recordChoicePageSizes.maximum),
    /** Opaque: the position each target's records reached on the previous page. */
    continuationToken: z.string().min(1).max(65_536).optional(),
  })
  .strict();
export type RecordChoiceCommand = z.input<typeof recordChoiceCommandSchema>;

/** One record a person may pick: its identity and its title, and nothing else of its values. */
export type RecordChoice = Readonly<{
  recordTypeId: string;
  recordId: string;
  title: string;
  /** The singular name of the record's type, shown when a field may point at several. */
  typeLabel: string;
}>;

export type RecordChoiceRead =
  | Readonly<{
      outcome: "completed";
      choices: readonly RecordChoice[];
      nextContinuationToken?: string;
    }>
  | Readonly<{
      outcome: "refused";
      reasonCode: ProtectedQueryRefusalReasonCode | "request_invalid";
    }>;

/** The Query engine entry point the picker reads through; it authorises the viewer itself. */
export type RecordChoiceQueryRunner = Readonly<{
  run(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ProtectedQueryCommand,
  ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>>;
}>;

const maximumTitleLength = 200;

/** The text a record is picked by: its title as the viewer may read it. */
const titleText = (value: JsonValue | undefined): string => {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  return text.length === 0
    ? "Untitled record"
    : Array.from(text).slice(0, maximumTitleLength).join("");
};

/**
 * The position of each target's records: one opaque Query engine token per target that has
 * more. A field with one target carries that target's token as it is.
 */
const positionsSchema = z
  .array(z.object({ recordTypeId: recordTypeIdSchema, token: z.string().min(1) }).strict())
  .min(1)
  .max(20);
type Positions = z.infer<typeof positionsSchema>;

const encodePositions = (positions: Positions): string =>
  Buffer.from(JSON.stringify(positions), "utf8").toString("base64url");

const decodePositions = (token: string): Positions | undefined => {
  try {
    const parsed = positionsSchema.safeParse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads one page of the records a link field may point at. Each target record type is read by
 * its own listing query (the record type's identity): the Query engine admits only records the
 * viewer may read, applies the field read policy, searches the title and the record type's
 * searchable fields, and pages by keyset. Nothing here adds or widens access.
 */
export const createRecordChoiceReader = (queries: RecordChoiceQueryRunner) =>
  Object.freeze({
    async read(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      candidate: RecordChoiceCommand,
    ): Promise<HumanOrganizationRequestResult<RecordChoiceRead>> {
      const parsed = recordChoiceCommandSchema.safeParse(candidate);
      if (!parsed.success)
        return { kind: "available", value: { outcome: "refused", reasonCode: "request_invalid" } };
      const command = parsed.data;
      const several = command.targets.length > 1;
      let positions: Positions | undefined;
      if (command.continuationToken !== undefined) {
        positions = several
          ? decodePositions(command.continuationToken)
          : [{ recordTypeId: command.targets[0]!.recordTypeId, token: command.continuationToken }];
        if (
          positions === undefined ||
          !positions.every((position) =>
            command.targets.some((target) => sameId(target.recordTypeId, position.recordTypeId)),
          )
        )
          return { kind: "available", value: { outcome: "refused", reasonCode: "cursor_invalid" } };
      }
      const read =
        positions === undefined
          ? command.targets.map((target) => ({ target, token: undefined as string | undefined }))
          : positions.map((position) => ({
              target: command.targets.find((target) =>
                sameId(target.recordTypeId, position.recordTypeId),
              )!,
              token: position.token as string | undefined,
            }));

      const choices: RecordChoice[] = [];
      const next: Positions = [];
      for (const { target, token } of read) {
        const result = await queries.run(session, selection, {
          moduleRootId: target.moduleRootId,
          // A record type is listed by its own identity: the listing query the engine resolves for it.
          queryId: queryIdSchema.parse(target.recordTypeId),
          inputValues: {},
          requestedFieldIds: [target.titleFieldId],
          requestedSystemFieldKeys: [],
          sort: [],
          sortableFieldIds: [],
          filterableFieldIds: [],
          // No declared list: the engine searches every field the record type marks searchable.
          searchableFieldIds: [],
          ...(command.search === undefined ? {} : { search: command.search }),
          pageSize: command.pageSize,
          ...(token === undefined ? {} : { continuationToken: token }),
        });
        if (result.kind !== "available") return result;
        const page = result.value;
        if (page.outcome !== "completed")
          return { kind: "available", value: { outcome: "refused", reasonCode: page.reasonCode } };
        for (const row of page.rows)
          choices.push(
            Object.freeze({
              recordTypeId: target.recordTypeId,
              recordId: row.recordId,
              title: titleText(
                row.values[target.titleFieldId] ??
                  Object.entries(row.values).find(([key]) => sameId(key, target.titleFieldId))?.[1],
              ),
              typeLabel: target.label,
            }),
          );
        if (page.nextContinuationToken !== undefined)
          next.push({ recordTypeId: target.recordTypeId, token: page.nextContinuationToken });
      }
      if (several) choices.sort((left, right) => left.title.localeCompare(right.title));
      const nextContinuationToken =
        next.length === 0 ? undefined : several ? encodePositions(next) : next[0]!.token;
      return {
        kind: "available",
        value: Object.freeze({
          outcome: "completed",
          choices: Object.freeze(choices),
          ...(nextContinuationToken === undefined ? {} : { nextContinuationToken }),
        }),
      };
    },
  });
