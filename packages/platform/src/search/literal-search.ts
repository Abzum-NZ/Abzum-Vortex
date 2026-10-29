import "server-only";

/** Finite bounds for the local literal expression grammar. */
const literalSearchLimits = Object.freeze({
  expressionLength: 2_000,
  terms: 32,
  phraseTokens: 64,
});

type LiteralSearchRefusalReasonCode = "invalid_expression" | "too_many_terms" | "phrase_too_long";

type LiteralSearchTerm = Readonly<{
  tokens: readonly string[];
  excluded: boolean;
}>;

type ParseExpressionResult =
  | Readonly<{
      success: true;
      terms: readonly LiteralSearchTerm[];
      groups: readonly (readonly number[])[];
    }>
  | Readonly<{ success: false; reasonCode: LiteralSearchRefusalReasonCode }>;

type TokenMatcherNode = {
  readonly next: Map<string, number>;
  failure: number;
  readonly termIndices: number[];
};

const normalizeForMatch = (value: string): string => value.normalize("NFC").toLowerCase();

const whitespaceTokens = (value: string): readonly string[] =>
  normalizeForMatch(value)
    .split(/[\s\p{White_Space}]+/u)
    .filter((token) => token !== "");

const isWhitespace = (value: string): boolean => /[\s\p{White_Space}]/u.test(value);

/**
 * Parses bare whitespace-delimited tokens and whole-token quoted phrases. A leading
 * minus excludes a word or phrase from its AND group.
 * Quotes have no escape syntax and are only valid at token boundaries.
 */
const parseExpression = (expression: string): ParseExpressionResult => {
  const terms: LiteralSearchTerm[] = [];
  const groups: number[][] = [];
  const group: number[] = [];
  let offset = 0;

  while (offset < expression.length) {
    while (offset < expression.length && isWhitespace(expression[offset]!)) offset += 1;
    if (offset >= expression.length) break;

    const excluded = expression[offset] === "-";
    if (excluded) {
      offset += 1;
      if (offset >= expression.length || isWhitespace(expression[offset]!))
        return { success: false, reasonCode: "invalid_expression" };
    }

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
      terms.push(Object.freeze({ tokens, excluded }));
    } else {
      const termStart = offset;
      while (offset < expression.length && !isWhitespace(expression[offset]!)) {
        if (expression[offset] === '"') return { success: false, reasonCode: "invalid_expression" };
        offset += 1;
      }

      const rawTerm = expression.slice(termStart, offset);
      const tokens = whitespaceTokens(rawTerm);
      if (tokens.length !== 1) return { success: false, reasonCode: "invalid_expression" };
      terms.push(Object.freeze({ tokens, excluded }));
    }

    if (terms.length > literalSearchLimits.terms)
      return { success: false, reasonCode: "too_many_terms" };
    group.push(terms.length - 1);
  }

  if (group.length === 0) return { success: false, reasonCode: "invalid_expression" };
  groups.push(group);
  return Object.freeze({
    success: true,
    terms: Object.freeze(terms),
    groups: Object.freeze(groups.map((termIndices) => Object.freeze(termIndices))),
  });
};

/** Parse the literal grammar once for the database search page. */
export const literalSearchTerms = (
  expression: string,
): readonly LiteralSearchTerm[] | undefined => {
  if (expression === "") return [];
  if (expression.length > literalSearchLimits.expressionLength) return undefined;
  const parsed = parseExpression(expression);
  return parsed.success ? parsed.terms : undefined;
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

/** Apply the same literal grammar to a permitted application name. */
export const matchesLiteralSearchText = (expression: string, text: string): boolean | undefined => {
  if (expression.length > literalSearchLimits.expressionLength) return undefined;
  const parsed = parseExpression(expression);
  if (!parsed.success) return undefined;
  const matcher = createTokenMatcher(parsed.terms);
  const found = new Set<number>();
  let state = 0;
  for (const token of whitespaceTokens(text)) {
    while (state !== 0 && !matcher[state]!.next.has(token)) state = matcher[state]!.failure;
    state = matcher[state]!.next.get(token) ?? 0;
    for (const index of matcher[state]!.termIndices) found.add(index);
  }
  return parsed.groups.some((group) =>
    group.every((index) => found.has(index) !== parsed.terms[index]!.excluded),
  );
};
