export interface SqlSafetyOptions {
  allowWrites?: boolean;
  allowDangerous?: boolean;
  allowMultipleStatements?: boolean;
}

export interface SqlSafetyDecision {
  allowed: boolean;
  reason?: string;
}

const READ_KEYWORDS = new Set(["select", "with", "show", "describe", "desc", "explain"]);
const DANGEROUS_KEYWORDS = new Set(["drop", "truncate", "alter"]);

export function evaluateSqlSafety(sql: string, options: SqlSafetyOptions = {}): SqlSafetyDecision {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return { allowed: false, reason: "SQL is empty." };
  if (statements.length > 1 && !options.allowMultipleStatements) {
    return { allowed: false, reason: "Only one SQL statement is allowed per query." };
  }

  for (let i = 0; i < statements.length; i++) {
    const decision = evaluateSingleSqlStatementSafety(statements[i], options);
    if (!decision.allowed && statements.length > 1) {
      return {
        allowed: false,
        reason: `Statement ${i + 1}: ${decision.reason ?? "SQL blocked."}`,
      };
    }
    if (!decision.allowed) return decision;
  }

  return { allowed: true };
}

function evaluateSingleSqlStatementSafety(sql: string, options: SqlSafetyOptions = {}): SqlSafetyDecision {
  const normalized = stripSqlCommentsAndStrings(sql).trim();
  const firstKeyword = normalized.match(/^[a-zA-Z_]+/)?.[0]?.toLowerCase();
  if (!firstKeyword) return { allowed: false, reason: "SQL statement is not recognized." };

  const tokens: string[] = normalized.toLowerCase().match(/[a-z_]+/g) ?? [];
  const dangerous = tokens.find((token) => DANGEROUS_KEYWORDS.has(token));
  if (dangerous && !options.allowDangerous) {
    return { allowed: false, reason: `Dangerous SQL keyword "${dangerous.toUpperCase()}" is blocked.` };
  }

  if (!options.allowWrites && !READ_KEYWORDS.has(firstKeyword)) {
    return {
      allowed: false,
      reason: "MCP SQL execution is read-only by default. Set DBX_MCP_ALLOW_WRITES=1 to allow write statements.",
    };
  }

  if (options.allowWrites && !options.allowDangerous) {
    if (firstKeyword === "update" && !tokens.includes("where")) {
      return { allowed: false, reason: "UPDATE statements must include a WHERE clause." };
    }
    if (firstKeyword === "delete" && !tokens.includes("where")) {
      return { allowed: false, reason: "DELETE statements must include a WHERE clause." };
    }
  }

  return { allowed: true };
}

export function sqlSafetyFromEnv(env: NodeJS.ProcessEnv = process.env): SqlSafetyOptions {
  return {
    allowWrites: env.DBX_MCP_ALLOW_WRITES === "1" || env.DBX_MCP_ALLOW_WRITES === "true",
    allowDangerous: env.DBX_MCP_ALLOW_DANGEROUS_SQL === "1" || env.DBX_MCP_ALLOW_DANGEROUS_SQL === "true",
  };
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += char;
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "-" && next === "-") inLineComment = true;
    if (char === "/" && next === "*") inBlockComment = true;
    if (char === "'" || char === '"' || char === "`") quote = char;

    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function stripSqlCommentsAndStrings(sql: string): string {
  return sql
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, '""')
    .replace(/`([^`]|``)*`/g, "``");
}
