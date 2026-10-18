"use client";
import { useEffect, useState } from "react";

/**
 * A text control bound to one draft value: each change goes to the draft at once through `apply`,
 * which answers `true` or the problem that kept the text out of the draft. Text that is not valid
 * yet (an empty name) stays in the control with its problem. When the draft value changes from
 * elsewhere (Undo, Redo, another edit) the control shows it, unless it is what the person is typing
 * (the same text up to surrounding spaces, which the draft does not keep).
 */
export function useStudioDraftText(value: string, apply: (next: string) => string | true): Readonly<{
  text: string;
  problem: string;
  change: (next: string) => void;
}> {
  const [text, setText] = useState(value);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    setText((current) => current.trim() === value.trim() ? current : value);
    setProblem("");
  }, [value]);
  return {
    text, problem,
    change: (next) => {
      setText(next);
      const result = apply(next);
      setProblem(result === true ? "" : result);
    },
  };
}
