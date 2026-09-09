import { describe, expect, it } from "vitest";
import {
  ForeignKeyConstraintViolationException,
  LostConnectionException,
  NotNullConstraintViolationException,
  QueryException,
  UniqueConstraintViolationException,
  translateDatabaseError,
} from "../src/exceptions.js";

/**
 * The classification logic is pure — it inspects a raw driver error's
 * message/code and picks the matching exception class. These cases use the
 * shapes each real driver produces (sqlite messages, mysql `errno`/`code`,
 * postgres SQLSTATE `code`) so the mapping is verified without a live DB.
 */
describe("translateDatabaseError", () => {
  it("maps sqlite unique/not-null/foreign-key messages", () => {
    expect(
      translateDatabaseError("sqlite", new Error("UNIQUE constraint failed: users.email")),
    ).toBeInstanceOf(UniqueConstraintViolationException);
    expect(
      translateDatabaseError("sqlite", new Error("NOT NULL constraint failed: users.name")),
    ).toBeInstanceOf(NotNullConstraintViolationException);
    expect(
      translateDatabaseError("sqlite", new Error("FOREIGN KEY constraint failed")),
    ).toBeInstanceOf(ForeignKeyConstraintViolationException);
  });

  it("maps mysql error codes", () => {
    expect(
      translateDatabaseError(
        "mysql",
        Object.assign(new Error("Duplicate entry"), { code: "1062" }),
      ),
    ).toBeInstanceOf(UniqueConstraintViolationException);
    expect(
      translateDatabaseError("mysql", Object.assign(new Error("bad null"), { errno: 1048 })),
    ).toBeInstanceOf(NotNullConstraintViolationException);
    expect(
      translateDatabaseError(
        "mysql",
        Object.assign(new Error("a foreign key constraint fails"), { errno: 1452 }),
      ),
    ).toBeInstanceOf(ForeignKeyConstraintViolationException);
    expect(
      translateDatabaseError("mysql", Object.assign(new Error("gone"), { code: "2006" })),
    ).toBeInstanceOf(LostConnectionException);
  });

  it("maps postgres SQLSTATE codes", () => {
    expect(
      translateDatabaseError("postgres", Object.assign(new Error("dupe"), { code: "23505" })),
    ).toBeInstanceOf(UniqueConstraintViolationException);
    expect(
      translateDatabaseError("postgres", Object.assign(new Error("null"), { code: "23502" })),
    ).toBeInstanceOf(NotNullConstraintViolationException);
    expect(
      translateDatabaseError("postgres", Object.assign(new Error("fk"), { code: "23503" })),
    ).toBeInstanceOf(ForeignKeyConstraintViolationException);
    expect(
      translateDatabaseError("postgres", Object.assign(new Error("shutdown"), { code: "57P01" })),
    ).toBeInstanceOf(LostConnectionException);
  });

  it("falls back to a generic QueryException for unknown errors", () => {
    const translated = translateDatabaseError("postgres", new Error("something odd"), {
      sql: "SELECT 1",
      bindings: [],
    });
    expect(translated).toBeInstanceOf(QueryException);
    expect(translated).not.toBeInstanceOf(UniqueConstraintViolationException);
    expect(translated.sql).toBe("SELECT 1");
  });

  it("is idempotent — already-translated errors pass through unchanged", () => {
    const first = translateDatabaseError("sqlite", new Error("UNIQUE constraint failed: t.c"));
    const second = translateDatabaseError("sqlite", first);
    expect(second).toBe(first);
  });

  it("preserves the original error as the cause", () => {
    const original = new Error("UNIQUE constraint failed: t.c");
    const translated = translateDatabaseError("sqlite", original);
    expect((translated as { cause?: unknown }).cause).toBe(original);
    expect(translated.previous).toBe(original);
  });
});
