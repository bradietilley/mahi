import { Schema, type Migration, type Blueprint } from "@mahi/database";

const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("users", (table: Blueprint) => {
      table.string("id").primary();
      table.string("email");
      table.string("password");
    });
  },

  async down(): Promise<void> {
    await Schema.drop("users");
  },
};

export default migration;
