import {
  QUERY_NOTICE_BLOCK_RELEASE,
  recordIdSchema,
  revisionSchema,
  validateComponentSettings,
} from "@vortex/contracts";
import type { ReactElement } from "react";
import { Notice, type NoticeContentPart, type NoticeSeverity } from "../components/notice";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import { createPayloadParser } from "../registry";
import type { DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import { parseDisplayData } from "./projected-data";

export type QueryNoticeItem = Readonly<{
  recordId: string;
  revision: number;
  message: string;
  severity: NoticeSeverity;
  title?: string;
  link?: Readonly<{ label: string; href: string }>;
}>;
export type QueryNoticePayload = Readonly<{
  kind: "query_notice";
  items: readonly QueryNoticeItem[];
  truncated: boolean;
}>;

function refuse(location: DefinitionRenderErrorLocation): never {
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    "Query Notice runtime input must match its closed permitted projection",
    location,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  location: DefinitionRenderErrorLocation,
): void {
  if (required.some((key) => !Object.hasOwn(record, key)) ||
      Reflect.ownKeys(record).some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)))
    refuse(location);
}

function text(value: unknown, location: DefinitionRenderErrorLocation): string {
  if (typeof value !== "string" || value.length > 1_000_000) refuse(location);
  return value;
}

function severity(value: unknown, location: DefinitionRenderErrorLocation): NoticeSeverity {
  if (value === "info" || value === "success" || value === "warning" || value === "critical")
    return value;
  return refuse(location);
}

/** The local release parser admits no arbitrary row values, executable content or extra keys. */
export function parseQueryNoticePayload(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): QueryNoticePayload {
  if (!isRecord(value)) refuse(location);
  exactKeys(value, ["kind", "items", "truncated"], [], location);
  if (value.kind !== "query_notice" || typeof value.truncated !== "boolean" ||
      !Array.isArray(value.items) || value.items.length > 200) refuse(location);
  const items: QueryNoticeItem[] = [];
  const seen = new Set<string>();
  for (const candidate of value.items) {
    if (!isRecord(candidate)) refuse(location);
    exactKeys(candidate, ["recordId", "revision", "message", "severity"], ["title", "link"], location);
    const recordId = recordIdSchema.safeParse(candidate.recordId);
    const revision = revisionSchema.safeParse(candidate.revision);
    if (!recordId.success || !revision.success || seen.has(recordId.data.toLowerCase()))
      refuse(location);
    seen.add(recordId.data.toLowerCase());
    let link: QueryNoticeItem["link"];
    if (Object.hasOwn(candidate, "link")) {
      if (!isRecord(candidate.link)) refuse(location);
      exactKeys(candidate.link, ["label", "href"], [], location);
      link = Object.freeze({ label: text(candidate.link.label, location), href: text(candidate.link.href, location) });
    }
    items.push(Object.freeze({
      recordId: recordId.data,
      revision: revision.data,
      message: text(candidate.message, location),
      severity: severity(candidate.severity, location),
      ...(Object.hasOwn(candidate, "title") ? { title: text(candidate.title, location) } : {}),
      ...(link === undefined ? {} : { link }),
    }));
  }
  return Object.freeze({ kind: "query_notice", items: Object.freeze(items), truncated: value.truncated });
}

/** Existing transport supplies empty events; this release never accepts a callback or event. */
export const QUERY_NOTICE_PAYLOAD_PARSER = createPayloadParser({
  data: (value, location) => parseDisplayData(value, parseQueryNoticePayload, location),
  events: (value, location) => {
    if (value !== undefined && (!isRecord(value) || Reflect.ownKeys(value).length !== 0))
      refuse(location);
    return Object.freeze({});
  },
});

/** Renders only the server's closed page using the unchanged safe, locally dismissible primitive. */
export function QueryNoticeDisplay(props: DisplayRenderProps<QueryNoticePayload>): ReactElement {
  const metadata = props.metadata;
  const location = { placementId: props.placementId, blockId: metadata.blockId, releaseVersion: metadata.releaseVersion };
  if (metadata.blockId !== QUERY_NOTICE_BLOCK_RELEASE.blockId ||
      metadata.key !== QUERY_NOTICE_BLOCK_RELEASE.key ||
      metadata.releaseVersion !== QUERY_NOTICE_BLOCK_RELEASE.releaseVersion ||
      metadata.rendererKey !== QUERY_NOTICE_BLOCK_RELEASE.rendererKey ||
      metadata.contentFingerprint !== QUERY_NOTICE_BLOCK_RELEASE.contentFingerprint ||
      metadata.catalogueFingerprint !== QUERY_NOTICE_BLOCK_RELEASE.catalogueFingerprint)
    throw new DefinitionRenderError("MISMATCHED_RELEASE", "Query Notice received a different immutable release", location);
  if (validateComponentSettings(props.settings, QUERY_NOTICE_BLOCK_RELEASE.properties).length !== 0)
    refuse(location);
  const dismissal = props.settings.dismissible;
  const dismissible = dismissal?.kind === "boolean" ? dismissal.value : false;
  const values = props.data?.status === "ready" ? props.data.values : undefined;
  const state = props.data === undefined || (values !== undefined && values.items.length === 0 && !values.truncated)
    ? { status: "empty" as const }
    : props.data;
  return (
    <DisplayStateContainer
      accessibleName={metadata.name}
      availability={props.availability}
      projectedData={state}
      emptyMessage="No notices to show"
    >
      {values === undefined ? null : (
        <div data-vortex-display="query_notice" data-vortex-placement-id={props.placementId} className="flex flex-col gap-2">
          {values.truncated ? <p role="status" aria-live="polite">Additional notices are not shown.</p> : null}
          {values.items.map((item) => {
            const content: readonly NoticeContentPart[] = item.link === undefined
              ? [{ kind: "text", value: item.message }]
              : [{ kind: "text", value: item.message }, { kind: "text", value: " " }, { kind: "link", label: item.link.label, href: item.link.href }];
            return (
              <Notice
                key={`${props.placementId.toLowerCase()}:${item.recordId.toLowerCase()}`}
                severity={item.severity}
                content={content}
                dismissible={dismissible}
                {...(item.title === undefined ? {} : { title: item.title })}
              />
            );
          })}
        </div>
      )}
    </DisplayStateContainer>
  );
}
