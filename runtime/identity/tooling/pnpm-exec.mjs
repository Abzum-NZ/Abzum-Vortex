import { spawnSync } from "node:child_process";

// pnpm publishes its own entry point as npm_execpath: a native binary from pnpm 11
// onwards, or a JavaScript entry when it runs through Node (for example under Corepack).
export const createPnpmExec = (proofCommand) => {
  const pnpmEntry = process.env.npm_execpath;
  if (!pnpmEntry) throw new Error(`Run this proof through \`${proofCommand}\``);
  const runsThroughNode = /\.[cm]?js$/u.test(pnpmEntry);
  return (args, options) =>
    runsThroughNode
      ? spawnSync(process.execPath, [pnpmEntry, ...args], options)
      : spawnSync(pnpmEntry, args, options);
};
