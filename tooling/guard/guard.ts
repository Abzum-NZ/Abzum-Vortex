import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, extname, basename, dirname } from "node:path";
import ts from "typescript";
import { guardRules, packageAreas, paths, scannedRuleIds } from "./config.ts";

type Finding = { rule: string; file: string; line: number; detail: string; id: string };
const root = resolve(import.meta.dirname, "../..");
const baselinePath = resolve(import.meta.dirname, "baseline.json");
const remoteRefs = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/remotes"], {
  cwd: root,
  encoding: "utf8",
});
if (remoteRefs.status !== 0)
  throw new Error(`Cannot list fetched remote refs: ${remoteRefs.stderr}`);
const configuredRemotes = spawnSync("git", ["remote"], { cwd: root, encoding: "utf8" });
if (configuredRemotes.status !== 0)
  throw new Error(`Cannot list configured remotes: ${configuredRemotes.stderr}`);
const availableRemoteRefs = new Set(
  remoteRefs.stdout
    .split("\n")
    .map((ref) => ref.trim())
    .filter(Boolean),
);
const mainRefs = configuredRemotes.stdout
  .split("\n")
  .map((remote) => remote.trim())
  .filter(Boolean)
  .map((remote) => `refs/remotes/${remote}/main`)
  .filter((ref) => availableRemoteRefs.has(ref));
const mainRef = mainRefs.includes("refs/remotes/origin/main")
  ? "refs/remotes/origin/main"
  : mainRefs.sort()[0];
if (!mainRef)
  throw new Error("Guard requires a fetched remote main ref for safe baseline comparison.");
