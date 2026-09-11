import { Schema, type Migration, type Blueprint } from "@mahi/database";

/** A soft-deleting table, for assertSoftDeleted()/assertNotSoftDeleted(). */
const migration: Migration = {
  async up(): Promise<void> {
    await Schema.create("gadgets", (table: Blueprint) => {
      table.string("id").primary();
      table.string("name");
      // Deliberately NOT named `deleted_at` — the assertions must read the
      // column off the model rather than assuming the conventional name.
      table.timestamp("archived_at").nullable();
    });
  },

  async down(): Promise<void> {
    await Schema.drop("gadgets");
  },
};

export default migration;
