import type { SqlStatementType } from "../../models/types.js";

/**
 * Dialect-specific lexical facts used to blank string literals, quoted
 * identifiers and comments out of SQL. Security decisions (semicolon/type
 * first word) are made only from executable SQL, never from text that merely
 * appears inside a literal — so every quoting and comment style a dialect
 * accepts must be recognized here, or a `;` smuggled inside one of them would
 * be counted as a statement terminator.
 */
export type SkeletonFlags = {
  /** PostgreSQL dollar-quoted bodies (`$$...$$`, `$tag$...$tag$`). */
  dollarQuoted?: boolean;
  /** MySQL backtick identifiers with `` `` `` doubling. */
  backticks?: boolean;
  /** SQL Server `[bracket]` identifiers. */
  brackets?: boolean;
  /** MySQL `#` line comments. */
  hashComments?: boolean;
};

/** Union of every dialect: used for definition-time validation when the data
    source type is not at hand. The per-adapter execution-time validation uses
    the exact flags and is the authoritative security boundary. */
export const SUPERSET_FLAGS: SkeletonFlags = { dollarQuoted: true, backticks: true, brackets: true, hashComments: true };

export function sqlSkeleton(sql: string, flags: SkeletonFlags = {}): string {
  let out = ""; let i = 0;
  const isQuote = (char: string) => char === "'" || char === '"' || (flags.backticks === true && char === "`");
  while (i < sql.length) {
    const char = sql[i]; const next = sql[i + 1];
    if (isQuote(char)) {
      const quote = char; out += " "; i += 1;
      while (i < sql.length) {
        out += " ";
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { out += " "; i += 2; continue; }
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (flags.brackets === true && char === "[") {
      out += " "; i += 1;
      while (i < sql.length) {
        out += " ";
        if (sql[i] === "]") {
          if (sql[i + 1] === "]") { out += " "; i += 2; continue; }
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      out += "  "; i += 2;
      while (i < sql.length && sql[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (flags.hashComments === true && char === "#") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (char === "/" && next === "*") {
      out += "  "; i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) { out += sql[i] === "\n" ? "\n" : " "; i += 1; }
      if (i < sql.length) { out += "  "; i += 2; }
      continue;
    }
    if (flags.dollarQuoted === true && char === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        const tag = match[0]; out += " ".repeat(tag.length); i += tag.length;
        const end = sql.indexOf(tag, i);
        const length = end < 0 ? sql.length - i : end + tag.length - i;
        out += " ".repeat(length); i += length; continue;
      }
    }
    out += char; i += 1;
  }
  return out;
}

export function validateStatement(sql: string, statementType: SqlStatementType, flags: SkeletonFlags): string | undefined {
  if (!sql.trim()) return "sql is required";
  const skeleton = sqlSkeleton(sql, flags);
  const semicolons = [...skeleton.matchAll(/;/g)].map((match) => match.index ?? 0);
  if (semicolons.length > 1 || (semicolons.length === 1 && skeleton.slice(semicolons[0] + 1).trim())) return "only one SQL statement is allowed";
  const executable = skeleton.replace(/;/g, " ").trim();
  if (/\$\d+\b/.test(executable)) return "use {{name}} parameters instead of positional placeholders";
  const first = executable.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (statementType === "query") {
    if (first !== "SELECT" && first !== "WITH") return "query statements must start with SELECT or WITH";
    /* Read-only CTEs are supported; data-modifying CTEs are deliberately not. */
    if (first === "WITH" && /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(executable)) return "query CTEs must be read-only";
  } else if (!["INSERT", "UPDATE", "DELETE"].includes(first ?? "")) {
    return "command statements must start with INSERT, UPDATE or DELETE";
  }
  return undefined;
}
