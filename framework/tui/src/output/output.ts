/**
 * Output abstraction — port of `laravel/prompts`' `Output/ConsoleOutput.php`
 * trailing-newline tracking, needed for the "always exactly 2 blank
 * lines between prompts" spacing rule. `writeDirectly` is for raw
 * cursor-movement/erase escape codes that shouldn't count toward the
 * trailing-newline bookkeeping (they don't emit visible lines).
 */
export interface Output {
  write(text: string): void;
  writeDirectly(text: string): void;
  newLinesWritten(): number;
}

function countTrailingNewlines(text: string): number {
  const match = /\n*$/.exec(text);

  return match ? match[0].length : 0;
}

export class NodeOutput implements Output {
  private trailingNewLines = 0;

  write(text: string): void {
    process.stdout.write(text);
    this.trailingNewLines = countTrailingNewlines(text);
  }

  writeDirectly(text: string): void {
    process.stdout.write(text);
  }

  newLinesWritten(): number {
    return this.trailingNewLines;
  }
}
