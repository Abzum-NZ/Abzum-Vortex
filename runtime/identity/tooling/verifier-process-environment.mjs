const inheritedLaunchVariables = Object.freeze([
  "PATH",
  "Path",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

export const createVerifierProcessEnvironment = (source, verifierValues) => {
  const environment = {};
  for (const name of inheritedLaunchVariables) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return { ...environment, ...verifierValues };
};
