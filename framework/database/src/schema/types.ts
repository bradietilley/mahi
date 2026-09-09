export type ReferentialAction = "cascade" | "restrict" | "set null" | "set default" | "no action";

export type IndexKind = "index" | "unique" | "primary" | "fullText" | "spatialIndex";

export type BlueprintMode = "create" | "alter";

export interface IndexCommand {
  kind: IndexKind;
  columns: string[];
  name?: string;
}

export function asColumnList(columns: string | string[]): string[] {
  return Array.isArray(columns) ? columns : [columns];
}

/** Infer `users` from `user_id` (Laravel's foreignId()->constrained() convention, naive plural). */
export function inferTableFromForeignId(column: string): string {
  const base = column.endsWith("_id") ? column.slice(0, -3) : column;

  return base.endsWith("s") ? base : `${base}s`;
}
