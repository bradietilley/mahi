export type BodyRenderer = () => string | Promise<string>;

export interface ContentOptions {
  html?: BodyRenderer | string;
  text?: BodyRenderer | string;
}

/**
 * The body half of a message: an HTML renderer, a text renderer, or both.
 *
 * Each is stored as a thunk (`() => string | Promise<string>`) rather than
 * an eager string so that rendering, which may be async (reading a
 * template file, awaiting an app-chosen template engine), happens lazily
 * inside `Mailable.render()`, not when the `Mailable` is constructed. This
 * is the deliberate departure from Laravel's Blade-`view`-name approach:
 * there is no bundled component/template system, the app supplies whatever
 * produces the final string (HTML-escape untrusted interpolations with
 * `escapeHtml()`).
 *
 * Two ways to produce one, mirroring `Envelope`:
 *   - Fluent: `Mailable`'s `view()/html()/text()` setters mutate the
 *     instance the base `Mailable` holds.
 *   - Declarative: a `Mailable` overrides `content()` and returns
 *     `new Content({ html: () => renderWelcome(user) })` in one shot.
 *
 * The constructor accepts either a thunk or a plain string for each body
 * (a string is wrapped into a constant thunk), so declarative overrides
 * stay terse whether the body is precomputed or lazily rendered.
 */
export class Content {
  html?: BodyRenderer;
  text?: BodyRenderer;

  constructor(options: ContentOptions = {}) {
    if (options.html !== undefined) {
      this.html = toRenderer(options.html);
    }

    if (options.text !== undefined) {
      this.text = toRenderer(options.text);
    }
  }
}

function toRenderer(value: BodyRenderer | string): BodyRenderer {
  return typeof value === "string" ? () => value : value;
}
