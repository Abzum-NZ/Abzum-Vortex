import "server-only";

import {
  permittedSearchCandidates,
  permittedSearchRefusalReasonCodes,
  type PermittedSearchCandidate,
  type PermittedSearchDependencies,
  type PermittedSearchInput,
} from "./permitted-search";

/** Finite bounds for the local literal expression grammar. */
export const literalSearchLimits = Object.freeze({
  expressionLength: 2_000,
  terms: 32,
  phraseTokens: 64,
});

const literalSearchLocalRefusalReasonCodes = [
  "input_invalid",
  "expression_too_long",
  "invalid_expression",
  "too_many_terms",
  "phrase_too_long",
  "unsupported_scope",
] as const;

/** Safe local parser refusals plus the unchanged refusals from #645. */
export const literalSearchRefusalReasonCodes = Object.freeze([
  ...literalSearchLocalRefusalReasonCodes,
  ...permittedSearchRefusalReasonCodes,
] as const);

export type LiteralSearchRefusalReasonCode =
  (typeof literalSearchRefusalReasonCodes)[number];

/** One bounded literal expression evaluated over current permitted candidates. */
export type LiteralSearchInput = Readonly<{
  expression: string;
  search: PermittedSearchInput;
}>;

/** Approved fields and zero-based parsed expression term indices that matched. */
export type LiteralSearchMatchedField = Readonly<{
  fieldId: string;
  termIndices: readonly number[];
}>;

export type LiteralSearchMatch = Readonly<{
  /** The unchanged candidate returned by this call to `permittedSearchCandidates`. */
  candidate: PermittedSearchCandidate;
  matchedFields: readonly LiteralSearchMatchedField[];
}>;

export type LiteralSearchCompleted = Readonly<{
  outcome: "completed";
  organizationId: string;
  applicationRootId: string;
  recordTypeId: string;
  matches: readonly LiteralSearchMatch[];
}>;

export type LiteralSearchRefusal = Readonly<{
  outcome: "refused";
  reasonCode: LiteralSearchRefusalReasonCode;
}>;

export type LiteralSearchResult = LiteralSearchCompleted | LiteralSearchRefusal;

type LiteralSearchTerm = Readonly<{
  tokens: readonly string[];
}>;

type ParseExpressionResult =
  | Readonly<{ success: true; terms: readonly LiteralSearchTerm[] }>
  | Readonly<{ success: false; reasonCode: LiteralSearchRefusalReasonCode }>;

type TokenMatcherNode = {
  readonly next: Map<string, number>;
  failure: number;
  readonly termIndices: number[];
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isLiteralSearchInput = (value: unknown): value is LiteralSearchInput =>
  isRecord(value) &&
  hasOnlyKeys(value, ["expression", "search"]) &&
  typeof value.expression === "string" &&
  isRecord(value.search) &&
  hasOnlyKeys(value.search, ["access", "request", "candidates", "shared"]);

const refusal = (reasonCode: LiteralSearchRefusalReasonCode): LiteralSearchRefusal =>
  Object.freeze({ outcome: "refused", reasonCode });

const normalizeForMatch = (value: string): string => value.normalize("NFC").toLowerCase();

const whitespaceTokens = (value: string): readonly string[] =>
  normalizeForMatch(value)
    .split(/[\s\p{White_Space}]+/u)
    .filter((token) => token !== "");

const isWhitespace = (value: string): boolean => /[\s\p{White_Space}]/u.test(value);

/**
 * Parses bare whitespace-delimited tokens and whole-token quoted phrases.
 * Quotes have no escape syntax and are only valid at token boundaries.
 */
const parseExpression = (expression: string): ParseExpressionResult => {
  const terms: LiteralSearchTerm[] = [];
  let offset = 0;

  while (offset < expression.length) {
    while (offset < expression.length && isWhitespace(expression[offset]!)) offset += 1;
    if (offset >= expression.length) break;

    if (expression[offset] === '"') {
      offset += 1;
      const phraseStart = offset;
      while (offset < expression.length && expression[offset] !== '"') offset += 1;
      if (offset >= expression.length) return { success: false, reasonCode: "invalid_expression" };

      const tokens = whitespaceTokens(expression.slice(phraseStart, offset));
      if (tokens.length === 0) return { success: false, reasonCode: "invalid_expression" };
      if (tokens.length > literalSearchLimits.phraseTokens)
        return { success: false, reasonCode: "phrase_too_long" };

      offset += 1;
      if (offset < expression.length && !isWhitespace(expression[offset]!))
        return { success: false, reasonCode: "invalid_expression" };
      terms.push(Object.freeze({ tokens }));
    } else {
      const termStart = offset;
      while (offset < expression.length && !isWhitespace(expression[offset]!)) {
        if (expression[offset] === '"')
          return { success: false, reasonCode: "invalid_expression" };
        offset += 1;
      }

      const tokens = whitespaceTokens(expression.slice(termStart, offset));
      if (tokens.length !== 1) return { success: false, reasonCode: "invalid_expression" };
      terms.push(Object.freeze({ tokens }));
    }

    if (terms.length > literalSearchLimits.terms)
      return { success: false, reasonCode: "too_many_terms" };
  }

  if (terms.length === 0) return { success: false, reasonCode: "invalid_expression" };
  return Object.freeze({ success: true, terms: Object.freeze(terms) });
};

/** Builds a token-level Aho-Corasick matcher for all bounded terms. */
const createTokenMatcher = (terms: readonly LiteralSearchTerm[]): readonly TokenMatcherNode[] => {
  const nodes: TokenMatcherNode[] = [{ next: new Map(), failure: 0, termIndices: [] }];

  terms.forEach((term, termIndex) => {
    let state = 0;
    for (const token of term.tokens) {
      let nextState = nodes[state]!.next.get(token);
      if (nextState === undefined) {
        nextState = nodes.length;
        nodes[state]!.next.set(token, nextState);
        nodes.push({ next: new Map(), failure: 0, termIndices: [] });
      }
      state = nextState;
    }
    nodes[state]!.termIndices.push(termIndex);
  });

  const queue: number[] = [];
  for (const childState of nodes[0]!.next.values()) queue.push(childState);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor]!;
    const node = nodes[state]!;

    for (const [token, childState] of node.next) {
      let fallbackState = node.failure;
      while (fallbackState !== 0 && !nodes[fallbackState]!.next.has(token))
        fallbackState = nodes[fallbackState]!.failure;

      const fallbackTransition = nodes[fallbackState]!.next.get(token);
      const child = nodes[childState]!;
      child.failure = fallbackTransition ?? 0;
      child.termIndices.push(...nodes[child.failure]!.termIndices);
      queue.push(childState);
    }
  }

  return nodes;
};

