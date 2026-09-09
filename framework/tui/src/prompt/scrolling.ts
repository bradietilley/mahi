/**
 * Viewport math for `select()`'s option list — port of `Concerns/
 * Scrolling.php`: `firstVisible` offset tracking, `highlight(index)`
 * (keep-in-viewport snap logic), `highlightNext`/`highlightPrevious`
 * (wraparound). Reusable by a future `multiselect`/`search`.
 */
export class Scrolling {
  highlighted: number | null;
  firstVisible = 0;

  constructor(
    public readonly scroll: number,
    initialHighlighted: number | null = 0,
  ) {
    this.highlighted = initialHighlighted;
  }

  highlight(index: number | null): void {
    this.highlighted = index;

    if (this.highlighted === null) {
      return;
    }

    if (this.highlighted < this.firstVisible) {
      this.firstVisible = this.highlighted;
    } else if (this.highlighted > this.firstVisible + this.scroll - 1) {
      this.firstVisible = this.highlighted - this.scroll + 1;
    }
  }

  highlightPrevious(total: number, allowNull = false): void {
    if (total === 0) {
      return;
    }

    if (this.highlighted === null) {
      this.highlight(total - 1);
    } else if (this.highlighted === 0) {
      this.highlight(allowNull ? null : total - 1);
    } else {
      this.highlight(this.highlighted - 1);
    }
  }

  highlightNext(total: number, allowNull = false): void {
    if (total === 0) {
      return;
    }

    if (this.highlighted === total - 1) {
      this.highlight(allowNull ? null : 0);
    } else {
      this.highlight((this.highlighted ?? -1) + 1);
    }
  }

  /** Centers the highlighted option in the viewport — used to seed a select's initial scroll position around a `default`. */
  scrollToHighlighted(total: number): void {
    if (this.highlighted === null || this.highlighted < this.scroll) {
      return;
    }

    const remaining = total - this.highlighted - 1;
    const halfScroll = Math.floor(this.scroll / 2);
    let endOffset = Math.max(0, halfScroll - remaining);

    if (this.scroll % 2 === 0) {
      endOffset--;
    }

    this.firstVisible = this.highlighted - halfScroll - endOffset;
  }
}

/**
 * Returns the row index (within the visible window) where the
 * scrollbar "handle" should be rendered — port of `DrawsScrollbars::
 * scrollPosition()`.
 */
export function scrollPosition(firstVisible: number, height: number, total: number): number {
  if (firstVisible === 0) {
    return 0;
  }

  const maxPosition = total - height;

  if (firstVisible === maxPosition) {
    return height - 1;
  }

  if (height <= 2) {
    return -1;
  }

  const percent = firstVisible / maxPosition;

  return Math.round(percent * (height - 3)) + 1;
}
