"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  canonicalJson,
  flowLiteralSchema,
  jsonValueSchema,
  type CustomComponentRelease,
  isRecord,
} from "@vortex/platform/schema";
import { useConfirm } from "../components/confirm-dialog";
import { DefinitionRenderError } from "../definition-error";
import type { PlatformBlockRenderProps } from "../registry";
import { getAccessibleName } from "../display/display-state-container";
import {
  componentBundleContentAddressFromIntegrity,
  customComponentBootstrapUrl,
} from "./bootstrap-url";

/**
 * The sandboxed host for a custom component release. It frames the Vortex-owned bootstrap document
 * on the dedicated component origin, transfers exactly one MessageChannel port at load, sends only
 * the mapped data-contract values and the application's theme tokens, and treats every inbound
 * message as untrusted input: only a declared event with a well-formed typed payload runs its
 * binding, and anything else is dropped.
 */

/** One declared custom component event, as carried by its release. */
export type CustomComponentEventDeclaration = CustomComponentRelease["events"][number];

/** One typed value a custom component sends back in an event payload. */
export type CustomComponentEventPayload = Readonly<Record<string, unknown>>;

/** One validated event emitted by a custom component. */
export type CustomComponentEvent = Readonly<{
  event: string;
  payload: CustomComponentEventPayload;
}>;

/**
 * One event binding: the flow invocation the renderer runs for a declared event, and whether that
 * flow changes data. A data-changing flow is confirmed by the host before its first change.
 */
export type CustomComponentEventBinding = Readonly<{
  run: (event: CustomComponentEvent) => unknown;
  changesData: boolean;
}>;

/** Event bindings accepted by one custom component placement, keyed only by declared event name. */
export type CustomComponentEventBindings = Readonly<Record<string, CustomComponentEventBinding>>;

/** The props a custom component host receives beyond the base platform render props. */
export type CustomComponentHostProps = PlatformBlockRenderProps &
  Readonly<{
    /** The mapped data-contract values already projected for the viewer. */
    values?: Readonly<Record<string, unknown>>;
    /** The flow bindings for the component's declared events. */
    events?: CustomComponentEventBindings;
    /** The application theme tokens in force where this placement renders. */
    themeTokens?: Readonly<Record<string, unknown>>;
    /** The configured dedicated component origin that serves the bootstrap document. */
    componentBundleOrigin?: string;
  }>;

const HOST_PROTOCOL_VERSION = 1;
const INIT_MESSAGE_TYPE = "vortex:custom-component:init";
const UPDATE_MESSAGE_TYPE = "vortex:custom-component:update";
const EVENT_MESSAGE_TYPE = "vortex:custom-component:event";
const GRAPHICS_CONTEXT_LOST_MESSAGE_TYPE = "vortex:custom-component:graphics-context-lost";

const EMPTY_RECORD: Readonly<Record<string, unknown>> = Object.freeze({});
const EMPTY_BINDINGS: CustomComponentEventBindings = Object.freeze({});

/**
 * Validates one untrusted event payload against its declared event. An undeclared field, a missing
 * required field, or a value that does not match its declared value type (the shared typed-literal
 * rule, which also refuses template delimiters in text) makes the whole message invalid, so the host
 * drops it instead of forwarding it to a flow.
 */
export const validateCustomComponentEventPayload = (
  declaration: CustomComponentEventDeclaration,
  value: unknown,
): CustomComponentEventPayload | undefined => {
  const supplied = value === undefined ? {} : value;
  if (!isRecord(supplied)) return undefined;
  const declaredKeys = new Set(declaration.payload.map((field) => field.key));
  for (const key of Object.keys(supplied)) if (!declaredKeys.has(key)) return undefined;
  for (const field of declaration.payload) {
    const present = Object.hasOwn(supplied, field.key);
    if (!present) {
      if (field.required) return undefined;
      continue;
    }
    if (!flowLiteralSchema.safeParse({ type: field.type, value: supplied[field.key] }).success)
      return undefined;
  }
  return Object.freeze({ ...supplied });
};

/**
 * The values the host sends: only keys the release's data contract declares, each a JSON value.
 * Anything else is withheld, so an over-supplied value never reaches the publisher's code even when
 * the host is rendered outside the registration's parser.
 */