const matchCandidate = (
  candidate: PermittedSearchCandidate,
  terms: readonly LiteralSearchTerm[],
  matcher: readonly TokenMatcherNode[],
): LiteralSearchMatch | undefined => {
  const matchedTermIndices = new Set<number>();
  const matchedFields: LiteralSearchMatchedField[] = [];

  for (const entry of candidate.entries) {
    const entryTokens = whitespaceTokens(entry.text);
    const fieldTermIndices = new Set<number>();
    let state = 0;

    for (const token of entryTokens) {
      while (state !== 0 && !matcher[state]!.next.has(token))
        state = matcher[state]!.failure;
      state = matcher[state]!.next.get(token) ?? 0;

      for (const termIndex of matcher[state]!.termIndices) {
        fieldTermIndices.add(termIndex);
        matchedTermIndices.add(termIndex);
      }

      if (fieldTermIndices.size === terms.length) break;
    }

    if (fieldTermIndices.size > 0) {
      matchedFields.push(
        Object.freeze({
          fieldId: entry.fieldId,
          termIndices: Object.freeze([...fieldTermIndices].sort((left, right) => left - right)),
        }),
      );
    }
  }

  if (matchedTermIndices.size !== terms.length) return undefined;
  return Object.freeze({ candidate, matchedFields: Object.freeze(matchedFields) });
};

/**
 * Matches a strict literal AND expression over only the current readable local
 * candidates returned by `permittedSearchCandidates`.
 */
export const matchLiteralSearch = async (
  input: LiteralSearchInput,
  dependencies: PermittedSearchDependencies,
): Promise<LiteralSearchResult> => {
  if (!isLiteralSearchInput(input)) return refusal("input_invalid");
  if (Object.hasOwn(input.search, "shared")) return refusal("unsupported_scope");

  if (input.expression.length > literalSearchLimits.expressionLength)
    return refusal("expression_too_long");

  const parsed = parseExpression(input.expression);
  if (!parsed.success) return refusal(parsed.reasonCode);

  // Validate only the bounded expression above; filter before reading candidate text.
  const permitted = await permittedSearchCandidates(input.search, dependencies);
  if (permitted.outcome === "refused") return refusal(permitted.reasonCode);

  const matcher = createTokenMatcher(parsed.terms);
  const matches: LiteralSearchMatch[] = [];
  for (const candidate of permitted.candidates) {
    const match = matchCandidate(candidate, parsed.terms, matcher);
    if (match !== undefined) matches.push(match);
  }

  return Object.freeze({
    outcome: "completed",
    organizationId: permitted.organizationId,
    applicationRootId: permitted.applicationRootId,
    recordTypeId: permitted.recordTypeId,
    matches: Object.freeze(matches),
  });
};
