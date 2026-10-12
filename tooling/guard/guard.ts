import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, extname, basename, dirname } from "node:path";
import ts from "typescript";
import { guardRules, packageAreas, paths, scannedRuleIds } from "./config.ts";

type Finding = { rule: string; file: string; line: number; detail: string; id: string };
const root = resolve(import.meta.dirname, "../..");
const baselinePath = resolve(import.meta.dirname, "baseline.json");
const hasBaseline = existsSync(baselinePath);
const ruleTier = (rule: string) =>
  (guardRules as Record<string, { tier: "blocking" | "warning" }>)[rule]?.tier ?? "warning";
const isBlocking = (rule: string) => ruleTier(rule) === "blocking";
const baseline = hasBaseline
  ? (JSON.parse(readFileSync(baselinePath, "utf8")) as string[]).filter((id) =>
      isBlocking(id.split("|")[0]),
    )
  : [];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".sql"]);
const findings: Finding[] = [];
const silentFindings: Array<{ file: string; line: number; variable: string; branch: string }> = [];
const occurrences = new Map<string, number>();
const normalize = (value: string) => value.replaceAll("\\", "/");
const read = (file: string) => readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
const renamedFromMain = new Map<string, string>();
const renamed = spawnSync("git", ["diff", "--find-renames=90%", "--name-status", "origin/main"], {
  cwd: root,
  encoding: "utf8",
});
if (renamed.status === 0) {
  for (const line of renamed.stdout.split("\n")) {
    const [status, previous, current] = line.trim().split("\t");
    if (status?.startsWith("R") && previous && current)
      renamedFromMain.set(normalize(current), normalize(previous));
  }
}
// Preserve rename identity from the move commit when later import rewrites lower similarity.
const commits = spawnSync("git", ["rev-list", "--reverse", "origin/main..HEAD"], {
  cwd: root,
  encoding: "utf8",
});
if (commits.status === 0) {
  let previous = "origin/main";
  for (const commit of commits.stdout.trim().split("\n").filter(Boolean)) {
    const step = spawnSync(
      "git",
      ["diff", "--find-renames=90%", "--name-status", previous, commit],
      { cwd: root, encoding: "utf8" },
    );
    if (step.status === 0)
      for (const line of step.stdout.split("\n")) {
        const [status, before, after] = line.trim().split("\t");
        if (status?.startsWith("R") && before && after && !renamedFromMain.has(normalize(after)))
          renamedFromMain.set(normalize(after), normalize(before));
      }
    previous = commit;
  }
}
const lineAt = (content: string, offset: number) => content.slice(0, offset).split("\n").length;
function add(rule: string, file: string, line: number, detail: string): void {
  const base = `${rule}|${file}|${rule === "file-size" ? "over 1500 lines" : detail}`;
  const count = (occurrences.get(base) ?? 0) + 1;
  occurrences.set(base, count);
  const id = `${base}|${count}`;
  findings.push({ rule, file, line, detail, id });
}
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map(normalize)
  .filter((file) => existsSync(resolve(root, file)));
const codeFiles = files.filter(
  (file) => sourceExtensions.has(extname(file)) && !file.startsWith("tooling/guard/"),
);
function area(file: string): string {
  for (const [name, prefixes] of Object.entries(paths)) {
    if (Array.isArray(prefixes) && prefixes.some((prefix) => file.startsWith(prefix))) return name;
  }
  return "other";
}
function importedArea(specifier: string, file: string): string {
  if (specifier.startsWith(".")) {
    const target = normalize(relative(root, resolve(root, dirname(file), specifier)));
    if (file === "packages/platform/src/schema.ts" && target.startsWith("packages/platform/src/"))
      return "schema";
    return area(target);
  }
  if (specifier.startsWith("@vortex/platform/schema")) return "schema";
  if (specifier.startsWith("@vortex/platform/server")) return "platform";
  if (specifier.startsWith("@vortex/")) {
    const key = specifier.split("/").slice(0, 2).join("/");
    return packageAreas[key] ?? "platform";
  }
  return "other";
}
function violatesLayering(file: string, specifier: string): boolean {
  const fileArea = area(file);
  const target = importedArea(specifier, file);
  return (
    (target === "web" && fileArea !== "web") ||
    (fileArea === "platform" && (target === "ui" || target === "definitions")) ||
    (fileArea === "schema" && target !== "schema" && target !== "other") ||
    ((fileArea === "ui" || fileArea === "definitions") &&
      (target === "platform" ||
        target === "web" ||
        (target === "definitions" && fileArea === "ui") ||
        (target === "ui" && fileArea === "definitions")))
  );
}
const applicationFiles = files.filter(
  (file) => file.startsWith(paths.applicationSources) && /\/application\.json$/.test(file),
);
const names = new Set<string>();
for (const file of applicationFiles) {
  const source = JSON.parse(read(file)) as { key?: string; body?: { name?: string } };
  if (source.key) names.add(source.key);
  if (source.body?.name) names.add(source.body.name);
}
const businessPattern = new RegExp(
  `(?<![\\w])(?:${[...names]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\w])`,
  "gi",
);

