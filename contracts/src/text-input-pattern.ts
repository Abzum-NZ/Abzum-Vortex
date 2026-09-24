/**
 * Compile the deliberately small, bounded text-input pattern contract.
 * Patterns use Unicode semantics and reject constructs that can backtrack
 * exponentially on attacker-controlled input.
 */
export const compileTextInputPattern = (source: string): RegExp | undefined => {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "u");
  } catch {
    return undefined;
  }

  const groups: { containsAlternation: boolean; containsQuantifier: boolean }[] = [
    { containsAlternation: false, containsQuantifier: false },
  ];
  let previousAtomWasGroup = false;
  let previousGroupContainsQuantifier = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const next = source[index + 1];
      if (
        (next !== undefined && /[1-9]/.test(next)) ||
        (next === "k" && source[index + 2] === "<")
      )
        return undefined;
      if ((next === "u" || next === "p" || next === "P") && source[index + 2] === "{") {
        const close = source.indexOf("}", index + 3);
        index = close === -1 ? index + 1 : close;
      } else {
        index += 1;
      }
      previousAtomWasGroup = false;
      continue;
    }
    if (character === "[") {
      // RegExp construction above guarantees a closing bracket; escaped `]`
      // does not end the class.
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === "]") break;
        index += 1;
      }
      previousAtomWasGroup = false;
      continue;
    }
    if (character === "(") {
      groups.push({ containsAlternation: false, containsQuantifier: false });
      previousAtomWasGroup = false;
      continue;
    }
    if (character === ")") {
      const closed = groups.pop();
      if (closed === undefined) return undefined;
      groups[groups.length - 1]!.containsQuantifier ||= closed.containsQuantifier;
      groups[groups.length - 1]!.containsAlternation ||= closed.containsAlternation;
      previousAtomWasGroup = true;
      previousGroupContainsQuantifier = closed.containsQuantifier || closed.containsAlternation;
      continue;
    }
    if (character === "|") {
      groups[groups.length - 1]!.containsAlternation = true;
      previousAtomWasGroup = false;
      continue;
    }

    let quantifierLength = 0;
    if (character === "*" || character === "+") quantifierLength = 1;
    else if (character === "?" && source[index - 1] !== "(") quantifierLength = 1;
    else if (character === "{") {
      const close = source.indexOf("}", index + 1);
      if (close !== -1 && /^\d+(?:,\d*)?$/.test(source.slice(index + 1, close)))
        quantifierLength = close - index + 1;
    }

    if (quantifierLength > 0) {
      if (previousAtomWasGroup && previousGroupContainsQuantifier) return undefined;
      groups[groups.length - 1]!.containsQuantifier = true;
      index += quantifierLength - 1;
      // A following question mark makes this quantifier lazy; it is not a
      // second quantifier on the same atom.
      if (source[index + 1] === "?") index += 1;
      previousAtomWasGroup = false;
      continue;
    }

    previousAtomWasGroup = false;
  }
  return groups.length === 1 ? pattern : undefined;
};
