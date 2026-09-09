import type { MailMessageData } from "./blocks.js";

/**
 * A rendered message body — both halves, produced together.
 *
 * Both are produced in one call rather than by two separate theme methods
 * because a theme almost always derives them from the same walk over the
 * blocks, and because producing only one is a common mistake: an HTML-only
 * transactional email is penalised by spam filters and unreadable in
 * text-only clients.
 */
export interface RenderedBody {
  html: string;
  text: string;
}

/**
 * Turns a `MailMessageData` into an HTML and plain-text body.
 *
 * A theme is an OBJECT, not a template file, and that is the deliberate
 * departure from Laravel's `mail.markdown.theme` (a CSS file applied to
 * Blade components). This package ships no template engine and does not
 * want one (see `Content`'s docblock) — so rather than inventing a
 * miniature one just for `MailMessage`, the extension point is an
 * interface. A theme may be:
 *
 *   - Template literals in TypeScript, with no dependencies at all — this
 *     is what `DefaultMailTheme` is, and it is entirely readable.
 *   - A wrapper around whatever engine the app already uses: react-email,
 *     mjml, handlebars, a `.html` file with token replacement.
 *   - A subclass of `DefaultMailTheme` overriding one method to change a
 *     colour or the button markup.
 *
 * All three plug in identically and the authoring API (`MailMessage`) is
 * unchanged by the choice, which is the whole point: swapping how mail
 * looks must never mean rewriting the code that decides what it says.
 *
 * ## Escaping is the theme's responsibility
 *
 * `MailMessageData` carries raw, unescaped text. A theme MUST escape it
 * when interpolating into HTML (`escapeHtml()` is exported for this) and
 * MUST NOT escape it in the text half. This is delegated rather than done
 * upfront because escaping depends on the output format, and pre-escaping
 * would corrupt the plain-text body.
 */
export interface MailTheme {
  render(data: MailMessageData): RenderedBody | Promise<RenderedBody>;
}

/**
 * Optional per-theme settings read from `mail.themes.<name>` and handed to
 * the theme factory. Themes are free to define their own additional keys;
 * these are the ones the bundled theme understands.
 */
export interface MailThemeConfig {
  /** Brand name shown in the header/footer. */
  productName?: string;
  /** Primary button/accent colour for `level: "info"`. */
  primaryColor?: string;
  /** Accent colour for `level: "success"`. */
  successColor?: string;
  /** Accent colour for `level: "error"`. */
  errorColor?: string;
  [key: string]: unknown;
}
