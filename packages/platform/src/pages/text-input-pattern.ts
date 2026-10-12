/**
 * Text input patterns are a deliberately small subset of JavaScript regular
 * expressions: a sequence of literals, escapes, character classes and dots,
 * with at most one quantified atom. A quantified pattern must start with `^`.
 * Without groups, alternation or a second quantifier, matching cannot revisit
 * overlapping repetitions or retry a repetition at every input position.
 */
export const compileTextInputPattern = (source: string): RegExp | undefined => {
  if (!hasLinearTextInputGrammar(source)) return undefined;
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "u");
  } catch {
    return undefined;
  }
  return pattern;
};

const quantifierEnd = (source: string, index: number): number | undefined => {
  const character = source[index];
  if (character === "*" || character === "+" || character === "?") return index;
  if (character !== "{") return undefined;
  const close = source.indexOf("}", index + 1);
  if (close === -1) return undefined;
  const bounds = /^(\d+)(?:,(\d*))?$/.exec(source.slice(index + 1, close));
  if (bounds === null) return undefined;
  // Huge bounds can make compilation or matching expensive even without
  // backtracking. Open upper bounds are allowed because there is one atom.
  if (Number(bounds[1]) > 1000 || (bounds[2] && Number(bounds[2]) > 1000)) return undefined;
  return close;
};

const hasLinearTextInputGrammar = (source: string): boolean => {
  let quantifiers = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined || (next >= "1" && next <= "9") || next === "k") return false;
      if ((next === "u" || next === "p" || next === "P") && source[index + 2] === "{") {
        const close = source.indexOf("}", index + 3);
        if (close === -1) return false;
        index = close;
      } else {
        index += 1;
      }
      continue;
    }
    if (character === "[") {
      index += 1;
      while (index < source.length && source[index] !== "]") {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      if (index === source.length) return false;
      continue;
    }
    if (character === "(" || character === ")" || character === "|") return false;
    if (character === "*" || character === "+" || character === "?" || character === "{") {
      const end = quantifierEnd(source, index);
      if (end === undefined || ++quantifiers > 1) return false;
      index = end;
    }
  }
  return quantifiers === 0 || source.startsWith("^");
};
