"use client";

import { useState } from "react";
import { builderKeySchema, type BlockPropertyValueV2Contract } from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import { getAccessibleName } from "../display/display-state-container";
import type { PlatformBlockRenderProps } from "../registry";
import {
  parseChoiceOptions,
  type ChoiceOption,
  type ControlDataState,
  type ControlEventHandlers,
  type ControlSemanticEventName,
} from "./projected-data";

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

/**
 * The props a control block's renderer receives: the base props every block has, plus this block's
 * own `data` and `events`, which its own registration validated fail-closed.
 */
export type ControlRenderProps<Values> = PlatformBlockRenderProps &
  Readonly<{ data?: ControlDataState<Values>; events?: ControlEventHandlers }>;

/** Resolved presentation context shared by every form and action control. */
export type ControlContext<Values> = Readonly<{
  location: DefinitionRenderErrorLocation;
  /** Authored accessible name, read only through the declared metadata path. */
  accessibleName: string | undefined;
  /** Ready values of this control's own payload, or the last ready values kept while not ready. */
  values: Values | undefined;
  /** The control's data or a submission it started is pending; it cannot be activated. */
  pending: boolean;
  /** The placement is viewable but its use is unavailable to the current person. */
  unavailable: boolean;
  /** Projected safe reason for a disabled control. */
  disabledReason: string | undefined;
  /** True when the control must not accept input or activation for any projected reason. */
  inactive: boolean;
  /** Declared callbacks; always absent while the placement's use is unavailable. */
  events: ControlEventHandlers | undefined;
}>;

/**
 * The placement's ready values, or the last ready values while it is loading or disabled, so a
 * field keeps showing and submitting its value and an open dialog stays open. Kept values
 * belong to one placement identity and are never carried to another.
 */
function useLastReadyValues<Values>(
  placementId: string,
  ready: Values | undefined,
): Values | undefined {
  const [kept, setKept] = useState<Readonly<{ placementId: string; values: Values }> | undefined>(
    ready === undefined ? undefined : { placementId, values: ready },
  );
  if (ready !== undefined && (kept?.placementId !== placementId || !Object.is(kept.values, ready)))
    setKept({ placementId, values: ready });
  if (ready !== undefined) return ready;
  return kept?.placementId === placementId ? kept.values : undefined;
}

/**
 * Resolves one control's props from the inputs its own registration validated, failing closed on a
 * callback for an event this block does not declare. The control never fetches data or calls a
 * Record, Query or App service; it only emits its declared semantic events. It keeps the last ready
 * values in state, so each control calls it once, unconditionally, while rendering.
 */
export function resolveControlContext<Values>(
  props: ControlRenderProps<Values>,
  declaredEvents: readonly ControlSemanticEventName[],
): ControlContext<Values> {
  const { metadata, placementId, data, events: suppliedEvents, availability } = props;
  const location: DefinitionRenderErrorLocation = {
    placementId,
    blockId: metadata.blockId,
    releaseVersion: metadata.releaseVersion,
  };

  const ready = data?.status === "ready" ? data.values : undefined;
  const values = useLastReadyValues(placementId, ready);

  if (suppliedEvents !== undefined) {
    for (const name of Object.keys(suppliedEvents)) {
      if (!declaredEvents.includes(name as ControlSemanticEventName))
        fail(`Block '${metadata.key}' does not declare semantic event '${name}'`, location);
    }
  }

  const pending = data?.status === "loading";
  const unavailable = availability === "unavailable";
  const disabledReason = data?.status === "disabled" ? data.reason : undefined;
  return {
    location,
    accessibleName: getAccessibleName(props.settings, metadata),
    values,
    pending,
    unavailable,
    disabledReason,
    inactive: unavailable || pending || data?.status === "disabled",
    events: availability === "available" ? suppliedEvents : undefined,
  };
}

/**
 * Fail-closed reads of one placement's authored settings against the properties its release
 * declares. The control and launcher settings readers build on this one implementation instead of
 * each carrying a near-identical copy.
 */
