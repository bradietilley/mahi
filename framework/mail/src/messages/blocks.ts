/**
 * The intermediate representation a `MailMessage` accumulates and a
 * `MailTheme` renders.
 *
 * This is the one piece of the mail package that has an opinion about what
 * an email *contains* rather than how it is addressed or delivered. The
 * opinion is deliberately small: a transactional email is a greeting, a
 * few paragraphs, at most one call to action, and a sign-off. Anything
 * outside that shape is a hand-written `Mailable` with its own renderer,
 * which remains fully supported and is not second-class.
 *
 * Blocks are a discriminated union of PLAIN DATA — no strings of HTML, no
 * functions, no class instances. That is what makes a theme swappable: a
 * theme receives a description of the message, never a half-rendered
 * fragment it would have to parse or patch. It also means a `MailMessage`
 * can be inspected in a test (`message.data().blocks`) without rendering
 * anything, and asserted against structurally rather than by string-
 * matching generated HTML.
 *
 * All text is UNESCAPED at this layer. Escaping is the theme's job,
 * because only the theme knows which output it is producing — the same
 * `line` needs `&amp;` in HTML and a bare `&` in text. A theme that
 * forgets to escape produces an injection bug, so `DefaultMailTheme`
 * routes every interpolation through `escapeHtml()` and any custom theme
 * must do the same.
 */

/** A paragraph of body copy. */
export interface LineBlock {
  type: "line";
  text: string;
}

/**
 * A call-to-action button. `level` lets a theme colour destructive or
 * celebratory actions differently without the caller writing any CSS;
 * it defaults to the message's own level.
 */
export interface ButtonBlock {
  type: "button";
  label: string;
  url: string;
  level: MessageLevel;
}

/**
 * A visually set-apart block — Laravel's `MailMessage::panel()`. Typically
 * rendered as an indented/tinted box. Useful for quoting the thing the
 * email is about (an order summary, a comment being replied to).
 */
export interface PanelBlock {
  type: "panel";
  text: string;
}

/**
 * A simple data table. `header` may be empty for a headerless table.
 * Rows are rendered as-is; no alignment, spanning or per-cell formatting
 * — reach for a hand-written `Mailable` when a message needs real layout.
 */
export interface TableBlock {
  type: "table";
  header: string[];
  rows: string[][];
}

export type MailBlock = LineBlock | ButtonBlock | PanelBlock | TableBlock;

/**
 * The overall tone of a message. Themes map this to colour: `info` is the
 * neutral default, `success` for confirmations, `error` for failures and
 * security alerts. It also supplies the default `level` for a `button()`
 * that doesn't specify its own, so an error message's action button is
 * styled consistently without repeating the level.
 */
export type MessageLevel = "info" | "success" | "error";

/**
 * The complete, theme-agnostic description of a message body.
 *
 * `greeting` and `salutation` are separate from `blocks` rather than being
 * blocks themselves because a theme positions them structurally (a
 * greeting is never in the middle) and may want to supply its own default
 * for a message that omits them.
 */
export interface MailMessageData {
  level: MessageLevel;
  /** Opening line ("Hi Ada,"). A theme supplies a default when omitted. */
  greeting?: string;
  /** Closing line ("Regards,\nThe Acme Team"). Theme default when omitted. */
  salutation?: string;
  blocks: MailBlock[];
  /**
   * Trailing fine print, rendered below the salutation in a de-emphasised
   * style — the "if you're having trouble clicking the button, paste this
   * URL" footnote, or an unsubscribe note.
   */
  footer: string[];
  /**
   * Product/application name available to the theme for branding. Set from
   * `mail.themes.<name>.productName`, or the theme's own default.
   */
  productName?: string;
}