const contractValues = (
  custom: CustomComponentRelease | undefined,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  if (custom === undefined) return EMPTY_RECORD;
  const sent: Record<string, unknown> = {};
  for (const field of custom.dataContract.values)
    if (Object.hasOwn(values, field.key) && jsonValueSchema.safeParse(values[field.key]).success)
      sent[field.key] = values[field.key];
  return Object.freeze(sent);
};

/**
 * Renders one custom component through the sandboxed bootstrap document. The frame title is the
 * component's accessible name, the declared text alternative is rendered for assistive technology,
 * and the frame re-renders when the component reports a lost graphics context.
 */
export function CustomComponentHost(props: CustomComponentHostProps): ReactElement {
  const {
    metadata,
    settings,
    placementId,
    values,
    events: bindings,
    themeTokens,
    componentBundleOrigin,
  } = props;

  const custom = metadata.customComponent;
  const accessibleName = getAccessibleName(settings, metadata);
  const suppliedValues = values ?? EMPTY_RECORD;
  const mappedValues = useMemo(
    () => contractValues(custom, suppliedValues),
    [custom, suppliedValues],
  );
  const eventBindings = bindings ?? EMPTY_BINDINGS;
  const suppliedTokens = themeTokens ?? EMPTY_RECORD;
  const tokens = jsonValueSchema.safeParse(suppliedTokens).success ? suppliedTokens : EMPTY_RECORD;

  const declarationMap = useMemo(
    () => new Map((custom?.events ?? []).map((event) => [event.key, event] as const)),
    [custom],
  );

  const bootstrapSrc = useMemo(() => {
    if (custom === undefined) return undefined;
    if (componentBundleOrigin === undefined || componentBundleOrigin.trim().length === 0)
      return undefined;
    const contentAddress = componentBundleContentAddressFromIntegrity(custom.bundle.digest);
    if (contentAddress === undefined) return undefined;
    return customComponentBootstrapUrl(componentBundleOrigin, {
      contentAddress,
      entryFile: custom.bundle.entryFile,
      allowedHosts: custom.bundle.allowedHosts,
    });
  }, [custom, componentBundleOrigin]);

  const valuesRef = useRef(mappedValues);
  const tokensRef = useRef(tokens);
  const bindingsRef = useRef(eventBindings);
  valuesRef.current = mappedValues;
  tokensRef.current = tokens;
  bindingsRef.current = eventBindings;

  const payloadSignature = useMemo(
    // JSON.stringify orders integer-like keys before other keys in the existing signature.
    () => JSON.stringify(JSON.parse(canonicalJson({ values: mappedValues, themeTokens: tokens }))),
    [mappedValues, tokens],
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | undefined>(undefined);
  // The frame element that already received its port. A later load of the same element means the
  // frame navigated away from the bootstrap document, so it receives no second port or data.
  const handshakeFrameRef = useRef<HTMLIFrameElement | undefined>(undefined);
  const mountedRef = useRef(true);
  const runningRef = useRef(new Set<string>());
  const queuedRef = useRef(new Map<string, CustomComponentEventPayload>());
  const [generation, setGeneration] = useState(0);
  const [confirm, confirmDialog] = useConfirm();

  const closePort = useCallback(() => {
    const port = portRef.current;
    portRef.current = undefined;
    if (port !== undefined) {
      port.onmessage = null;
      port.close();
    }
  }, []);

  // The one shared confirmation prompt, rendered as a sibling of the sandboxed frame, never inside
  // it, so the untrusted component can neither draw nor read it. A prompt asked while another is
  // open waits for it, so the events are answered in the order they arrived.
  const requestConfirmation = useCallback(
    (eventLabel: string) =>
      confirm({
        title: "Confirm",
        description: `“${eventLabel}” may change data. Continue?`,
        confirmLabel: "Confirm",
      }),
    [confirm],
  );

  const runBinding = useCallback(
    async (eventKey: string, payload: CustomComponentEventPayload): Promise<void> => {
      if (!mountedRef.current) return;
      const binding = bindingsRef.current[eventKey];
      if (binding === undefined) return;
      // One in-flight flow per binding: a repeated event replaces the queued one and is coalesced,
      // so the last run uses the latest event.
      if (runningRef.current.has(eventKey)) {
        queuedRef.current.set(eventKey, payload);
        return;
      }
      runningRef.current.add(eventKey);
      try {
        if (binding.changesData) {
          const label = declarationMap.get(eventKey)?.label ?? eventKey;
          const confirmed = await requestConfirmation(label);
          if (!confirmed) {
            // A declined change also discards the events that arrived while it was being asked.
            queuedRef.current.delete(eventKey);
            return;
          }
        }
        await binding.run(Object.freeze({ event: eventKey, payload }));
      } catch {
        // A refused or failed flow is reported by the flow runtime; the host stays usable.
      } finally {
        runningRef.current.delete(eventKey);
        const queued = queuedRef.current.get(eventKey);
        queuedRef.current.delete(eventKey);
        if (queued !== undefined && mountedRef.current) void runBinding(eventKey, queued);
      }
    },
    [declarationMap, requestConfirmation],
  );

  const handleFrameMessage = useCallback(
    (port: MessagePort, data: unknown): void => {
      // Only the current port is heard; a port from a replaced frame is already closed.
      if (portRef.current !== port || !isRecord(data)) return;
      if (data.type === GRAPHICS_CONTEXT_LOST_MESSAGE_TYPE) {
        // Re-render by remounting the sandboxed document with a fresh port.
        closePort();
        setGeneration((current) => current + 1);
        return;
      }
      if (data.type !== EVENT_MESSAGE_TYPE) return;
      const eventKey = data.event;
      if (typeof eventKey !== "string") return;
      const declaration = declarationMap.get(eventKey);
      if (declaration === undefined) return;
      const payload = validateCustomComponentEventPayload(declaration, data.payload);
      if (payload === undefined) return;
      void runBinding(eventKey, payload);
    },
    [closePort, declarationMap, runBinding],
  );

  const handleLoad = useCallback(() => {
    const frame = iframeRef.current;
    closePort();
    if (frame === null) return;
    if (handshakeFrameRef.current === frame) return;
    handshakeFrameRef.current = frame;
    const target = frame.contentWindow;
    if (target === null) return;
    const channel = new MessageChannel();
    const port = channel.port1;
    portRef.current = port;
    port.onmessage = (event) => handleFrameMessage(port, event.data);
    // The sandboxed document has an opaque origin, which no exact target origin can name, so the
    // only possible target is "*". The first load of this frame element is the bootstrap document
    // itself; any later load is refused above, and every later message uses the transferred port.
    target.postMessage(
      {
        type: INIT_MESSAGE_TYPE,
        protocolVersion: HOST_PROTOCOL_VERSION,
        events: [...declarationMap.keys()],
        payload: { values: valuesRef.current, themeTokens: tokensRef.current },
      },
      "*",
      [channel.port2],
    );
  }, [closePort, declarationMap, handleFrameMessage]);

  useEffect(() => {
    const port = portRef.current;
    if (port === undefined) return;
    port.postMessage({
      type: UPDATE_MESSAGE_TYPE,
      protocolVersion: HOST_PROTOCOL_VERSION,
      payload: { values: valuesRef.current, themeTokens: tokensRef.current },
    });
  }, [payloadSignature]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queuedRef.current.clear();
      closePort();
    };
  }, [closePort]);

  const location = {
    placementId,
    blockId: metadata.blockId,
    releaseVersion: metadata.releaseVersion,
  };
  if (custom === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Block '${metadata.key}' is not a custom component release`,
      location,
    );
  if (accessibleName === undefined)
    throw new DefinitionRenderError(
      "MISSING_ACCESSIBLE_NAME",
      `Custom component '${metadata.key}' requires an accessible name`,
      location,
    );
  if (bootstrapSrc === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Custom component '${metadata.key}' has no configured component bundle origin or bundle digest`,
      location,
    );

  const alternativeId = `${placementId}-custom-component-alternative`;

  return (
    <div data-vortex-custom-component={placementId} className="vortex-custom-component">
      <p id={alternativeId} className="vortex-sr-only">
        {custom.textAlternative}
      </p>
      <iframe
        key={`${generation}:${bootstrapSrc}`}
        ref={iframeRef}
        title={accessibleName}
        aria-describedby={alternativeId}
        src={bootstrapSrc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        data-vortex-custom-component-frame="true"
        className="vortex-custom-component-frame"
        style={{ display: "block", width: "100%", height: "100%", border: 0 }}
        onLoad={handleLoad}
      />
      {confirmDialog}
    </div>
  );
}
