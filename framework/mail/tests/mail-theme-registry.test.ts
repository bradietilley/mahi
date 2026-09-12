import { describe, expect, it } from "vitest";
import { Application } from "@mahiframework/core";
import { MailManager, type MailConfig } from "../src/mail-manager.js";
import { DefaultMailTheme } from "../src/messages/default-mail-theme.js";
import { MailException } from "../src/mail-exception.js";
import type { MailMessageData } from "../src/messages/blocks.js";
import type { MailTheme, RenderedBody } from "../src/messages/mail-theme.js";

class StubTheme implements MailTheme {
  constructor(public readonly settings: Record<string, unknown>) {}

  render(_data: MailMessageData): RenderedBody {
    return { html: "", text: "" };
  }
}

function buildManager(config: Partial<MailConfig> = {}): MailManager {
  const app = new Application();
  const manager = new MailManager(app, { default: "array", mailers: {}, ...config });
  manager.extendTheme("default", (settings) => new DefaultMailTheme(settings));

  return manager;
}

describe("MailManager theme registry", () => {
  it("resolves the built-in default theme", () => {
    expect(buildManager().theme()).toBeInstanceOf(DefaultMailTheme);
  });

  it("caches a resolved theme", () => {
    const manager = buildManager();

    expect(manager.theme("default")).toBe(manager.theme("default"));
  });

  it("invalidates the cache when a name is re-registered", () => {
    const manager = buildManager();
    const first = manager.theme("default");

    manager.extendTheme("default", (settings) => new StubTheme(settings));

    expect(manager.theme("default")).not.toBe(first);
    expect(manager.theme("default")).toBeInstanceOf(StubTheme);
  });

  it("hands each theme its own config slice", () => {
    const manager = buildManager({
      themes: { alternative: { productName: "Alt", primaryColor: "#000" } },
    });
    manager.extendTheme("alternative", (settings) => new StubTheme(settings));

    expect((manager.theme("alternative") as StubTheme).settings).toEqual({
      productName: "Alt",
      primaryColor: "#000",
    });
  });

  it("gives a config-only theme the built-in renderer with those settings", async () => {
    const manager = buildManager({ themes: { alternative: { productName: "Alt" } } });
    const theme = manager.theme("alternative");

    expect(theme).toBeInstanceOf(DefaultMailTheme);

    const rendered = await theme.render({ level: "info", blocks: [], footer: [] });
    expect(rendered.text).toContain("Regards,\nAlt");
  });

  it("keeps a config-only theme distinct from the default one", () => {
    const manager = buildManager({
      themes: { default: { productName: "Main" }, alternative: { productName: "Alt" } },
    });

    expect(manager.theme("default")).not.toBe(manager.theme("alternative"));
  });

  it("throws on an unknown theme rather than silently falling back", () => {
    const manager = buildManager();

    expect(() => manager.theme("nope")).toThrow(MailException);
    expect(() => manager.theme("nope")).toThrow(/is not registered/);
  });
});
