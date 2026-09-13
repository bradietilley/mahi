import type { Output } from "./output.js";

/**
 * In-memory `Output` sink, swapped in by `Tui.fake()` so interactive
 * prompts can run against a fake terminal without touching real
 * `process.stdout`, and so tests can assert on exactly what was
 * rendered.
 */
export class BufferedOutput implements Output {
  private buffer = "";
  private trailingNewLines = 0;

  write(text: string): void {
    this.buffer += text;
    const match = /\n*$/.exec(text);
    this.trailingNewLines = match ? match[0].length : 0;
  }

  writeDirectly(text: string): void {
    this.buffer += text;
  }

  newLinesWritten(): number {
    return this.trailingNewLines;
  }

  output(): string {
    return this.buffer;
  }

  clear(): void {
    this.buffer = "";
    this.trailingNewLines = 0;
  }
}
