"use client";

import { useCallback, useEffect, useState } from "react";
import { describeFailure } from "@vortex/platform/schema";
import type { ApplicationWebMcpRuntime } from "@vortex/ui";
import type { PageWebMcpTool } from "../../../../../_lib/application-page";

type RegisteredTool = Readonly<{
  name: string;
  description: string;
  inputSchema: object;
  annotations: Readonly<{ consequentialHint: true }>;
  execute: (input: unknown, options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
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
  onInvoke: (tool: PageWebMcpTool, input: unknown, signal?: AbortSignal) => Promise<unknown>;
  onStatusChange: (runtime: ApplicationWebMcpRuntime | undefined) => void;
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

export function WebMcpAdapter({ contextKey, tools, onInvoke, onStatusChange }: Props) {
  const [modelContext, setModelContext] = useState<ModelContext>();
  const [disabled, setDisabled] = useState(false);
  const [status, setStatus] = useState<"checking" | ApplicationWebMcpRuntime["status"]>("checking");
  const [retry, setRetry] = useState(0);

  const turnOff = useCallback((): void => {
    try {
      window.sessionStorage.setItem(sessionDisabledKey, "1");
    } catch (error) {
      console.error(`[webmcp] session preference could not be saved: ${describeFailure(error)}`);
    }
    setDisabled(true);
  }, []);

  const turnOn = useCallback((): void => {
    try {
      window.sessionStorage.removeItem(sessionDisabledKey);
    } catch (error) {
      console.error(`[webmcp] session preference could not be cleared: ${describeFailure(error)}`);
    }
    setDisabled(false);
    setRetry((current) => current + 1);
  }, []);

  const retryRegistration = useCallback((): void => setRetry((current) => current + 1), []);

  useEffect(() => {
    const context = modelContextForDocument();
    setModelContext(context);
    if (context === undefined) return;
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
      Promise.resolve().then(() => {
        if (controller.signal.aborted) return;
        return modelContext.registerTool(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { consequentialHint: true },
            execute: async (input, options) => {
              const signals = [
                controller.signal,
                ...(options?.signal === undefined ? [] : [options.signal]),
              ];
              const executionController = new AbortController();
              const abortExecution = (): void => {
                const aborted = signals.find((signal) => signal.aborted);
                if (aborted !== undefined) executionController.abort(aborted.reason);
              };
              signals.forEach((signal) =>
                signal.addEventListener("abort", abortExecution, { once: true }),
              );
              abortExecution();
              try {
                if (executionController.signal.aborted) return { outcome: "cancelled" };
                if (disabled || !matchesToolInputKeys(tool, input)) return { outcome: "refused" };
                return await onInvoke(tool, input, executionController.signal);
              } catch (error) {
                if (executionController.signal.aborted) return { outcome: "cancelled" };
                console.error(`[webmcp] tool invocation failed: ${describeFailure(error)}`);
                return { outcome: "unavailable" };
              } finally {
                signals.forEach((signal) => signal.removeEventListener("abort", abortExecution));
              }
            },
          },
          { signal: controller.signal },
        );
      }),
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

  useEffect(() => {
    if (modelContext === undefined || tools.length === 0 || status === "checking") {
      onStatusChange(undefined);
      return;
    }
    onStatusChange({ status, turnOff, turnOn, retry: retryRegistration });
  }, [modelContext, onStatusChange, retryRegistration, status, tools.length, turnOff, turnOn]);

  return null;
}