const mainRefLabel = mainRef.replace(/^refs\/remotes\//, "");
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
const baselineMigrationFiles = new Map([
  ["supabase/migrations/20261014000100_baseline_roles_and_extensions.sql", 168],
  ["supabase/migrations/20261014000200_baseline_schema_and_functions.sql", 105368],
  ["supabase/migrations/20261014000300_baseline_constraints_grants_and_policies.sql", 5241],
  ["supabase/migrations/20261014000400_baseline_system_data_and_storage.sql", 705],
  ["supabase/migrations/20261014001100_collapse_schemas_and_owner_roles.sql", 53870],
]);
const read = (file: string) => readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
const renamedFromMain = new Map<string, string>();
const renamed = spawnSync("git", ["diff", "--find-renames=90%", "--name-status", mainRef], {
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
const commits = spawnSync("git", ["rev-list", "--reverse", `${mainRef}..HEAD`], {
  cwd: root,
  encoding: "utf8",
});
if (commits.status === 0) {
  let previous = mainRef;
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
  const lineCount = content.split("\n").length;
  const baselineLineCount = baselineMigrationFiles.get(file);
  if (baselineLineCount !== undefined && lineCount > baselineLineCount)
    throw new Error(`Generated baseline migration grew: ${file}`);
  // Migrations carry every changed function's full body and are one per PR, so only source and
  // canonical schema files are held to the size cap.
  if (lineCount > 1500 && !file.startsWith(paths.migrations))
    add("file-size", file, 1501, `${lineCount} lines`);
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
    if (
      file.startsWith(paths.canonical) ||
      (file.startsWith(paths.migrations) && !baselineMigrationFiles.has(file))
    ) {
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
    if (fileArea === "platform" || fileArea === "web") checkSilentFailure(node);
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
  const refusalStatuses = new Set([
    "refused",
    "unavailable",
    "temporarily_unavailable",
    "task_refused",
  ]);
  function logsOrRethrows(node: ts.Node): boolean {
    let found = false;
    function scan(value: ts.Node): void {
      if (ts.isThrowStatement(value)) found = true;
      if (
        ts.isCallExpression(value) &&
        /(?:^(?:console|logger)\.|log|refus|fail|report|captureException|mapWebError|describe)/i.test(
          value.expression.getText(source),
        )
      )
        found = true;
      ts.forEachChild(value, scan);
    }
    scan(node);
    return found;
  }
  function refusalReturn(node: ts.Node): boolean {
    let found = false;
    function scan(value: ts.Node): void {
      if (
        ts.isReturnStatement(value) &&
        value.expression &&
        ts.isObjectLiteralExpression(value.expression) &&
        value.expression.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === "status" &&
            ts.isStringLiteralLike(property.initializer) &&
            refusalStatuses.has(property.initializer.text),
        )
      )
        found = true;
      if (!ts.isFunctionLike(value)) ts.forEachChild(value, scan);
    }
    scan(node);
    return found;
  }
  /** A catch clause or refusal branch must log its cause or rethrow it. */
  function checkSilentFailure(node: ts.Node): void {
    if (ts.isCatchClause(node) && !logsOrRethrows(node.block))
      silentFindings.push({
        file,
        line: lineAt(content, node.getStart(source)),
        variable: "catch",
        branch: "catch",
      });
    if (
      ts.isIfStatement(node) &&
      refusalReturn(node.thenStatement) &&
      !logsOrRethrows(node.thenStatement)
    )
      silentFindings.push({
        file,
        line: lineAt(content, node.getStart(source)),
        variable: "refusal",
        branch: "refusal",
      });
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
const dropFunctionPattern =
  /^\s*drop\s+function\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?\w+"?\s*\(/gim;
const renameFunctionPattern = /^\s*alter\s+function\s+(?:"?\w+"?\.)?"?\w+"?\s*\(/gim;
const functionNamePattern = /\bfunction\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/i;
const typeHeadPattern =
  /^(?:smallint|int2|int|integer|int4|bigint|int8|numeric|decimal|real|float4|float8|double\s+precision|smallserial|serial|bigserial|money|character\s+varying|character|varchar|text|bytea|timestamp|timestamptz|time|date|interval|bool|boolean|uuid|json|jsonb|xml|record|void|trigger|event_trigger|anyarray|anyelement|anyenum|anynonarray|anyrange|name|oid|regclass|regtype|inet|cidr|macaddr|tsvector|tsquery|pg_lsn|bit|varbit|vector|geometry|geography)\b/i;
function closingParenthesis(content: string, open: number): number {
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = open; index < content.length; index++) {
    const character = content[index];
    const next = content[index + 1];
    if (singleQuoted) {
      if (character === "'" && next === "'") index++;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') index++;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (character === "'") singleQuoted = true;
    else if (character === '"') doubleQuoted = true;
    else if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return index;
  }
  return -1;
}
function splitArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const next = value[index + 1];
    if (singleQuoted) {
      if (character === "'" && next === "'") index++;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') index++;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (character === "'") singleQuoted = true;
    else if (character === '"') doubleQuoted = true;
    else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "," && parentheses === 0 && brackets === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) result.push(last);
  return result;
}
function normalizedType(value: string): string {
  return value
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),.]|\[|\])\s*/g, "$1")
    .toLowerCase()
    .replace(/\btimestamptz\b/g, "timestamp with time zone");
}
function argumentType(argument: string): string | undefined {
  const mode = /^(inout|in|out|variadic)\b\s*/i.exec(argument.trim())?.[1]?.toLowerCase();
  if (mode === "out") return undefined;
  let value = argument.trim().replace(/^(?:inout|in|out|variadic)\b\s*/i, "");
  let parentheses = 0;
  let brackets = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const next = value[index + 1];
    if (singleQuoted) {
      if (character === "'" && next === "'") index++;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') index++;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (character === "'") singleQuoted = true;
    else if (character === '"') doubleQuoted = true;
    else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (parentheses === 0 && brackets === 0 && character === "=") {
      value = value.slice(0, index).trim();
      break;
    } else if (
      parentheses === 0 &&
      brackets === 0 &&
      /^default\b/i.test(value.slice(index)) &&
      (index === 0 || /\s/.test(value[index - 1]))
    ) {
      value = value.slice(0, index).trim();
      break;
    }
  }
  const firstToken = /^"?([\w$]+)"?/.exec(value)?.[1] ?? "";
  const rest = value.slice(firstToken.length).trim();
  if (rest && (/^(?:p_|arg_|v_)/i.test(firstToken) || !typeHeadPattern.test(value))) value = rest;
  return normalizedType(value);
}
function functions(
  content: string,
): Map<string, { definition: string; offset: number; body: string; identity: string }> {
  const result = new Map<
    string,
    { definition: string; offset: number; body: string; identity: string }
  >();
  for (const match of content.matchAll(functionPattern)) {
    const start = match.index;
    const open = content.indexOf("(", start);
    const close = closingParenthesis(content, open);
    if (close < 0) continue;
    const headerEnd = close + 1;
    const header = content.slice(start, headerEnd).replace(/\s+/g, " ").toLowerCase();
    const name = functionNamePattern.exec(header)?.[1]?.replaceAll('"', "").toLowerCase();
    if (!name) continue;
    const argumentTypes = splitArguments(header.slice(header.indexOf("(") + 1, -1))
      .map(argumentType)
      .filter((argument): argument is string => argument !== undefined);
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
      identity: `${name}(${argumentTypes.join(",")})`,
    });
  }
  return result;
}
const migrationFiles = files
  .filter((file) => file.startsWith(paths.migrations) && file.endsWith(".sql"))
  .sort();
