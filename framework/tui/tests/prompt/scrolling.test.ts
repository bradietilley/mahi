import { describe, expect, it } from "vitest";
import { Scrolling, scrollPosition } from "../../src/prompt/scrolling.js";

describe("prompt/scrolling Scrolling", () => {
  it("keeps firstVisible at 0 while the highlighted index is within the initial viewport", () => {
    const s = new Scrolling(5, 0);
    s.highlight(3);
    expect(s.firstVisible).toBe(0);
  });

  it("scrolls the viewport down when highlighting past the visible window", () => {
    const s = new Scrolling(3, 0);
    s.highlight(5);
    expect(s.firstVisible).toBe(3); // 5 - 3 + 1
  });

  it("scrolls the viewport up when highlighting before firstVisible", () => {
    const s = new Scrolling(3, 5);
    s.firstVisible = 5;
    s.highlight(1);
    expect(s.firstVisible).toBe(1);
  });

  it("wraps highlightNext from the last item back to the first", () => {
    const s = new Scrolling(5, 2);
    s.highlightNext(3);
    expect(s.highlighted).toBe(0);
  });

  it("wraps highlightPrevious from the first item to the last", () => {
    const s = new Scrolling(5, 0);
    s.highlightPrevious(3);
    expect(s.highlighted).toBe(2);
  });

  it("advances highlightNext normally when not at the last item", () => {
    const s = new Scrolling(5, 0);
    s.highlightNext(3);
    expect(s.highlighted).toBe(1);
  });

  it("moves highlightPrevious normally when not at the first item", () => {
    const s = new Scrolling(5, 2);
    s.highlightPrevious(3);
    expect(s.highlighted).toBe(1);
  });

  it("does nothing when total is 0", () => {
    const s = new Scrolling(5, 0);
    s.highlightNext(0);
    expect(s.highlighted).toBe(0);
  });
});

describe("prompt/scrolling scrollPosition", () => {
  it("returns 0 when firstVisible is 0", () => {
    expect(scrollPosition(0, 5, 20)).toBe(0);
  });

  it("returns height - 1 when firstVisible is at the max scroll position", () => {
    // total=20, height=5 -> maxPosition=15
    expect(scrollPosition(15, 5, 20)).toBe(4);
  });

  it("returns -1 when height <= 2 and not at the top/bottom edge", () => {
    expect(scrollPosition(1, 2, 10)).toBe(-1);
  });

  it("computes a proportional position for a middle scroll offset", () => {
    // total=20, height=5, maxPosition=15, firstVisible=7 -> percent ~0.4667
    // round(0.4667 * (5-3)) + 1 = round(0.933) + 1 = 1 + 1 = 2
    expect(scrollPosition(7, 5, 20)).toBe(2);
  });

  it("computes several (total, scroll, firstVisible) triples consistently", () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 5, 20, 0],
      [15, 5, 20, 4],
      [3, 5, 20, 1],
    ];

    for (const [firstVisible, height, total, expected] of cases) {
      expect(scrollPosition(firstVisible, height, total)).toBe(expected);
    }
  });
});
