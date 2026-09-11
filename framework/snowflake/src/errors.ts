/**
 * Every error this package throws descends from `SnowflakeException`, so
 * callers can catch the whole family with one `instanceof` check without
 * also swallowing unrelated `TypeError`s.
 */
export class SnowflakeException extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