for (const file of codeFiles) {
  const content = read(file);
  if (content.split("\n").length > 1500)
    add("file-size", file, 1501, `${content.split("\n").length} lines`);
  if (/-v[2-9]\d*(?=\.)/i.test(basename(file))) add("versioned-file", file, 1, basename(file));
  const fileArea = area(file);
  if (
    ["platform", "schema", "ui", "web"].includes(fileArea) &&
    !paths.developmentSetup.some((prefix) => file.startsWith(prefix))
  ) {
    for (const match of content.matchAll(businessPattern))
      add("business-name", file, lineAt(content, match.index), match[0].toLowerCase());
  }
  if (file.endsWith(".sql")) {
    if (file.startsWith(paths.canonical) || file.startsWith(paths.migrations)) {
      for (const match of content.matchAll(
        /\bcreate\s+(?:or\s+replace\s+)?(?:table|function|view|materialized\s+view|index|type|sequence|trigger)\s+(?:if\s+not\s+exists\s+)?(?:[\w"]+\.)?[\w"]*(?:receipt|fingerprint|continuity|evidence)[\w"]*/gi,
      )) {
        if (!/command_receipts\b/i.test(match[0]))
          add(
            "process-artifact",
            file,
            lineAt(content, match.index),
            match[0].replace(/\s+/g, " ").toLowerCase(),
          );
      }
    }
    continue;
  }
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier))
        checkImport(specifier.text, specifier.getStart(source));
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === "require")
    ) {
      checkImport(node.arguments[0].text, node.getStart(source));
    }
    if (
      (ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const namesToCheck = ts.isVariableStatement(node)
        ? node.declarationList.declarations.map((declaration) => declaration.name)
        : [node.name];
      for (const name of namesToCheck)
        if (name && /V[2-9]\d*$/.test(name.getText(source)))
          add(
            "versioned-export",
            file,
            lineAt(content, name.getStart(source)),
            name.getText(source),
          );
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements)
        if (/V[2-9]\d*$/.test(element.name.text))
          add(
            "versioned-export",
            file,
            lineAt(content, element.getStart(source)),
            element.name.text,
          );
    }
    if (
      fileArea !== "other" &&
      ts.isIdentifier(node) &&
      /(?:receipt|fingerprint|continuity|evidence)/i.test(node.text) &&
      node.text !== "command_receipts"
    ) {
      add("process-artifact", file, lineAt(content, node.getStart(source)), node.text);
    }
    if (fileArea === "platform" || fileArea === "schema") checkSilentParse(node);
    ts.forEachChild(node, visit);
  }
  function checkImport(specifier: string, offset: number): void {
    if (violatesLayering(file, specifier))
      add("layering", file, lineAt(content, offset), specifier);
  }
  function parseVariable(node: ts.Node): string | undefined {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer)
      return undefined;
    let found = false;
    function scan(value: ts.Node): void {
      if (
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === "safeParse"
      )
        found = true;
      ts.forEachChild(value, scan);
    }
    scan(node.initializer);
    return found ? node.name.text : undefined;
  }
  function parseSuccess(node: ts.Expression, variable: string): boolean {
    if (ts.isParenthesizedExpression(node)) return parseSuccess(node.expression, variable);
    return (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === variable &&
      node.name.text === "success"
    );
  }
  function failureCondition(node: ts.Expression, variable: string): "true" | "false" | undefined {
    if (ts.isParenthesizedExpression(node)) return failureCondition(node.expression, variable);
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken &&
      parseSuccess(node.operand, variable)
    )
      return "true";
    if (parseSuccess(node, variable)) return "false";
    if (ts.isBinaryExpression(node)) {
      const comparison = node.operatorToken.kind;
      if (
        parseSuccess(node.left, variable) &&
        (node.right.kind === ts.SyntaxKind.FalseKeyword ||
          node.right.kind === ts.SyntaxKind.TrueKeyword)
      ) {
        const equals =
          comparison === ts.SyntaxKind.EqualsEqualsToken ||
          comparison === ts.SyntaxKind.EqualsEqualsEqualsToken;
        const differs =
          comparison === ts.SyntaxKind.ExclamationEqualsToken ||
          comparison === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        if (equals || differs)
          return (node.right.kind === ts.SyntaxKind.FalseKeyword) === equals ? "true" : "false";
      }
      if (
        comparison === ts.SyntaxKind.BarBarToken ||
        comparison === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return failureCondition(node.left, variable) ?? failureCondition(node.right, variable);
    }
    return undefined;
  }
  function silentReturn(node: ts.Node): boolean {
    let hasReturn = false;
    let hasLog = false;
    function scan(value: ts.Node): void {
      if (ts.isReturnStatement(value) && (!value.expression || silentValue(value.expression)))
        hasReturn = true;
      if (
        ts.isCallExpression(value) &&
        /^(?:(?:console|logger)\.|log$|captureException$)/i.test(value.expression.getText(source))
      )
        hasLog = true;
      ts.forEachChild(value, scan);
    }
    scan(node);
    return hasReturn && !hasLog;
  }
  function silentValue(value: ts.Expression): boolean {
    return (
      value.kind === ts.SyntaxKind.NullKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isIdentifier(value) && value.text === "undefined")
    );
  }
  function checkSilentParse(node: ts.Node): void {
    const variable = parseVariable(node);
    if (!variable) return;
    const scope = node.parent?.parent?.parent;
    if (!scope) return;
    const later =
      ts.isBlock(scope) || ts.isSourceFile(scope)
        ? scope.statements.filter((statement) => statement.getStart(source) > node.getStart(source))
        : [];
    for (const statement of later) {
      function scan(value: ts.Node): void {
        if (ts.isIfStatement(value)) {
          const condition = failureCondition(value.expression, variable);
          const failureBranch =
            condition === "true"
              ? value.thenStatement
              : condition === "false"
                ? value.elseStatement
                : undefined;
          if (failureBranch && silentReturn(failureBranch))
            silentFindings.push({
              file,
              line: lineAt(content, value.getStart(source)),
              variable,
              branch: value.getText(source).replace(/\s+/g, " "),
            });
        }
        if (ts.isConditionalExpression(value)) {
          const condition = failureCondition(value.condition, variable);
          const failureBranch =
            condition === "true"
              ? value.whenTrue
              : condition === "false"
                ? value.whenFalse
                : undefined;
          if (failureBranch && silentValue(failureBranch))
            silentFindings.push({
              file,
              line: lineAt(content, value.getStart(source)),
              variable,
              branch: value.getText(source).replace(/\s+/g, " "),
            });
        }
        ts.forEachChild(value, scan);
      }
      scan(statement);
    }
  }
  visit(source);
}

