import type { Command as CommanderCommand } from "commander";
import { Str } from "@mahi/core";
import { Command } from "../../command.js";
import { scaffold } from "./scaffold.js";

function template(className: string): string {
  return `import { describe, expect, it } from "vitest";

describe("${className}", () => {
  it("works", () => {
    expect(true).toBe(true);
  });
});
`;
}

export class MakeTestCommand extends Command {
  // Writes into the application's source tree; meaningless without one.
  static override devOnly = true;

  signature = "make:test <name>";
  description = "Scaffold a new test file.";

  configure(program: CommanderCommand): void {
    program
      .option("-d, --dir <dir>", "Directory to write into", "tests")
      .option("-f, --force", "Overwrite the file if it already exists");
  }

  async handle(name: string, options: { dir: string; force?: boolean }): Promise<void> {
    await scaffold({
      name,
      dir: options.dir,
      template,
      filename: () => `${Str.kebab(name)}.test.ts`,
      label: "test",
      force: options.force,
    });
  }
}
