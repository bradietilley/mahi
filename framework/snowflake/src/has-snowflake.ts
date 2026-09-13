import { app } from "@mahiframework/core";
import type { KeyStrategy, KeyStrategyContext } from "@mahiframework/database";
import { SnowflakeGenerator } from "./snowflake-generator.js";
import { SNOWFLAKE_TOKEN } from "./tokens.js";

/**
 * A `KeyStrategy` that assigns a Snowflake ID on create when the primary
 * key is missing, the redesign replacement for the old `HasSnowflake`
 * `Model.use()` extension. Pass it as a model's `keyType`:
 *
 *   interface WidgetAttributes { id: string; name: string; }
 *
 *   class Widget extends Model<WidgetAttributes>()({
 *     table: "widgets",
 *     primaryKey: "id",
 *     keyType: snowflake(),
 *   }) {}
 *
 *   const row = await Widget.create({ name: "Sprocket" });
 *   row.id; // "9348975348573485734"
 *
 * The key is a 19-digit string, so the column must be a `text` (or
 * `bigint`-as-text) primary key, never an auto-increment integer. An
 * explicit `id` on the insert payload always wins. The per-model sequence
 * group is the model's class name (`context.modelName`), matching the old
 * `newUniqueId()`'s `this.name`.
 */
export function snowflake(): KeyStrategy<string> {
  return {
    type: "string",
    generate(context: KeyStrategyContext): Promise<string> {
      return nextSnowflakeId(context.modelName);
    },
  };
}

async function nextSnowflakeId(group: string): Promise<string> {
  return app().make<SnowflakeGenerator>(SNOWFLAKE_TOKEN).id(group);
}
