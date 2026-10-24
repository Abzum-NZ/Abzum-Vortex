import "server-only";

import { ZodError } from "zod";

type WebErrorMapping<Result> = Readonly<{
  route: string;
  operation: string;
  code: string;
  fallback: Result;
}>;

const readDataProperty = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
    // guard-allow: silent-catch A hostile error proxy may reject inspection; logging must preserve the neutral response.
  } catch {
    return undefined;
  }
};

const safeText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\beyJ[A-Z0-9_-]+\.[A-Z0-9_-]+\.[A-Z0-9_-]+\b/gi, "[redacted-token]")
    .replace(/\bBearer\s+[A-Z0-9._~+/-]{12,}=*/gi, "Bearer [redacted-token]")
    .replace(
      /\b(?:sb_(?:publishable|secret)|sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Z0-9_-]{16,}\b/gi,
      "[redacted-token]",
    )
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "[redacted-id]")
    .replace(/(['"])[^'"\r\n]{1,512}\1/g, "[redacted]")
    .replace(/\b(password|token|secret|authorization|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .slice(0, 300);
};

type SafeZodIssue = Readonly<{
  code: string;
  path: readonly (string | number)[];
}>;

const safeIssuePathSegment = (value: unknown): string | number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  const text = safeText(value);
  return typeof text === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(text)
    ? text
    : "[redacted]";
};

const safeZodIssues = (error: ZodError): readonly SafeZodIssue[] => {
  const issues = readDataProperty(error, "issues");
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 32).flatMap((issue): SafeZodIssue[] => {
    const rawCode = readDataProperty(issue, "code");
    if (typeof rawCode !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(rawCode)) return [];
    const rawPath = readDataProperty(issue, "path");
    const path = Array.isArray(rawPath) ? rawPath.slice(0, 16).map(safeIssuePathSegment) : [];
    return [{ code: rawCode, path }];
  });
};

const safeCause = (error: unknown): readonly Readonly<Record<string, unknown>>[] => {
  const causes: Readonly<Record<string, unknown>>[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    let isError = false;
    try {
      isError = current instanceof Error;
      // guard-allow: silent-catch A hostile error proxy may reject prototype inspection; retain only its safe type.
    } catch {
      isError = false;
    }
    const name = isError
      ? (safeText(readDataProperty(current, "name")) ?? "Error")
      : typeof current;
    const rawCode = safeText(readDataProperty(current, "code"));
    const code =
      typeof rawCode === "string" && /^[A-Za-z0-9_]{3,64}$/.test(rawCode) ? rawCode : undefined;
    const message = safeText(readDataProperty(current, "message"));
    let issues: readonly SafeZodIssue[] | undefined = undefined;
    try {
      if (current instanceof ZodError) issues = safeZodIssues(current);
      // guard-allow: silent-catch Error inspection is best-effort; logging must not change the neutral response.
    } catch {
      // Keep the safe class and code when schema issue inspection is unavailable.
    }
    causes.push({
      name,
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
      ...(issues === undefined ? {} : { issues }),
    });
    current = readDataProperty(current, "cause");
  }
  return causes;
};

/** Logs one safe operation failure and returns the caller's existing neutral response. */
export const mapWebError = <Result>(error: unknown, mapping: WebErrorMapping<Result>): Result => {
  console.error(
    "[web] operation failed",
    JSON.stringify({
      route: mapping.route,
      operation: mapping.operation,
      code: mapping.code,
      cause: safeCause(error),
    }),
  );
  return mapping.fallback;
};
