import { RE2JS, RE2JSCompileException, RE2JSSyntaxException } from "re2js";

/** Compile the authored RE2 pattern once for publication and every input path. */
export const compileTextInputPattern = (source: string): RE2JS | undefined => {
  if (source.length === 0 || source.length > 500) return undefined;
  try {
    return RE2JS.compile(source);
  } catch (error) {
    if (error instanceof RE2JSSyntaxException || error instanceof RE2JSCompileException)
      return undefined;
    throw error;
  }
};
