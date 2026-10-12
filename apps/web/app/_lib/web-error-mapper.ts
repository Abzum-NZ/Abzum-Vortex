import "server-only";

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

const safeCause = (error: unknown): readonly Readonly<Record<string, string>>[] => {
  const causes: Readonly<Record<string, string>>[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    let isError = false;
    try {
      isError = current instanceof Error;
    } catch {
      isError = false;
    }
    const name = isError
      ? (safeText(readDataProperty(current, "name")) ?? "Error")
      : typeof current;
    const rawCode = safeText(readDataProperty(current, "code"));
    const code =
      typeof rawCode === "string" && /^[A-Z0-9_]{3,64}$/.test(rawCode) ? rawCode : undefined;
    const message = safeText(readDataProperty(current, "message"));
    causes.push({
      name,
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
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
