import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  queryNoticePayloadSchema,
  validateComponentSettings,
  type QueryNoticeItem,
  type QueryNoticePayload,
} from "@vortex/platform/schema";
import type { ReactElement } from "react";
import { Notice, type NoticeContentPart } from "../components/notice";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import { createPayloadParser } from "../registry";
import type { DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import { parseDisplayData, projectedValuesParser } from "./projected-data";

export type { QueryNoticeItem, QueryNoticePayload };
const QUERY_NOTICE_RELEASE = PLATFORM_BLOCK_RELEASE_IDENTITIES.QUERY_NOTICE_BLOCK_RELEASE;

function refuse(location: DefinitionRenderErrorLocation): never {
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    "Query Notice runtime input must match its closed permitted projection",
    location,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** The ready values a query notice block accepts: no arbitrary row values, content or extra keys. */
export const parseQueryNoticePayload = projectedValuesParser(
  queryNoticePayloadSchema,
  "Query Notice runtime input must match its closed permitted projection",
);

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
  const location = {
    placementId: props.placementId,
    blockId: metadata.blockId,
    releaseVersion: metadata.releaseVersion,
  };
  if (
    metadata.key !== QUERY_NOTICE_RELEASE.key ||
    metadata.releaseVersion !== QUERY_NOTICE_RELEASE.releaseVersion ||
    metadata.rendererKey !== "platform.renderer.query_notice"
  )
    throw new DefinitionRenderError(
      "MISMATCHED_RELEASE",
      "Query Notice received a different immutable release",
      location,
    );
  if (validateComponentSettings(props.settings, metadata.properties).length !== 0) refuse(location);
  const dismissal = props.settings.dismissible;
  const dismissible = dismissal?.kind === "boolean" ? dismissal.value : false;
  const values = props.data?.status === "ready" ? props.data.values : undefined;
  const state =
    props.data === undefined ||
    (values !== undefined && values.items.length === 0 && !values.truncated)
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
        <div
          data-vortex-display="query_notice"
          data-vortex-placement-id={props.placementId}
          className="flex flex-col gap-2"
        >
          {values.truncated ? (
            <p role="status" aria-live="polite">
              Additional notices are not shown.
            </p>
          ) : null}
          {values.items.map((item) => {
            const content: readonly NoticeContentPart[] =
              item.link === undefined
                ? [{ kind: "text", value: item.message }]
                : [
                    { kind: "text", value: item.message },
                    { kind: "text", value: " " },
                    { kind: "link", label: item.link.label, href: item.link.href },
                  ];
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