for (const finding of silentFindings)
  add("silent-parse", finding.file, finding.line, finding.variable);

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const functionPattern = /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?\w+"?\s*\(/gi;
function functions(
  content: string,
): Map<string, { definition: string; offset: number; body: string }> {
  const result = new Map<string, { definition: string; offset: number; body: string }>();
  for (const match of content.matchAll(functionPattern)) {
    const start = match.index;
    const headerEnd = content.indexOf(")", start) + 1;
    if (!headerEnd) continue;
    const header = content.slice(start, headerEnd).replace(/\s+/g, " ").toLowerCase();
    const tag = /\bas\s+(\$[\w]*\$)/i.exec(content.slice(headerEnd, headerEnd + 1000));
    if (!tag) continue;
    const bodyStart = content.indexOf(tag[1], headerEnd) + tag[1].length;
    const bodyEnd = content.indexOf(tag[1], bodyStart);
    if (bodyEnd < 0) continue;
    const end = content.indexOf(";", bodyEnd + tag[1].length);
    if (end < 0) continue;
    result.set(header, {
      definition: content.slice(start, end + 1).trim(),
      offset: start,
      body: content.slice(bodyStart, bodyEnd),
    });
  }
  return result;
}
const latest = new Map<string, { definition: string; file: string }>();
for (const file of files
  .filter((file) => file.startsWith(paths.migrations) && file.endsWith(".sql"))
  .sort()) {
  for (const [key, value] of functions(read(file)))
    latest.set(key, { definition: value.definition, file });
}
for (const file of files.filter(
  (file) => file.startsWith(paths.canonical) && file.endsWith(".sql"),
)) {
  const content = read(file);
  for (const [key, value] of functions(content)) {
    const migration = latest.get(key);
    if (
      !migration ||
      migration.definition.replace(/\s+/g, " ") !== value.definition.replace(/\s+/g, " ")
    ) {
      add(
        "migration-mismatch",
        file,
        lineAt(content, value.offset),
        `${key} vs ${migration?.file ?? "missing migration"}`,
      );
    }
    for (const match of value.body.matchAll(uuidPattern))
      if (match[0].toLowerCase() !== "00000000-0000-0000-0000-000000000000") {
        add(
          "function-uuid",
          file,
          lineAt(content, value.offset + value.definition.indexOf(value.body) + match.index),
          match[0].toLowerCase(),
        );
      }
  }
}
for (const file of files.filter(
  (file) => file.startsWith(paths.migrations) && file.endsWith(".sql"),
)) {
  const content = read(file);
  for (const value of functions(content).values())
    for (const match of value.body.matchAll(uuidPattern)) {
      if (match[0].toLowerCase() !== "00000000-0000-0000-0000-000000000000")
        add(
          "function-uuid",
          file,
          lineAt(content, value.offset + value.definition.indexOf(value.body) + match.index),
          match[0].toLowerCase(),
        );
    }
}

