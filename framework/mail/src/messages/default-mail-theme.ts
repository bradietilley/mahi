import { escapeHtml } from "../escape-html.js";
import type { MailBlock, MailMessageData, MessageLevel } from "./blocks.js";
import type { MailTheme, MailThemeConfig, RenderedBody } from "./mail-theme.js";

const DEFAULT_COLORS: Record<MessageLevel, string> = {
  info: "#2d3748",
  success: "#2f855a",
  error: "#c53030",
};

/**
 * The bundled theme: a single-column, inline-styled, table-based layout
 * that renders acceptably in Outlook, Gmail and Apple Mail.
 *
 * Written as template literals rather than as a template file on disk for
 * two reasons. It keeps the package free of any template engine or asset
 * pipeline (a `.html` file would need a loader, and a bundled app has no
 * filesystem to read it from — the same constraint that forced
 * `QueueServiceProvider`'s migrations to be static imports). And it makes
 * the theme SUBCLASSABLE: every piece of markup is a small protected
 * method, so an app that wants a different button but the same layout
 * overrides `button()` and inherits everything else, which no template
 * file would allow without copying the whole thing.
 *
 * The markup is deliberately dated — tables, inline styles, no flexbox,
 * no `<style>` block, no web fonts, no external images. Email clients are
 * not browsers; Outlook still renders through Word's HTML engine, and
 * Gmail strips `<style>` in some contexts. This is the subset that works.
 *
 * Every interpolation of caller-supplied text goes through `escapeHtml()`,
 * without exception. `MailMessageData` is raw by contract, and a message
 * body routinely contains user-controlled data (a display name, a comment
 * being quoted in a `panel()`), so an unescaped hole here is a live XSS
 * vector in every webmail client that renders the message.
 */
export class DefaultMailTheme implements MailTheme {
  constructor(protected config: MailThemeConfig = {}) {}

  render(data: MailMessageData): RenderedBody {
    return { html: this.renderHtml(data), text: this.renderText(data) };
  }

  /** The accent colour for a level, overridable via config. */
  protected color(level: MessageLevel): string {
    const configured =
      level === "success"
        ? this.config.successColor
        : level === "error"
          ? this.config.errorColor
          : this.config.primaryColor;

    return configured ?? DEFAULT_COLORS[level];
  }

  protected productName(data: MailMessageData): string | undefined {
    return data.productName ?? this.config.productName;
  }

  protected renderHtml(data: MailMessageData): string {
    const parts: string[] = [];
    const greeting = data.greeting ?? this.defaultGreeting(data);

    if (greeting !== undefined) {
      parts.push(this.greeting(greeting, data.level));
    }

    for (const block of data.blocks) {
      parts.push(this.block(block));
    }

    const salutation = data.salutation ?? this.defaultSalutation();

    if (salutation !== undefined) {
      parts.push(this.salutation(salutation));
    }

    if (data.footer.length > 0) {
      parts.push(this.footer(data.footer));
    }

    return this.layout(parts.join("\n"), data);
  }

  protected block(block: MailBlock): string {
    switch (block.type) {
      case "line":
        return this.line(block.text);
      case "button":
        return this.button(block.label, block.url, block.level);
      case "panel":
        return this.panel(block.text);
      case "table":
        return this.table(block.header, block.rows);
    }
  }

  protected defaultGreeting(data: MailMessageData): string | undefined {
    return data.level === "error" ? "Whoops!" : "Hello!";
  }

  protected defaultSalutation(): string | undefined {
    const product = this.config.productName;

    return product === undefined ? "Regards," : `Regards,\n${product}`;
  }

  protected greeting(text: string, level: MessageLevel): string {
    return `<h1 style="color:${this.color(level)};font-size:20px;font-weight:600;margin:0 0 18px;">${escapeHtml(text)}</h1>`;
  }

  protected line(text: string): string {
    return `<p style="color:#3d4852;font-size:16px;line-height:1.6;margin:0 0 18px;">${escapeHtml(text)}</p>`;
  }

  /**
   * Buttons are a table, not an `<a>` with padding: Outlook ignores
   * padding on inline elements, which collapses a styled anchor into
   * unreadable coloured text. The nested-table "bulletproof button" is the
   * long-standing workaround.
   */
  protected button(label: string, url: string, level: MessageLevel): string {
    const color = this.color(level);
    const href = escapeHtml(url);

    return [
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">`,
      `<tr><td align="center" bgcolor="${color}" style="border-radius:4px;">`,
      `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:4px;">${escapeHtml(label)}</a>`,
      `</td></tr></table>`,
    ].join("");
  }

