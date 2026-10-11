/**
 * Source production only, from apps/web outside Next. Bundle this entry with the installed esbuild
 * CLI: --bundle --platform=node --format=cjs --jsx=automatic --external:react
 * --external:react-dom/server --outfile=node_modules/.cache/application-install-source/generator.cjs
 * Then run that own generated file with Node. JSX automatic preserves the shipped adapter source;
 * plain tsx reads the UI library's jsx=preserve setting and cannot render those adapters correctly.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadIconAdapter, VORTEX_ICON_LIBRARIES, VORTEX_ICON_NAMES } from "@vortex/ui/icons";

const tags = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const attributes = new Set(["xmlns", "width", "height", "viewBox", "fill", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "fill-rule", "clip-rule", "d", "cx", "cy",
  "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "points", "opacity", "fill-opacity",
  "stroke-opacity", "stroke-dasharray", "stroke-dashoffset", "transform", "color", "aria-hidden", "role"]);
const validate = (svg: string): void => {
  if (svg.length > 30_000 || !svg.startsWith("<svg ") || !svg.endsWith("</svg>"))
    throw new Error("Install icon output is unsupported");
  const tokenPattern = /<\/?([a-z]+)([^<>]*?)\/?>/g;
  let offset = 0;
  for (const token of svg.matchAll(tokenPattern)) {
    if (svg.slice(offset, token.index).trim() !== "" || !tags.has(token[1]!))
      throw new Error("Install icon element is unsupported");
    const attributeText = token[2]!;
    const attributePattern = /\s+([a-zA-Z][a-zA-Z0-9-]*)="([^"<>]*)"/g;
    let cursor = 0;
    for (const attribute of attributeText.matchAll(attributePattern)) {
      const name = attribute[1]!; const value = attribute[2]!;
      if (attributeText.slice(cursor, attribute.index).trim() !== "" || !attributes.has(name) ||
          /url\(|javascript:|data:|[&<>]/i.test(value) ||
          (name === "xmlns" ? value !== "http://www.w3.org/2000/svg" : /https?:/i.test(value)))
        throw new Error("Install icon attribute is unsupported");
      cursor = attribute.index! + attribute[0].length;
    }
    if (attributeText.slice(cursor).trim() !== "") throw new Error("Install icon attributes are malformed");
    offset = token.index! + token[0].length;
  }
  if (svg.slice(offset).trim() !== "") throw new Error("Install icon markup is malformed");
};

async function main(): Promise<void> {
const uiPackage = JSON.parse(await readFile(resolve(process.cwd(), "../../ui/package.json"), "utf8")) as { dependencies: Record<string, string> };
const sourcePackages = ["lucide-react", "@hugeicons/react", "@hugeicons/core-free-icons",
  "@tabler/icons-react", "@phosphor-icons/react", "@remixicon/react"];
const libraries: Record<string, Record<string, string>> = {};
for (const library of VORTEX_ICON_LIBRARIES) {
  const adapter = await loadIconAdapter(library);
  const glyphs: Record<string, string> = {};
  for (const name of VORTEX_ICON_NAMES) {
    const svg = renderToStaticMarkup(createElement(adapter[name], { width: 24, height: 24,
      color: "currentColor", "aria-hidden": true })).replace(/ class="[^"<>]*"/g, "");
    validate(svg);
    glyphs[name] = svg;
  }
  libraries[library] = glyphs;
}
const output = resolve(process.cwd(), "app/_lib/application-install-icons.generated.json");
await writeFile(output, JSON.stringify({ version: 1,
  source: Object.fromEntries(sourcePackages.map((name) => [name, uiPackage.dependencies[name]])),
  libraries }, null, 2) + "\n");
console.log(`Generated ${VORTEX_ICON_LIBRARIES.length * VORTEX_ICON_NAMES.length} shipped SVG glyphs: ${output}`);

}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