export type DeclaredSettingsReader = Readonly<{
  read: (
    key: string,
    kind: BlockPropertyValueV2Contract["kind"],
  ) => BlockPropertyValueV2Contract | undefined;
  text: (key: string) => string | undefined;
  boolean: (key: string) => boolean;
}>;

export function createDeclaredSettingsReader(
  props: PlatformBlockRenderProps,
  location: DefinitionRenderErrorLocation,
): DeclaredSettingsReader {
  const { settings, metadata } = props;
  const read = (
    key: string,
    kind: BlockPropertyValueV2Contract["kind"],
  ): BlockPropertyValueV2Contract | undefined => {
    const property = metadata.properties.find((candidate) => candidate.key === key);
    if (property === undefined || property.kind !== kind)
      fail(`Block '${metadata.key}' declares no ${kind} property '${key}'`, location);
    const value = Object.hasOwn(settings, key) ? settings[key] : undefined;
    if (value !== undefined && value.kind !== kind)
      fail(`Setting '${key}' must be a ${kind} value`, { ...location, propertyPath: [key] });
    return value;
  };

  const text = (key: string): string | undefined => {
    const value = read(key, "text");
    return value?.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;
  };

  return {
    read,
    text,
    boolean: (key) => {
      const value = read(key, "boolean");
      return value?.kind === "boolean" ? value.value : false;
    },
  };
}

/** Typed, fail-closed reads of a placement's settings against its declared properties. */
export type ControlSettings = Readonly<{
  text: (key: string) => string | undefined;
  boolean: (key: string) => boolean;
  number: (key: string) => number | undefined;
  choice: <Option extends string>(key: string, fallback: Option) => Option;
  options: (key: string) => readonly ChoiceOption[];
  /** The resolved record-type identifiers declared by a list of record_type_reference settings. */
  recordTypeIds: (key: string) => readonly string[];
  /** The required authored field key, validated as a builder key. */
  fieldKey: () => string;
}>;

export function readControlSettings(
  props: PlatformBlockRenderProps,
  location: DefinitionRenderErrorLocation,
): ControlSettings {
  const { metadata } = props;
  const { read, text, boolean } = createDeclaredSettingsReader(props, location);

  return {
    text,
    boolean,
    number: (key) => {
      const value = read(key, "number");
      return value?.kind === "number" ? value.value : undefined;
    },
    choice: <Option extends string>(key: string, fallback: Option): Option => {
      const value = read(key, "choice");
      if (value?.kind !== "choice") return fallback;
      const property = metadata.properties.find((candidate) => candidate.key === key);
      if (
        property?.kind !== "choice" ||
        !property.options.some((option) => option.key === value.value)
      )
        fail(`Setting '${key}' is not a declared choice`, { ...location, propertyPath: [key] });
      return value.value as Option;
    },
    options: (key) => {
      const value = read(key, "list");
      if (value?.kind !== "list") return Object.freeze([]);
      return parseChoiceOptions(
        value.items.map((item) => {
          if (item.kind !== "group")
            return fail(`Setting '${key}' items must be grouped options`, location);
          const optionKey = item.properties.key;
          const optionLabel = item.properties.label;
          return {
            key: optionKey?.kind === "text" ? optionKey.value : undefined,
            label: optionLabel?.kind === "text" ? optionLabel.value : undefined,
          };
        }),
        { ...location, propertyPath: [key] },
      );
    },
    fieldKey: () => {
      const parsed = builderKeySchema.safeParse(text("name"));
      return parsed.success
        ? parsed.data
        : fail("A field name must be lowercase words separated by underscores", {
            ...location,
            propertyPath: ["name"],
          });
    },
    recordTypeIds: (key) => {
      const value = read(key, "list");
      if (value?.kind !== "list") return Object.freeze([]);
      return Object.freeze(
        value.items.map((item) => {
          if (item.kind !== "record_type_reference")
            return fail(`Setting '${key}' items must be record type references`, location);
          return item.recordType.state === "resolved"
            ? item.recordType.recordTypeId
            : fail(`Setting '${key}' must reference resolved record types`, location);
        }),
      );
    },
  };
}
