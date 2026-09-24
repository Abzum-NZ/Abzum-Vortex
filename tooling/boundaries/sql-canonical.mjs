import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The canonical-function convention applies to migrations created at or after this UTC
// timestamp. Every earlier migration is historical and exempt from the checks below.
export const CANONICAL_SINCE = "20260925000000";

const migrationPattern = /^(\d{14})_.*\.sql$/;
const identifierPattern = /^[a-z_][a-z0-9_]*$/;
const definitionSource = String.raw`^create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(`;
const dollarQuoteSource = String.raw`\$[A-Za-z0-9_]*\$`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(block) {
  return block
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .trim();
}

async function listSqlFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listSqlFiles(target)));
    else if (entry.isFile() && entry.name.endsWith(".sql")) files.push(target);
  }
  return files;
}

function extractArgumentList(text, openParen) {
  let depth = 0;
  for (let index = openParen; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return normalize(text.slice(openParen + 1, index)).replace(/\s+/g, " ");
      }
    }
  }
  return null;
}

// Reads every top-level `create [or replace] function <schema>.<name>(...)` statement, including
// the dollar-quoted body up to and including its terminating semicolon.
export function extractDefinitions(text) {
  const header = new RegExp(definitionSource, "gim");
  const definitions = [];
  let match;
  while ((match = header.exec(text)) !== null) {
    const start = match.index;
    const openParen = header.lastIndex - 1;
    const quote = new RegExp(dollarQuoteSource, "g");
    quote.lastIndex = openParen;
    const opener = quote.exec(text);
    if (!opener) continue;
    const tag = opener[0];
    const closer = new RegExp(escapeRegExp(tag), "g");
    closer.lastIndex = opener.index + tag.length;
    const closing = closer.exec(text);
    if (!closing) continue;
    let end = closing.index + tag.length;
    const terminator = text.indexOf(";", end);
    if (terminator !== -1) end = terminator + 1;
    definitions.push({
      schema: match[1].toLowerCase(),
      name: match[2].toLowerCase(),
      arguments: extractArgumentList(text, openParen),
      block: normalize(text.slice(start, end)),
    });
    header.lastIndex = end;
  }
  return definitions;
}

function functionKey(schema, name) {
  return `${schema}.${name}`;
}

export async function validateSqlCanonical(root) {
  const errors = [];
  const migrationsDirectory = path.join(root, "supabase", "migrations");
  const schemasDirectory = path.join(root, "supabase", "schemas");

  const migrations = [];
  for (const file of await listSqlFiles(migrationsDirectory)) {
    const relative = path.relative(root, file);
    const match = migrationPattern.exec(path.basename(file));
    if (!match) {
      errors.push(`${relative} does not start with a 14-digit timestamp`);
      continue;
    }
    const text = await readFile(file, "utf8");
    migrations.push({
      file: relative,
      timestamp: match[1],
      text,
      definitions: extractDefinitions(text),
    });
  }

  const canonicals = [];
  const canonicalByKey = new Map();
  for (const file of await listSqlFiles(schemasDirectory)) {
    const relative = path.relative(root, file);
    const parts = path.relative(schemasDirectory, file).split(path.sep);
    const name = path.basename(file, ".sql");
    const schema = parts.length === 2 ? parts[0] : null;
    if (!schema || !identifierPattern.test(schema) || !identifierPattern.test(name)) {
      errors.push(
        `${relative} must live at supabase/schemas/<schema>/<function>.sql with lowercase SQL identifiers`,
      );
      continue;
    }
    const text = await readFile(file, "utf8");
    const definitions = extractDefinitions(text);
    const item = { file: relative, schema, name, text, definitions, definition: null };
    canonicals.push(item);
    canonicalByKey.set(functionKey(schema, name), item);
  }

  for (const item of canonicals) {
    const key = functionKey(item.schema, item.name);
    if (item.definitions.length === 0) {
      errors.push(
        `${item.file} does not contain a create or replace function ${key}(...) statement`,
      );
      continue;
    }
    if (item.definitions.length > 1) {
      errors.push(
        `${item.file} must hold exactly one function definition, found ${item.definitions.length}`,
      );
      continue;
    }
    item.definition = item.definitions[0];
    if (item.definition.schema !== item.schema || item.definition.name !== item.name) {
      errors.push(
        `${item.file} defines ${functionKey(item.definition.schema, item.definition.name)} but its path names ${key}`,
      );
      item.definition = null;
      continue;
    }
    if (!/create\s+or\s+replace\s+function/i.test(item.text)) {
      errors.push(`${item.file} must use create or replace function`);
    }
    const commentPattern = new RegExp(
      String.raw`comment\s+on\s+function\s+${escapeRegExp(key)}\s*\(`,
      "i",
    );
    if (!commentPattern.test(item.text)) {
      errors.push(`${item.file} must carry the function's comment on function ${key}`);
    }
    const privilegePattern = new RegExp(
      String.raw`\b(?:grant|revoke)\b[\s\S]*?\bon\s+function\s+${escapeRegExp(key)}\s*\(`,
      "i",
    );
    if (!privilegePattern.test(item.text)) {
      errors.push(`${item.file} must carry the function's grant or revoke on function ${key}`);
    }
  }

  for (const migration of migrations) {
    if (migration.timestamp < CANONICAL_SINCE) continue;
    if (/pg_get_functiondef/i.test(migration.text)) {
      errors.push(
        `${migration.file} reads a live function definition with pg_get_functiondef; carry the complete new body instead`,
      );
    }
    if (
      /replace\s*\(\s*(?:pg_catalog\s*\.\s*)?[a-z_][a-z0-9_]*(?:definition|prosrc|live_body)[a-z0-9_]*\s*,/i.test(
        migration.text,
      )
    ) {
      errors.push(
        `${migration.file} patches a function definition with replace(); carry the complete new body instead`,
      );
    }
    for (const definition of migration.definitions) {
      const key = functionKey(definition.schema, definition.name);
      const item = canonicalByKey.get(key);
      if (!item) {
        errors.push(
          `${migration.file} defines ${key} without a canonical file supabase/schemas/${definition.schema}/${definition.name}.sql`,
        );
        continue;
      }
      if (!item.definition) continue;
      if (definition.block !== item.definition.block) {
        errors.push(
          `${migration.file} defines ${key} with a body that differs from its canonical file ${item.file}`,
        );
      }
      if (definition.arguments !== item.definition.arguments) {
        const dropPattern = new RegExp(
          String.raw`drop\s+function\s+(?:if\s+exists\s+)?${escapeRegExp(key)}\s*\(`,
          "i",
        );
        if (!dropPattern.test(migration.text)) {
          errors.push(
            `${migration.file} changes the signature of ${key} without an explicit drop function`,
          );
        }
      }
    }
  }

  for (const item of canonicals) {
    if (!item.definition) continue;
    const key = functionKey(item.schema, item.name);
    const backed = migrations.some((migration) =>
      migration.definitions.some(
        (definition) =>
          definition.schema === item.schema &&
          definition.name === item.name &&
          definition.block === item.definition.block,
      ),
    );
    if (!backed) {
      errors.push(
        `${item.file} has no migration carrying its complete definition; a canonical change must be accompanied by a migration`,
      );
    }
  }

  return errors;
}
