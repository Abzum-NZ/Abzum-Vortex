"use client";

import { useEffect, useState } from "react";
import { describeFailure } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import type { PageWebMcpTool } from "../../../../../_lib/application-page";

type RegisteredTool = Readonly<{
  name: string;
  description: string;
  inputSchema: object;
  execute: (input: unknown) => Promise<unknown>;
}>;

type ModelContext = Readonly<{
  registerTool: (
    tool: RegisteredTool,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<void>;
}>;

type Props = Readonly<{
  contextKey: string;
  tools: readonly PageWebMcpTool[];
  onInvoke: (tool: PageWebMcpTool, input: unknown) => Promise<unknown>;
}>;

const sessionDisabledKey = "vortex:webmcp:disabled";

const modelContextForDocument = (): ModelContext | undefined => {
  const currentDocument = document as Document & { modelContext?: ModelContext };
  if (currentDocument.modelContext !== undefined) return currentDocument.modelContext;
  const currentNavigator = navigator as Navigator & { modelContext?: ModelContext };
  return currentNavigator.modelContext;
};

const isInputObject = (candidate: unknown): candidate is Readonly<Record<string, unknown>> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

const matchesToolInputKeys = (tool: PageWebMcpTool, candidate: unknown): boolean => {
  if (!isInputObject(candidate)) return false;
  const expected = new Set(Object.keys(tool.inputSchema.properties));
  return (
    tool.inputSchema.required.every((name) => Object.hasOwn(candidate, name)) &&
    Object.keys(candidate).every((name) => expected.has(name))
  );
};

export function WebMcpAdapter({ contextKey, tools, onInvoke }: Props) {
  const [modelContext, setModelContext] = useState<ModelContext>();
  const [disabled, setDisabled] = useState(false);
  const [status, setStatus] = useState<"checking" | "registering" | "active" | "off" | "error">(
    "checking",
  );
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const context = modelContextForDocument();
    setModelContext(context);
    if (context === undefined) {
      setStatus("checking");
      return;
    }
    try {
      setDisabled(window.sessionStorage.getItem(sessionDisabledKey) === "1");
    } catch (error) {
      console.error(`[webmcp] session preference could not be read: ${describeFailure(error)}`);
      setDisabled(false);
    }
  }, []);

  const toolSignature = JSON.stringify(tools);
  useEffect(() => {
    if (modelContext === undefined || tools.length === 0) {
      setStatus("checking");
      return;
    }
    if (disabled) {
      setStatus("off");
      return;
    }

    const controller = new AbortController();
    setStatus("registering");
    const registrations = tools.map((tool) =>
      modelContext.registerTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: async (input) => {
            if (controller.signal.aborted || disabled || !matchesToolInputKeys(tool, input))
              return { outcome: "refused" };
            try {
              return await onInvoke(tool, input);
            } catch (error) {
              console.error(`[webmcp] tool invocation failed: ${describeFailure(error)}`);
              return { outcome: "unavailable" };
            }
          },
        },
        { signal: controller.signal },
      ),
    );
    void Promise.all(registrations)
      .then(() => {
        if (!controller.signal.aborted) setStatus("active");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        controller.abort();
        console.error(`[webmcp] tool registration failed: ${describeFailure(error)}`);
        setStatus("error");
      });
    return () => controller.abort();
  }, [contextKey, disabled, modelContext, onInvoke, retry, toolSignature, tools.length]);

  if (modelContext === undefined || tools.length === 0 || status === "checking") return null;

  const turnOff = (): void => {
    try {
      window.sessionStorage.setItem(sessionDisabledKey, "1");
    } catch (error) {
      console.error(`[webmcp] session preference could not be saved: ${describeFailure(error)}`);
    }
    setDisabled(true);
  };
  const turnOn = (): void => {
    try {
      window.sessionStorage.removeItem(sessionDisabledKey);
    } catch (error) {
      console.error(`[webmcp] session preference could not be cleared: ${describeFailure(error)}`);
    }
    setDisabled(false);
    setRetry((current) => current + 1);
  };

  return (
    <div
      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
      role="status"
      aria-live="polite"
      data-vortex-webmcp={status}
    >
      <span>
        {status === "active"
          ? "Browser agent tools are active on this page."
          : status === "off"
            ? "Browser agent tools are off for this session."
            : status === "registering"
              ? "Enabling browser agent tools…"
              : "Browser agent tools could not be enabled."}
      </span>
      {disabled ? (
        <Button type="button" variant="outline" size="sm" onClick={turnOn}>
          Turn on
        </Button>
      ) : status === "error" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRetry((current) => current + 1)}
        >
          Retry
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={turnOff}>
          Turn off for this session
        </Button>
      )}
    </div>
  );
}
