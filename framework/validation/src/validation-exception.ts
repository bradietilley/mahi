export class ValidationException extends Error {
  readonly status = 422;

  constructor(public readonly errors: Record<string, string[]>) {
    super("Validation failed");
    this.name = "ValidationException";
  }
}
