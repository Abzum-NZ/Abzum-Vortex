"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { jsonValueSchema, type CustomComponentReleaseV2 } from "@vortex/contracts";
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
export type CustomComponentEventDeclaration = CustomComponentReleaseV2["events"][number];

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  return value;
};

/**
 * Validates one untrusted event payload against its declared event. An undeclared field, a missing
 * required field or a value that is not a JSON value makes the whole message invalid, so the host
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
    if (!jsonValueSchema.safeParse(supplied[field.key]).success) return undefined;
  }
  return Object.freeze({ ...supplied });
};

/** A modal confirmation on the native `<dialog>`: focus moves in, Escape cancels. */
function ConfirmationDialog({
  eventLabel,
  onConfirm,
  onCancel,
}: Readonly<{ eventLabel: string; onConfirm: () => void; onCancel: () => void }>): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const surface = ref.current;
    const previous = document.activeElement;
    if (surface !== null && !surface.open) surface.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="vortex-dialog"
      data-vortex-custom-component-confirmation="true"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="vortex-dialog-header">
        <h2 className="vortex-dialog-title">Confirm</h2>
      </div>
      <div className="vortex-dialog-body">
        <p>{`“${eventLabel}” may change data. Continue?`}</p>
      </div>
      <div className="vortex-dialog-actions">
        <button type="button" className="vortex-button vortex-button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="vortex-button vortex-button-primary" onClick={onConfirm}>
          Confirm
        </button>
      </div>
    </dialog>
  );
}

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
  const mappedValues = values ?? EMPTY_RECORD;
  const eventBindings = bindings ?? EMPTY_BINDINGS;
  const tokens = themeTokens ?? EMPTY_RECORD;

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
    () => JSON.stringify(canonicalValue({ values: mappedValues, themeTokens: tokens })),
    [mappedValues, tokens],
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | undefined>(undefined);
  const confirmationRef = useRef<
    Readonly<{ eventLabel: string; settle: (confirmed: boolean) => void }> | undefined
  >(undefined);
  const runningRef = useRef(new Set<string>());
  const queuedRef = useRef(new Map<string, CustomComponentEventPayload>());
  const [generation, setGeneration] = useState(0);
  const [confirmation, setConfirmation] = useState<
    Readonly<{ eventLabel: string; settle: (confirmed: boolean) => void }> | undefined
  >(undefined);

  const closePort = useCallback(() => {
    const port = portRef.current;
    portRef.current = undefined;
    if (port !== undefined) {
      port.onmessage = null;
      port.close();
    }
  }, []);

  const settleConfirmation = useCallback((confirmed: boolean) => {
    const pending = confirmationRef.current;
    confirmationRef.current = undefined;
    setConfirmation(undefined);
    pending?.settle(confirmed);
  }, []);

  const requestConfirmation = useCallback(
    (eventLabel: string) =>
      new Promise<boolean>((resolve) => {
        const pending = Object.freeze({ eventLabel, settle: resolve });
        confirmationRef.current = pending;
        setConfirmation(pending);
      }),
    [],
  );

  const runBinding = useCallback(
    async (
      eventKey: string,
      payload: CustomComponentEventPayload,
    ): Promise<void> => {
      const binding = bindingsRef.current[eventKey];
      if (binding === undefined) return;
      // One in-flight flow per binding: a repeated event replaces the queued one and is coalesced.
      if (runningRef.current.has(eventKey)) {
        queuedRef.current.set(eventKey, payload);
        return;
      }
      runningRef.current.add(eventKey);
      try {
        if (binding.changesData) {
          const label = declarationMap.get(eventKey)?.label ?? eventKey;
          const confirmed = await requestConfirmation(label);
          if (!confirmed) return;
        }
        await binding.run(Object.freeze({ event: eventKey, payload }));
      } catch {
        // A refused or failed flow is reported by the flow runtime; the host stays usable.
      } finally {
        runningRef.current.delete(eventKey);
        const queued = queuedRef.current.get(eventKey);
        if (queued !== undefined) {
          queuedRef.current.delete(eventKey);
          void runBinding(eventKey, queued);
        }
      }
    },
    [declarationMap, requestConfirmation],
  );

  const handleFrameMessage = useCallback(
    (data: unknown): void => {
      if (!isRecord(data)) return;
      if (data.type === GRAPHICS_CONTEXT_LOST_MESSAGE_TYPE) {
        // Re-render the frame by remounting the sandboxed document.
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
    [declarationMap, runBinding],
  );

  const handleLoad = useCallback(() => {
    const frame = iframeRef.current;
    closePort();
    if (frame === null) return;
    const target = frame.contentWindow;
    if (target === null) return;
    const channel = new MessageChannel();
    const port = channel.port1;
    portRef.current = port;
    port.onmessage = (event) => handleFrameMessage(event.data);
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

  useEffect(
    () => () => {
      const pending = confirmationRef.current;
      confirmationRef.current = undefined;
      pending?.settle(false);
      closePort();
    },
    [closePort],
  );

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
        key={generation}
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
      {confirmation === undefined ? null : (
        <ConfirmationDialog
          eventLabel={confirmation.eventLabel}
          onConfirm={() => settleConfirmation(true)}
          onCancel={() => settleConfirmation(false)}
        />
      )}
    </div>
  );
}
