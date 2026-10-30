"use client";

import { useContext, useSyncExternalStore, type ReactElement } from "react";
import { Button } from "../components/button";
import { FlowRuntimeStateContext } from "./flow-runtime-state-context";

export const inlineMessageId = (placementId: string): string => `vortex-inline-${placementId}`;

/** The inline message for a form or section, scoped to its placement. */
export function InlineMessage({ placementId }: Readonly<{ placementId: string }>): ReactElement {
  const runtime = useContext(FlowRuntimeStateContext);
  const message = useSyncExternalStore(
    (listener) =>
      runtime?.subscribe(`message:${runtime.messages.key("inline", placementId)}`, listener) ??
      (() => undefined),
    () => runtime?.messages.read("inline", placementId),
    () => undefined,
  );
  const urgent = message?.severity === "warning" || message?.severity === "error";
  const shown = message !== undefined && (message.refusal?.corrections?.length ?? 0) === 0;
  return (
    <div
      id={inlineMessageId(placementId)}
      hidden={!shown}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      {!shown ? null : (
        <>
          {message.title === undefined ? null : <strong>{message.title}: </strong>}
          {message.text}
          {message.action === undefined ? null : message.action.kind === "link" ? (
            <a className="underline" href={message.action.href}>
              {message.action.label}
            </a>
          ) : (
            <Button type="button" variant="ghost" size="xs" onClick={message.action.run}>
              {message.action.label}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