const knip = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/knip/bin/knip.js"),
    "--reporter",
    "json",
    "--include",
    "files,exports,dependencies",
    "--no-progress",
    "--no-exit-code",
    "--include-entry-exports",
    "--cache",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
if (knip.error || !knip.stdout)
  throw new Error(`Knip failed: ${knip.error?.message ?? knip.stderr}`);
const report = JSON.parse(knip.stdout.slice(knip.stdout.indexOf("{"))) as {
  files?: string[];
  issues?: Array<{
    file: string;
    exports?: Array<{ name: string; line?: number }>;
    dependencies?: Array<{ name: string; line?: number }>;
  }>;
};
for (const file of report.files ?? []) add("unused-file", normalize(file), 1, "unused file");
for (const issue of report.issues ?? []) {
  for (const item of issue.exports ?? [])
    add("unused-export", normalize(issue.file), item.line ?? 1, item.name);
  for (const item of issue.dependencies ?? [])
    add("unused-dependency", normalize(issue.file), item.line ?? 1, item.name);
}
type Allowance = { file: string; line: number; rule: string; reason: string; used: boolean };
const allowances: Allowance[] = [];
for (const file of codeFiles) {
  for (const [index, line] of read(file).split("\n").entries()) {
    const comment = /(?:\/\/|--|\/\*|\*)\s*guard-allow:\s*(.*?)(?:\*\/|$)/.exec(line);
    if (!comment) continue;
    const directive = comment[1].trim();
    const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(directive);
    const lineNumber = index + 1;
    const rule = match?.[1];
    const reason = match?.[2]?.trim() ?? "";
    if (!rule || !scannedRuleIds.has(rule)) {
      add(
        "invalid-guard-allow",
        file,
        lineNumber,
        rule ? `unknown rule ${rule}` : "expected a rule id and reason",
      );
      continue;
    }
    if (reason.length < 10) {
      add("invalid-guard-allow", file, lineNumber, "reason must contain at least 10 characters");
      continue;
    }
    allowances.push({ file, line: lineNumber, rule, reason, used: false });
  }
}

