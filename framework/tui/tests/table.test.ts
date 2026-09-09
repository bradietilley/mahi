import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/ansi/strip.js";
import { renderTable, writeTable } from "../src/table.js";
import { BufferedOutput } from "../src/output/buffered-output.js";

describe("table renderTable", () => {
  it("renders a table with headers, a divider, and rows", () => {
    const table = renderTable(
      ["Name", "Email"],
      [
        ["Ada", "ada@example.com"],
        ["Grace", "grace@example.com"],
      ],
    );
    const lines = stripAnsi(table).split("\n");
    expect(lines).toHaveLength(6); // top border, header, divider, 2 rows, bottom border
    expect(lines[0]!.startsWith(" ┌")).toBe(true);
    expect(lines[1]).toContain("Name");
    expect(lines[1]).toContain("Email");
    expect(lines[2]!.startsWith(" ├")).toBe(true);
    expect(lines[3]).toContain("Ada");
    expect(lines[4]).toContain("Grace");
    expect(lines[5]!.startsWith(" └")).toBe(true);
  });

  it("skips the header row and divider when headers is empty", () => {
    const table = renderTable([], [["a", "b"]]);
    const lines = stripAnsi(table).split("\n");
    expect(lines).toHaveLength(3); // top border, 1 row, bottom border
    expect(lines.some((l) => l.includes("├"))).toBe(false);
  });

  it("sizes each column to the widest cell in that column, including the header", () => {
    const table = renderTable(["ID"], [["1"], ["a-very-long-value"]]);
    const lines = stripAnsi(table).split("\n");
    // every data row and the header row should have the same total width
    const dataLineLengths = new Set(lines.filter((l) => l.includes("│")).map((l) => l.length));
    expect(dataLineLengths.size).toBe(1);
  });

  it("pads short cells to match the widest cell in their column", () => {
    const table = renderTable(["Name"], [["Ada"], ["Bo"]]);
    const lines = stripAnsi(table).split("\n");
    const rowLines = lines.filter((l) => l.includes("Ada") || l.includes("Bo"));
    expect(rowLines[0]!.length).toBe(rowLines[1]!.length);
  });

  it("handles a single column table", () => {
    const table = renderTable(["Only"], [["value"]]);
    const lines = stripAnsi(table).split("\n");
    expect(lines[0]!.match(/┬/g)).toBeNull();
  });

  it("handles rows with a value wider than the header", () => {
    const table = renderTable(["ID"], [["a-much-wider-value"]]);
    const lines = stripAnsi(table).split("\n");
    expect(lines[1]).toContain("ID");
    expect(lines[3]).toContain("a-much-wider-value");
  });

  it("renders an empty rows array with just headers, top border, divider, and bottom border", () => {
    const table = renderTable(["Name"], []);
    const lines = stripAnsi(table).split("\n");
    expect(lines).toHaveLength(4);
  });
});

describe("table writeTable", () => {
  it("writes the rendered table through the finished-frame spacing rule", () => {
    const output = new BufferedOutput();
    writeTable(output, ["A"], [["1"]]);
    expect(output.output().startsWith("\n\n")).toBe(true);
    expect(output.output().endsWith("\n")).toBe(true);
  });
});
