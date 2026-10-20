import { PLATFORM_BLOCK_RELEASE_IDENTITIES } from "../application-composition-release-identities";
import {
  authoredRecordsTableFeatureEnabled,
  recordsTableFeatureOfEvent,
} from "../application-composition/records-table-features";

import type { JsonObject } from "./shared";

/** The authored item with this placement alias in the source's pages and shells, if any. */
const sourcePlacementProps = (
  body: JsonObject,
  alias: string,
): Readonly<Record<string, unknown>> | undefined => {
  let found: Readonly<Record<string, unknown>> | undefined;
  const visit = (value: unknown): void => {
    if (found !== undefined || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    const props = record["props"];
    if (
      record["type"] === PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE.rendererKey &&
      props !== null &&
      typeof props === "object" &&
      (props as Record<string, unknown>)["id"] === alias
    ) {
      found = props as Record<string, unknown>;
      return;
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit([body.pages, body.shells]);
  return found;
};

/**
 * The authored flow bindings that compile. A binding of a Records table event that a grid feature
 * owns (row action, inline edit, row edit) compiles only while that feature is on: a feature that is off
 * compiles to nothing, so its flows can never be started from the table.
 */
export const compiledSourceFlowBindings = (body: JsonObject): JsonObject[] =>
  (body.flow_bindings as JsonObject[]).filter((binding) => {
    const feature = recordsTableFeatureOfEvent(String(binding.event));
    if (feature === undefined) return true;
    const props = sourcePlacementProps(body, String(binding.control));
    return props === undefined || authoredRecordsTableFeatureEnabled(props, feature);
  });
