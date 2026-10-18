"use client";
import type * as Operations from "../../_lib/studio-read-operations";

/** Fetch reads independently of Next's serialized Server Action mutation queue. */
const read = async <Result>(
  operation: string,
  organizationId: string,
  candidate: unknown,
): Promise<Result> => {
  const query = new URLSearchParams({ organizationId, request: JSON.stringify(candidate) });
  const response = await fetch(`/studio/read/${operation}?${query}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`STUDIO_READ_HTTP_${response.status}`);
  return response.json() as Promise<Result>;
};

export const resolveStudioApplicationConditionContext: typeof Operations.resolveStudioApplicationConditionContext =
  (organizationId, candidate) => read("condition-context", organizationId, candidate);
export const resolveStudioApplicationTheme: typeof Operations.resolveStudioApplicationTheme = (
  organizationId,
  candidate,
) => read("theme", organizationId, candidate);