const waived = new Set<string>();
const usedAllowances: Allowance[] = [];
const scannedUnique = [...new Map(findings.map((finding) => [finding.id, finding])).values()].sort(
  (a, b) => a.id.localeCompare(b.id),
);
for (const finding of scannedUnique) {
  const allowance = allowances.find(
    (candidate) =>
      !candidate.used &&
      candidate.file === finding.file &&
      candidate.rule === finding.rule &&
      candidate.line <= finding.line &&
      finding.line - candidate.line <= 1,
  );
  if (!allowance) continue;
  allowance.used = true;
  waived.add(finding.id);
  usedAllowances.push(allowance);
}
for (const allowance of allowances) {
  if (!allowance.used)
    add(
      "unused-guard-allow",
      allowance.file,
      allowance.line,
      `${allowance.rule}: ${allowance.reason}`,
    );
}

const unique = [
  ...new Map(
    findings.filter((finding) => !waived.has(finding.id)).map((finding) => [finding.id, finding]),
  ).values(),
].sort((a, b) => a.id.localeCompare(b.id));
const mainBaseline = spawnSync("git", ["show", "origin/main:tooling/guard/baseline.json"], {
  cwd: root,
  encoding: "utf8",
});
const hasMainSnapshot = mainBaseline.status === 0;
const allowed = hasMainSnapshot
  ? new Set(
      (JSON.parse(mainBaseline.stdout) as string[]).filter((id) => isBlocking(id.split("|")[0])),
    )
  : new Set(baseline);
