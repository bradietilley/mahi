import type { Dialect, SchemaGrammar } from "../dialect.js";
import { mysqlGrammar } from "./mysql-grammar.js";
import { postgresGrammar } from "./postgres-grammar.js";
import { sqliteGrammar } from "./sqlite-grammar.js";

const GRAMMARS: Record<Dialect, SchemaGrammar> = {
  sqlite: sqliteGrammar,
  mysql: mysqlGrammar,
  postgres: postgresGrammar,
};

/** Resolve the schema grammar for a dialect. */
export function grammarFor(dialect: Dialect): SchemaGrammar {
  const grammar = GRAMMARS[dialect];

  if (!grammar) {
    throw new Error(`No schema grammar registered for dialect "${dialect}".`);
  }

  return grammar;
}

export { sqliteGrammar, mysqlGrammar, postgresGrammar };
