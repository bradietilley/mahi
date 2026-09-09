import type { Dialect } from "../schema/dialect.js";
import type { QueryGrammar } from "./grammar.js";
import { mysqlQueryGrammar } from "./mysql-query-grammar.js";
import { postgresQueryGrammar } from "./postgres-query-grammar.js";
import { sqliteQueryGrammar } from "./sqlite-query-grammar.js";

const GRAMMARS: Record<Dialect, QueryGrammar> = {
  sqlite: sqliteQueryGrammar,
  mysql: mysqlQueryGrammar,
  postgres: postgresQueryGrammar,
};

/** Resolve the query grammar for a dialect — the query-layer twin of `grammarFor()`. */
export function queryGrammarFor(dialect: Dialect): QueryGrammar {
  const grammar = GRAMMARS[dialect];

  if (!grammar) {
    throw new Error(`No query grammar registered for dialect "${dialect}".`);
  }

  return grammar;
}

export type { QueryGrammar, DatePart, JsonColumn, GrammarBinding } from "./grammar.js";
export { sqliteQueryGrammar, mysqlQueryGrammar, postgresQueryGrammar };
