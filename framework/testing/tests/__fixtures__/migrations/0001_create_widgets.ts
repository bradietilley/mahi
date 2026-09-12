import { Schema, type Migration, type Blueprint } from "@mahiframework/database";

const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("widgets", (table: Blueprint) => {
      table.string("id").primary();
      table.string("name");
    });
  },

  async down(): Promise<void> {
    await Schema.drop("widgets");
  },
};

export default migration;
