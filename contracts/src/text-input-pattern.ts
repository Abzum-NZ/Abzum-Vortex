/**
 * Compile a text-input pattern under the one bounded contract every consumer
 * shares. Patterns use Unicode semantics. Backreferences, and a repeating
 * quantifier over a group that itself contains a quantifier or alternation,
 * are refused because they can backtrack exponentially on hostile input.
 * Returns undefined when the pattern is invalid or unsafe.
 */
export const compileTextInputPattern = (source: string): RegExp | undefined => {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "u");
  } catch {
    return undefined;
  }
  return isBoundedTextInputPattern(source) ? pattern : undefined;
};

type GroupScan = { containsAlternation: boolean; containsQuantifier: boolean };

// `?`, `{0,1}` and `{1}` match their atom at most once, so they cannot nest
// backtracking; every other quantifier repeats its atom.
const quantifierAt = (
  source: string,
  index: number,
): { end: number; repeats: boolean } | undefined => {
  const character = source[index];
  if (character === "*" || character === "+") return { end: index, repeats: true };
  if (character === "?") return { end: index, repeats: false };
  if (character !== "{") return undefined;
  const close = source.indexOf("}", index + 1);
  const bounds = close === -1 ? null : /^(\d+)(,(\d*))?$/.exec(source.slice(index + 1, close));
  if (bounds === null) return undefined;
  const maximum =
    bounds[2] === undefined ? Number(bounds[1]) : bounds[3] === "" ? Infinity : Number(bounds[3]);
  return { end: close, repeats: maximum > 1 };
};

// Scans source that already compiled with the Unicode flag, so escapes,
// classes, groups and braces are well formed; anything unexpected fails closed.
const isBoundedTextInputPattern = (source: string): boolean => {
  const groups: GroupScan[] = [{ containsAlternation: false, containsQuantifier: false }];
  // The group that just closed, while it is the atom a following quantifier
  // would apply to.
  let previousGroup: GroupScan | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const current = groups[groups.length - 1]!;
    if (character === "\\") {
      const next = source[index + 1];
      // Numbered and named backreferences.
      if ((next !== undefined && next >= "1" && next <= "9") || next === "k") return false;
      if ((next === "u" || next === "p" || next === "P") && source[index + 2] === "{") {
        const close = source.indexOf("}", index + 3);
        if (close === -1) return false;
        index = close;
      } else {
        index += 1;
      }
      previousGroup = undefined;
      continue;
    }
    if (character === "[") {
      // An escaped `]` does not end the class; `[]` is the empty class.
      index += 1;
      while (index < source.length && source[index] !== "]") {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      previousGroup = undefined;
      continue;
    }
    if (character === "(") {
      groups.push({ containsAlternation: false, containsQuantifier: false });
      // In `(?:`, `(?=`, `(?<name>` and similar the question mark is group
      // syntax, not a quantifier.
      if (source[index + 1] === "?") index += 1;
      previousGroup = undefined;
      continue;
    }
    if (character === ")") {
      const closed = groups.pop();
      const parent = groups[groups.length - 1];
      if (closed === undefined || parent === undefined) return false;
      parent.containsAlternation ||= closed.containsAlternation;
      parent.containsQuantifier ||= closed.containsQuantifier;
      previousGroup = closed;
      continue;
    }
    if (character === "|") {
      current.containsAlternation = true;
      previousGroup = undefined;
      continue;
    }
    const quantifier = quantifierAt(source, index);
    if (quantifier !== undefined) {
      if (
        quantifier.repeats &&
        previousGroup !== undefined &&
        (previousGroup.containsQuantifier || previousGroup.containsAlternation)
      )
        return false;
      // Even `?` counts inside a repeated group: `(a?a?)*` backtracks
      // exponentially.
      current.containsQuantifier = true;
      index = quantifier.end;
      // A following question mark makes the quantifier lazy; it is not a
      // second quantifier on the same atom.
      if (source[index + 1] === "?") index += 1;
      previousGroup = undefined;
      continue;
    }
    if (character === "{") return false;
    previousGroup = undefined;
  }
  return groups.length === 1;
};
