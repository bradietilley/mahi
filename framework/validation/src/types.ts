export type Presence = "required" | "optional" | "nullable" | "nullish";

export type ValueType = "string" | "numeric" | "integer" | "boolean" | "array" | "file" | "object";

export type InferRule<R> =
  R extends Rule<infer T, infer P>
    ? P extends "optional"
      ? T | undefined
      : P extends "nullable"
        ? T | null
        : P extends "nullish"
          ? T | null | undefined
          : T
    : never;

export type InferRules<T> = { [K in keyof T]: InferRule<T[K]> };

export interface PresenceResolver {
  exists(table: string, column: string, value: unknown): Promise<boolean>;
  unique(
    table: string,
    column: string,
    value: unknown,
    ignore?: { column: string; id: unknown },
  ): Promise<boolean>;
}

export type ModelLike = { table: string; primaryKeyColumn?: string };

export type RuleStep = {
  name: string;
  params?: Record<string, unknown>;
  message?: string;
  itemRule?: Rule<any, any>;
  objectShape?: Record<string, Rule<any, any>>;
  custom?: import("./validation-rule.js").ValidationRule;
};

// Imported as a type-only cycle breaker for InferRule; Rule is the runtime class.
import type { Rule } from "./rule.js";
