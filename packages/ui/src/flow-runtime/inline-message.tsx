"use client";

import { useContext, useSyncExternalStore, type ReactElement } from "react";
import { Button } from "../components/button";
import { FlowRuntimeStateContext } from "./flow-runtime-state-context";
import type { PageMessage } from "./messages";

export const inlineMessageId = (placementId: string): string => `vortex-inline-${placementId}`;

/** Warnings and errors interrupt assistive technology; information and success wait politely. */
export const inlineMessageLive = (message: PageMessage | undefined) =>
  message?.severity === "warning" || message?.severity === "error"
    ? ({ role: "alert", "aria-live": "assertive" } as const)
    : ({ role: "status", "aria-live": "polite" } as const);

/** The title, text and optional action of one inline message. */
export function InlineMessageContent({
  message,
}: Readonly<{ message: PageMessage }>): ReactElement {
  return (
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
  );
}

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
  const shown = message !== undefined && (message.refusal?.corrections?.length ?? 0) === 0;
  return (
    <div id={inlineMessageId(placementId)} hidden={!shown} {...inlineMessageLive(message)}>
      {shown ? <InlineMessageContent message={message} /> : null}
    </div>
  );
}