const latest = new Map<string, { definition: string; file: string }>();
const latestLive = new Map<string, { file: string; line: number; key: string }>();
for (const file of migrationFiles) {
  const content = read(file);
  const migrationFunctions = functions(content);
  for (const [key, value] of migrationFunctions)
    latest.set(key, { definition: value.definition, file });
  const events: Array<
    | {
        kind: "create";
        offset: number;
        key: string;
        value: ReturnType<typeof functions> extends Map<string, infer T> ? T : never;
      }
    | { kind: "drop"; offset: number; identity: string }
    | {
        kind: "rename";
        offset: number;
        fromIdentity: string;
        toIdentity: string;
        toName: string;
      }
  > = [];
  for (const [key, value] of migrationFunctions)
    events.push({ kind: "create", offset: value.offset, key, value });
  for (const match of content.matchAll(dropFunctionPattern)) {
    const start = match.index + match[0].toLowerCase().indexOf("drop");
    const open = content.indexOf("(", start);
    const close = closingParenthesis(content, open);
    const name = functionNamePattern.exec(match[0])?.[1]?.replaceAll('"', "").toLowerCase();
    if (close < 0 || !name) continue;
    const argumentTypes = splitArguments(content.slice(open + 1, close)).map(normalizedType);
    events.push({ kind: "drop", offset: start, identity: `${name}(${argumentTypes.join(",")})` });
  }
  for (const match of content.matchAll(renameFunctionPattern)) {
    const start = match.index + match[0].toLowerCase().indexOf("alter");
    const open = content.indexOf("(", start);
    const close = closingParenthesis(content, open);
    const oldName = functionNamePattern.exec(match[0])?.[1]?.replaceAll('"', "").toLowerCase();
    if (close < 0 || !oldName) continue;
    const statementEnd = content.indexOf(";", close + 1);
    const statement = content.slice(close + 1, statementEnd < 0 ? undefined : statementEnd);
    const renamedTo = /\brename\s+to\s+("?\w+"?)/i
      .exec(statement)?.[1]
      ?.replaceAll('"', "")
      .toLowerCase();
    const movedTo = /\bset\s+schema\s+("?\w+"?)/i
      .exec(statement)?.[1]
      ?.replaceAll('"', "")
      .toLowerCase();
    if (!renamedTo && !movedTo) continue;
    const schema = oldName.includes(".") ? `${oldName.slice(0, oldName.lastIndexOf("."))}.` : "";
    const newName = movedTo
      ? `${movedTo}.${oldName.slice(oldName.lastIndexOf(".") + 1)}`
      : `${schema}${renamedTo}`;
    const argumentTypes = splitArguments(content.slice(open + 1, close)).map(normalizedType);
    events.push({
      kind: "rename",
      offset: start,
      fromIdentity: `${oldName}(${argumentTypes.join(",")})`,
      toIdentity: `${newName}(${argumentTypes.join(",")})`,
      toName: newName,
    });
  }
  events.sort((left, right) => left.offset - right.offset);
  for (const event of events) {
    if (event.kind === "drop") {
      latestLive.delete(event.identity);
      continue;
    }
    if (event.kind === "rename") {
      const previous = latestLive.get(event.fromIdentity);
      if (previous) {
        latestLive.delete(event.fromIdentity);
        latestLive.set(event.toIdentity, {
          file,
          line: lineAt(content, event.offset),
          key: previous.key.replace(functionNamePattern, `function ${event.toName}(`),
        });
      }
      continue;
    }
    latestLive.delete(event.value.identity);
    latestLive.set(event.value.identity, {
      file,
      line: lineAt(content, event.value.offset),
      key: event.key,
    });
  }
}
const canonicalFunctions = new Set<string>();
for (const file of files.filter(
  (file) => file.startsWith(paths.canonical) && file.endsWith(".sql"),
)) {
  const content = read(file);
  for (const [key, value] of functions(content)) {
    canonicalFunctions.add(value.identity);
    const migration = latest.get(key);
    const matchesMigration =
      migration !== undefined &&
      migration.definition.replace(/\s+/g, " ") === value.definition.replace(/\s+/g, " ");
    if (!matchesMigration) {
      add(
        "migration-mismatch",
        file,
        lineAt(content, value.offset),
        `${key} vs ${migration?.file ?? "missing migration"}`,
      );
    }
    // The generated baseline is a fixed snapshot; its unchanged function UUIDs are legacy data.
    if (migration && matchesMigration && baselineMigrationFiles.has(migration.file)) continue;
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
for (const [identity, migration] of latestLive)
  if (!canonicalFunctions.has(identity))
    add("migration-orphan", migration.file, migration.line, migration.key);
for (const file of files.filter(
  (file) => file.startsWith(paths.migrations) && file.endsWith(".sql"),
)) {
  if (baselineMigrationFiles.has(file)) continue;
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
const mainBaseline = spawnSync("git", ["show", `${mainRef}:tooling/guard/baseline.json`], {
  cwd: root,
  encoding: "utf8",
});
if (mainBaseline.status !== 0)
  throw new Error(`Cannot read blocking baseline from ${mainRefLabel}: ${mainBaseline.stderr}`);
const allowed = new Set(
  (JSON.parse(mainBaseline.stdout) as string[]).filter((id) => isBlocking(id.split("|")[0])),
);
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
  const previous = spawnSync("git", ["show", `${mainRef}:${file}`], {
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
    ["ls-tree", "-r", "--name-only", mainRef, "--", paths.applicationSources],
    { cwd: root, encoding: "utf8" },
  );
  if (listing.status !== 0)
    throw new Error(`Cannot list ${mainRefLabel} application definitions: ${listing.stderr}`);
  for (const file of listing.stdout
    .split("\n")
    .filter((entry) => /\/application\.json$/.test(entry))) {
    const content = sourceFromMain(file);
    if (content === undefined)
      throw new Error(`Cannot read ${mainRefLabel} application definition: ${file}`);
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
    ["ls-tree", "-r", "--name-only", mainRef, "--", paths.migrations],
    { cwd: root, encoding: "utf8" },
  );
  if (listing.status !== 0)
    throw new Error(`Cannot list ${mainRefLabel} migrations: ${listing.stderr}`);
  mainLatestFunctions = new Map();
  for (const file of listing.stdout
    .split("\n")
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    const content = sourceFromMain(file);
    if (content === undefined) throw new Error(`Cannot read ${mainRefLabel} migration: ${file}`);
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
  const last = id.lastIndexOf("|");
  const occurrence = Number(id.slice(last + 1));
  const first = id.indexOf("|");
  const second = id.indexOf("|", first + 1);
  if (first < 0 || second < 0 || !Number.isInteger(occurrence) || occurrence < 1) return false;
  const rule = id.slice(0, first);
  const detail = id.slice(second + 1, last);
  return mainFindingCount(rule, sourceFile, detail) >= occurrence;
}
function mainBaselineEntry(id: string): { id: string; sourceFile: string } | undefined {
  const first = id.indexOf("|");
  const second = id.indexOf("|", first + 1);
  if (first < 0 || second < 0) return undefined;
  const file = id.slice(first + 1, second);
  for (const path of pathsForFile(file)) {
    const candidate = `${id.slice(0, first + 1)}${path}${id.slice(second)}`;
    if (!allowed.has(candidate)) continue;
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
  const baselineEntry = mainBaselineEntry(finding.id);
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
    ["diff", "--quiet", mainRef, "--", ".", ":(exclude)tooling/guard"],
    { cwd: root },
  );
  if (diff.status !== 0)
    throw new Error(`--refresh-from-main requires a tree identical to ${mainRefLabel}`);
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
