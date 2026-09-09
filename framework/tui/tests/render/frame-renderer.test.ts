import { describe, expect, it } from "vitest";
import { BufferedOutput } from "../../src/output/buffered-output.js";
import { renderFrame } from "../../src/render/frame-renderer.js";

describe("render/frame-renderer renderFrame", () => {
  it("does nothing when the frame is unchanged", () => {
    const output = new BufferedOutput();
    renderFrame(output, "line1\nline2", "line1\nline2", 24);
    expect(output.output()).toBe("");
  });

  it("writes the full frame with no cursor movement on the first render (empty prevFrame)", () => {
    const output = new BufferedOutput();
    renderFrame(output, "", "line1\nline2", 24);
    expect(output.output()).toBe("line1\nline2");
  });

  it("moves to column 1, moves up (previousFrameHeight - 1) lines, erases down, and writes the new frame when the terminal is tall enough", () => {
    const output = new BufferedOutput();
    // prevFrame has 3 lines, terminal has 24 rows -> no drop-from-top,
    // move up (3 - 1) = 2 lines.
    renderFrame(output, "a\nb\nc", "x\ny\nz", 24);
    expect(output.output()).toBe("\x1b[1G\x1b[2A\x1b[Jx\ny\nz");
  });

  it("moves up (terminalLines - 1) lines and drops top lines from the new frame when it's taller than the terminal", () => {
    const output = new BufferedOutput();
    // prevFrame: 2 lines, terminal: 2 rows, new frame: 4 lines.
    // dropFromTop = abs(min(0, 2 - 2)) = 0 -> no drop in this case since
    // previousFrameHeight (2) does not exceed terminalLines (2).
    renderFrame(output, "a\nb", "w\nx\ny\nz", 2);
    expect(output.output()).toBe("\x1b[1G\x1b[1A\x1b[Jw\nx\ny\nz");
  });

  it("drops lines from the top of the new frame when the previous frame was taller than the terminal", () => {
    const output = new BufferedOutput();
    // previousFrameHeight = 5, terminalLines = 3
    // dropFromTop = abs(min(0, 3 - 5)) = 2
    const prevFrame = "1\n2\n3\n4\n5";
    const frame = "a\nb\nc\nd\ne";
    renderFrame(output, prevFrame, frame, 3);
    // min(terminalLines, previousFrameHeight) - 1 = min(3,5) - 1 = 2
    expect(output.output()).toBe("\x1b[1G\x1b[2A\x1b[Jc\nd\ne");
  });

  it("handles a shrinking frame (fewer lines than prevFrame) by still moving up based on previousFrameHeight and erasing down", () => {
    const output = new BufferedOutput();
    // prevFrame: 4 lines, terminal: 24, new frame: 1 line.
    renderFrame(output, "1\n2\n3\n4", "only", 24);
    expect(output.output()).toBe("\x1b[1G\x1b[3A\x1b[Jonly");
  });

  it("computes dropFromTop as 0 whenever terminalLines >= previousFrameHeight, across several (terminalLines, prevHeight) pairs", () => {
    const cases: Array<[number, number]> = [
      [24, 1],
      [24, 24],
      [10, 10],
      [5, 5],
    ];

    for (const [terminalLines, prevHeight] of cases) {
      const output = new BufferedOutput();
      const prevFrame = Array.from({ length: prevHeight }, (_, i) => `p${i}`).join("\n");
      const frame = Array.from({ length: prevHeight }, (_, i) => `n${i}`).join("\n");
      renderFrame(output, prevFrame, frame, terminalLines);
      // No dropped lines -> the full new frame appears in the output.
      expect(output.output().endsWith(frame)).toBe(true);
    }
  });

  it("computes dropFromTop as (prevHeight - terminalLines) whenever previousFrameHeight > terminalLines", () => {
    const cases: Array<[number, number]> = [
      [3, 5],
      [1, 10],
      [2, 4],
    ];

    for (const [terminalLines, prevHeight] of cases) {
      const output = new BufferedOutput();
      const prevFrame = Array.from({ length: prevHeight }, (_, i) => `p${i}`).join("\n");
      const newLines = Array.from({ length: prevHeight }, (_, i) => `n${i}`);
      const frame = newLines.join("\n");
      renderFrame(output, prevFrame, frame, terminalLines);
      const expectedDrop = prevHeight - terminalLines;
      const expectedTail = newLines.slice(expectedDrop).join("\n");
      expect(output.output().endsWith(expectedTail)).toBe(true);

      // And the dropped lines must not appear.
      if (expectedDrop > 0) {
        expect(output.output()).not.toContain(newLines[0]);
      }
    }
  });
});