const historicalPaths = new Map<string, Set<string>>();
function pathsForFile(file: string): Set<string> {
  const cached = historicalPaths.get(file);
  if (cached) return cached;
  const paths = new Set([file]);
  const previousPath = renamedFromMain.get(file);
  if (previousPath) paths.add(previousPath);
  for (const [currentPath, previous] of renamedFromMain)
    if (previous === file) paths.add(currentPath);
  const history = spawnSync(
    "git",
    ["log", "--follow", "--find-renames=90%", "--name-status", "--format=", "HEAD", "--", file],
    { cwd: root, encoding: "utf8" },
  );
  if (history.status !== 0)
    throw new Error(`Cannot read rename history for ${file}: ${history.stderr}`);
  for (const line of history.stdout.split("\n")) {
    const [status, before, after] = line.trim().split("\t");
    if (status?.startsWith("R") && before && after) {
      paths.add(normalize(before));
      paths.add(normalize(after));
    }
  }
  historicalPaths.set(file, paths);
  return paths;
}
function existedUnderRenamedPath(id: string): boolean {
  const first = id.indexOf("|");
  const second = id.indexOf("|", first + 1);
  if (first < 0 || second < 0) return false;
  const prefix = id.slice(0, first + 1);
  const file = id.slice(first + 1, second);
  const suffix = id.slice(second);
  return [...pathsForFile(file)].some(
    (path) => path !== file && allowed.has(`${prefix}${path}${suffix}`),
  );
}
const current = new Set(unique.map((finding) => finding.id));
const mainFiles = new Map<string, boolean>();
const mainSourceCache = new Map<string, string | undefined>();
function sourceFromMain(file: string): string | undefined {
  if (mainSourceCache.has(file)) return mainSourceCache.get(file);
  const previous = spawnSync("git", ["show", `origin/main:${file}`], {
    cwd: root,
    encoding: "utf8",
  });
  const source = previous.status === 0 ? previous.stdout.replaceAll("\r\n", "\n") : undefined;
  mainSourceCache.set(file, source);
  return source;
}
function unchangedFromMain(file: string): boolean {
  const cached = mainFiles.get(file);
  if (cached !== undefined) return cached;
  const present = existsSync(resolve(root, file));
  const previous = sourceFromMain(file);
  const unchanged = previous !== undefined ? present && previous === read(file) : !present;
  mainFiles.set(file, unchanged);
  return unchanged;
}
function mainNames(): Set<string> {
  const result = new Set<string>();
  const listing = spawnSync(
    "git",
    ["ls-tree", "-r", "--name-only", "origin/main", "--", paths.applicationSources],
    { cwd: root, encoding: "utf8" },
  );
  if (listing.status !== 0)
    throw new Error(`Cannot list origin/main application definitions: ${listing.stderr}`);
  for (const file of listing.stdout
    .split("\n")
    .filter((entry) => /\/application\.json$/.test(entry))) {
    const content = sourceFromMain(file);
    if (content === undefined)
      throw new Error(`Cannot read origin/main application definition: ${file}`);
    const source = JSON.parse(content) as { key?: string; body?: { name?: string } };
    if (source.key) result.add(source.key);
    if (source.body?.name) result.add(source.body.name);
  }
  return result;
}
let mainBusinessPattern: RegExp | undefined;
function businessPatternOnMain(): RegExp {
  if (!mainBusinessPattern) {
    const namesOnMain = mainNames();
    mainBusinessPattern = new RegExp(
      `(?<![\\w])(?:${[...namesOnMain]
        .sort((a, b) => b.length - a.length)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})(?![\\w])`,
      "gi",
    );
  }
  return mainBusinessPattern;
}
let mainLatestFunctions: Map<string, { definition: string; file: string }> | undefined;
function latestFunctionsOnMain(): Map<string, { definition: string; file: string }> {
  if (mainLatestFunctions) return mainLatestFunctions;
  const listing = spawnSync(
    "git",
    ["ls-tree", "-r", "--name-only", "origin/main", "--", paths.migrations],
    { cwd: root, encoding: "utf8" },
  );
  if (listing.status !== 0)
    throw new Error(`Cannot list origin/main migrations: ${listing.stderr}`);
  mainLatestFunctions = new Map();
  for (const file of listing.stdout
    .split("\n")
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    const content = sourceFromMain(file);
    if (content === undefined) throw new Error(`Cannot read origin/main migration: ${file}`);
    for (const [key, value] of functions(content))
      mainLatestFunctions.set(key, { definition: value.definition, file });
  }
  return mainLatestFunctions;
}
function mainFindingCount(rule: string, file: string, detail: string): number {
  const content = sourceFromMain(file);
  if (content === undefined) return 0;
  if (rule === "business-name")
    return [...content.matchAll(businessPatternOnMain())].filter(
      (match) => match[0].toLowerCase() === detail.toLowerCase(),
    ).length;
  if (rule === "layering") {
    let count = 0;
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (
          specifier &&
          ts.isStringLiteral(specifier) &&
          specifier.text === detail &&
          violatesLayering(file, detail)
        )
          count += 1;
      }
      if (
        ts.isCallExpression(node) &&
        node.arguments.length &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === "require") &&
        node.arguments[0].text === detail &&
        violatesLayering(file, detail)
      )
        count += 1;
      ts.forEachChild(node, visit);
    }
    visit(source);
    return count;
  }
  if (rule === "versioned-file")
    return /-v[2-9]\d*(?=\.)/i.test(basename(file)) && basename(file) === detail ? 1 : 0;
  if (rule === "versioned-export") {
    let count = 0;
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (
        (ts.isVariableStatement(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const namesToCheck = ts.isVariableStatement(node)
          ? node.declarationList.declarations.map((declaration) => declaration.name)
          : [node.name];
        for (const name of namesToCheck)
          if (name && name.getText(source) === detail && /V[2-9]\d*$/.test(detail)) count += 1;
      }
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          if (element.name.text === detail && /V[2-9]\d*$/.test(detail)) count += 1;
      ts.forEachChild(node, visit);
    }
    visit(source);
    return count;
  }
  if (rule === "function-uuid") {
    let count = 0;
    for (const value of functions(content).values())
      for (const match of value.body.matchAll(uuidPattern))
        if (
          match[0].toLowerCase() === detail.toLowerCase() &&
          match[0].toLowerCase() !== "00000000-0000-0000-0000-000000000000"
        )
          count += 1;
    return count;
  }
  if (rule === "migration-mismatch") {
    const separator = detail.lastIndexOf(" vs ");
    if (separator < 0) return 0;
    const key = detail.slice(0, separator);
    const canonical = functions(content).get(key);
    if (!canonical) return 0;
    const migration = latestFunctionsOnMain().get(key);
    const mismatch =
      !migration ||
      migration.definition.replace(/\s+/g, " ") !== canonical.definition.replace(/\s+/g, " ");
    const actualDetail = `${key} vs ${migration?.file ?? "missing migration"}`;
    return mismatch && actualDetail === detail ? 1 : 0;
  }
  return 0;
}
function presentOnMain(id: string, sourceFile: string): boolean {
  if (!hasMainSnapshot) return true;
  const last = id.lastIndexOf("|");
  const occurrence = Number(id.slice(last + 1));
  const first = id.indexOf("|");
  const second = id.indexOf("|", first + 1);
  if (first < 0 || second < 0 || !Number.isInteger(occurrence) || occurrence < 1) return false;
  const rule = id.slice(0, first);
  const detail = id.slice(second + 1, last);
  return mainFindingCount(rule, sourceFile, detail) >= occurrence;
}
function mainBaselineEntry(
  id: string,
  currentFile: string,
): { id: string; sourceFile: string } | undefined {
  const first = id.indexOf("|");
  const second = id.indexOf("|", first + 1);
  if (first < 0 || second < 0) return undefined;
  const file = id.slice(first + 1, second);
  for (const path of pathsForFile(file)) {
    const candidate = `${id.slice(0, first + 1)}${path}${id.slice(second)}`;
    if (!allowed.has(candidate)) continue;
    if (!hasMainSnapshot) return { id: candidate, sourceFile: currentFile };
    const sourceFile = sourceFromMain(file) !== undefined ? file : path;
    if (sourceFromMain(sourceFile) !== undefined) return { id: candidate, sourceFile };
  }
  return undefined;
}
const carriedForward = new Map<string, string>();
for (const id of baseline) {
  if (current.has(id)) continue;
  const last = id.lastIndexOf("|");
  const occurrence = Number(id.slice(last + 1));
  const first = id.indexOf("|");
  const second = id.indexOf("|", first + 1);
  if (first < 0 || second < 0 || !Number.isInteger(occurrence)) continue;
  const rule = id.slice(0, first);
  const file = id.slice(first + 1, second);
  const detail = id.slice(second + 1, last);
  const movedFinding = unique.find((finding) => {
    if (finding.rule !== rule || finding.detail !== detail) return false;
    const findingOccurrence = Number(finding.id.slice(finding.id.lastIndexOf("|") + 1));
    return findingOccurrence === occurrence && pathsForFile(finding.file).has(file);
  });
  if (movedFinding) carriedForward.set(id, movedFinding.id);
}
// Only blocking findings belong in the baseline. New baseline entries must describe
// violations already present in an unchanged main file; stale entries only warn.
const growth = baseline.filter(
  (id) =>
    !allowed.has(id) &&
    !existedUnderRenamedPath(id) &&
    !(current.has(id) && unchangedFromMain(id.split("|")[1])),
);
const added = unique.filter((finding) => {
  if (!isBlocking(finding.rule) || unchangedFromMain(finding.file)) return false;
  const baselineEntry = mainBaselineEntry(finding.id, finding.file);
  return !baselineEntry || !presentOnMain(baselineEntry.id, baselineEntry.sourceFile);
});
const warnings = unique.filter((finding) => !isBlocking(finding.rule));
const stale = baseline.filter((id) => !current.has(id) && !carriedForward.has(id));
const today = new Date().toISOString().slice(0, 10);
const reviewNotices = Object.entries(guardRules).filter(([, rule]) => today > rule.reviewBy);

