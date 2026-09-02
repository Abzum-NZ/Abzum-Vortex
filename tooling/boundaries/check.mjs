import path from "node:path";
import { loadWorkspace, validateGraph, validateImports } from "./package-graph.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const packages = await loadWorkspace(root);
const errors = [...validateGraph(packages), ...(await validateImports(packages))];

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Boundary validation passed for ${packages.length} workspace packages.`);
}