  protected panel(text: string): string {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td style="background-color:#f7fafc;border-left:4px solid #cbd5e0;padding:14px 18px;color:#3d4852;font-size:15px;line-height:1.6;">${escapeHtml(text)}</td></tr></table>`;
  }

  protected table(header: string[], rows: string[][]): string {
    const parts: string[] = [
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;border-collapse:collapse;">`,
    ];

    if (header.length > 0) {
      const cells = header
        .map(
          (cell) =>
            `<th align="left" style="padding:8px 10px;border-bottom:2px solid #e2e8f0;color:#3d4852;font-size:14px;">${escapeHtml(cell)}</th>`,
        )
        .join("");
      parts.push(`<tr>${cells}</tr>`);
    }

    for (const row of rows) {
      const cells = row
        .map(
          (cell) =>
            `<td style="padding:8px 10px;border-bottom:1px solid #edf2f7;color:#3d4852;font-size:14px;">${escapeHtml(cell)}</td>`,
        )
        .join("");
      parts.push(`<tr>${cells}</tr>`);
    }

    parts.push(`</table>`);

    return parts.join("");
  }

  protected salutation(text: string): string {
    const lines = text
      .split("\n")
      .map((line) => escapeHtml(line))
      .join("<br>");

    return `<p style="color:#3d4852;font-size:16px;line-height:1.6;margin:24px 0 0;">${lines}</p>`;
  }

  protected footer(lines: string[]): string {
    const body = lines
      .map(
        (line) =>
          `<p style="color:#718096;font-size:12px;line-height:1.5;margin:0 0 8px;word-break:break-all;">${escapeHtml(line)}</p>`,
      )
      .join("");

    return `<hr style="border:none;border-top:1px solid #e8e5ef;margin:28px 0 18px;">${body}`;
  }

  /** The outer document. Override to change width, background or branding. */
  protected layout(body: string, data: MailMessageData): string {
    const product = this.productName(data);
    const header =
      product === undefined
        ? ""
        : `<p style="color:#3d4852;font-size:18px;font-weight:700;margin:0 0 24px;">${escapeHtml(product)}</p>`;

    return [
      `<!doctype html>`,
      `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`,
      `<body style="margin:0;padding:0;background-color:#edf2f7;">`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#edf2f7;">`,
      `<tr><td align="center" style="padding:24px 12px;">`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background-color:#ffffff;border-radius:6px;">`,
      `<tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">`,
      header,
      body,
      `</td></tr></table></td></tr></table></body></html>`,
    ].join("\n");
  }

  /**
   * The plain-text half. Not a stripped-tags version of the HTML — it is
   * rendered from the same blocks independently, because the useful text
   * rendering of a button is its label AND its URL, which tag-stripping
   * would lose entirely.
   */
  protected renderText(data: MailMessageData): string {
    const parts: string[] = [];
    const greeting = data.greeting ?? this.defaultGreeting(data);

    if (greeting !== undefined) {
      parts.push(greeting);
    }

    for (const block of data.blocks) {
      switch (block.type) {
        case "line":
          parts.push(block.text);
          break;
        case "button":
          parts.push(`${block.label}: ${block.url}`);
          break;
        case "panel":
          parts.push(
            block.text
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n"),
          );
          break;
        case "table":
          parts.push(this.textTable(block.header, block.rows));
          break;
      }
    }

    const salutation = data.salutation ?? this.defaultSalutation();

    if (salutation !== undefined) {
      parts.push(salutation);
    }

    for (const line of data.footer) {
      parts.push(line);
    }

    return `${parts.join("\n\n")}\n`;
  }

  /** Column-aligned plain-text table. */
  protected textTable(header: string[], rows: string[][]): string {
    const all = header.length > 0 ? [header, ...rows] : rows;
    const widths: number[] = [];

    for (const row of all) {
      row.forEach((cell, index) => {
        widths[index] = Math.max(widths[index] ?? 0, cell.length);
      });
    }

    const format = (row: string[]): string =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd();

    const lines =
      header.length > 0 ? [format(header), widths.map((w) => "-".repeat(w)).join("  ")] : [];

    for (const row of rows) {
      lines.push(format(row));
    }

    return lines.join("\n");
  }
}