for (const finding of warnings)
  console.warn(`${finding.file}:${finding.line}: warning ${finding.rule}: ${finding.detail}`);
for (const id of stale)
  console.warn(`tooling/guard/baseline.json:1: warning stale-baseline: ${id}`);
for (const [ruleId, rule] of reviewNotices)
  console.log(
    `Guard review notice: ${ruleId} is past review-by ${rule.reviewBy} (owner: ${rule.owner})${"reviewNote" in rule && rule.reviewNote ? `; ${rule.reviewNote}` : ""}.`,
  );
for (const allowance of usedAllowances)
  console.log(
    `Guard allowance used: ${allowance.file}:${allowance.line}: ${allowance.rule}: ${allowance.reason}`,
  );

const blocking = added.filter((finding) => isBlocking(finding.rule));
for (const id of growth)
  console.error(`tooling/guard/baseline.json:1: blocking baseline-growth: ${id}`);
for (const finding of blocking)
  console.error(`${finding.file}:${finding.line}: blocking ${finding.rule}: ${finding.detail}`);

const warningCounts = new Map<string, number>();
for (const finding of warnings)
  warningCounts.set(finding.rule, (warningCounts.get(finding.rule) ?? 0) + 1);
const summary = [
  "## Guard summary",
  "",
  `- New blocking findings: ${blocking.length + growth.length}`,
  `- Warning findings: ${warnings.length + stale.length}`,
  `- Used allowances: ${usedAllowances.length}`,
  "",
  ...(warningCounts.size
    ? [
        "| Warning rule | Findings |",
        "| --- | ---: |",
        ...[...warningCounts].map(([rule, count]) => `| ${rule} | ${count} |`),
        "",
      ]
    : []),
  ...(stale.length
    ? [`Stale blocking baseline entries: ${stale.length}. They do not fail the guard.`, ""]
    : []),
  ...(reviewNotices.length
    ? [
        "### Review dates passed",
        ...reviewNotices.map(
          ([ruleId, rule]) =>
            `- ${ruleId}: owner ${rule.owner}; review-by ${rule.reviewBy}${"reviewNote" in rule && rule.reviewNote ? ` (${rule.reviewNote})` : ""}`,
        ),
        "",
      ]
    : []),
  ...(usedAllowances.length
    ? [
        "### Guard allowances used",
        ...usedAllowances.map(
          (allowance) =>
            `- ${allowance.file}:${allowance.line}: \`${allowance.rule}\` — ${allowance.reason}`,
        ),
        "",
      ]
    : []),
];
const summaryText = `${summary.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText);
else console.log(summaryText);

if (process.argv.includes("--refresh-from-main")) {
  const diff = spawnSync(
    "git",
    ["diff", "--quiet", "origin/main", "--", ".", ":(exclude)tooling/guard"],
    { cwd: root },
  );
  if (diff.status !== 0)
    throw new Error("--refresh-from-main requires a tree identical to origin/main");
  const blockingFindings = unique.filter((finding) => isBlocking(finding.rule));
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      blockingFindings.map((finding) => finding.id),
      null,
      2,
    )}\n`,
  );
  console.log(`Blocking baseline refreshed from main: ${blockingFindings.length} findings.`);
} else if (process.argv.includes("--update-baseline")) {
  if (growth.length) throw new Error(`Blocking baseline cannot grow: ${growth[0]}`);
  if (hasBaseline && blocking.length)
    throw new Error(
      `Blocking baseline cannot grow: ${blocking[0].file}:${blocking[0].line} ${blocking[0].rule} ${blocking[0].detail}`,
    );
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      hasBaseline
        ? [...new Set([...baseline.filter((id) => current.has(id)), ...carriedForward.values()])]
        : unique.filter((finding) => isBlocking(finding.rule)).map((finding) => finding.id),
      null,
      2,
    )}\n`,
  );
  console.log(
    `Blocking baseline contains ${hasBaseline ? baseline.length - stale.length : blocking.length} findings.`,
  );
} else if (blocking.length || growth.length) {
  process.exitCode = 1;
} else {
  console.log(`Guard passed (${baseline.length} blocking baseline entries).`);
}
