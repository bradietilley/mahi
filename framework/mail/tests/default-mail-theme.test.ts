import { describe, expect, it } from "vitest";
import { DefaultMailTheme } from "../src/messages/default-mail-theme.js";
import type { MailMessageData } from "../src/messages/blocks.js";

function data(overrides: Partial<MailMessageData> = {}): MailMessageData {
  return { level: "info", blocks: [], footer: [], ...overrides };
}

describe("DefaultMailTheme escaping", () => {
  it("escapes line text in the html half", () => {
    const { html } = new DefaultMailTheme().render(
      data({ blocks: [{ type: "line", text: `<script>alert("xss")</script>` }] }),
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a button's label and url", () => {
    const { html } = new DefaultMailTheme().render(
      data({
        blocks: [
          {
            type: "button",
            label: `<b>Click</b>`,
            url: `https://example.com/"onmouseover="alert(1)`,
            level: "info",
          },
        ],
      }),
    );

    expect(html).toContain("&lt;b&gt;Click&lt;/b&gt;");
    expect(html).not.toContain(`"onmouseover="alert(1)`);
  });

  it("escapes panel, table and greeting text", () => {
    const { html } = new DefaultMailTheme().render(
      data({
        greeting: "<i>Hi</i>",
        blocks: [
          { type: "panel", text: "<em>quoted</em>" },
          { type: "table", header: ["<th>"], rows: [["<td>"]] },
        ],
      }),
    );

    expect(html).not.toMatch(/<i>|<em>/);
    expect(html).toContain("&lt;i&gt;Hi&lt;/i&gt;");
    expect(html).toContain("&lt;em&gt;quoted&lt;/em&gt;");
    expect(html).toContain("&lt;th&gt;");
    expect(html).toContain("&lt;td&gt;");
  });

  it("does NOT escape the text half", () => {
    const { text } = new DefaultMailTheme().render(
      data({ blocks: [{ type: "line", text: "Tom & Jerry <3" }] }),
    );

    expect(text).toContain("Tom & Jerry <3");
    expect(text).not.toContain("&amp;");
  });
});

describe("DefaultMailTheme text rendering", () => {
  it("renders a button as label plus url, which tag-stripping would lose", () => {
    const { text } = new DefaultMailTheme().render(
      data({
        blocks: [{ type: "button", label: "Reset", url: "https://example.com/r", level: "info" }],
      }),
    );

    expect(text).toContain("Reset: https://example.com/r");
  });

  it("quotes a panel", () => {
    const { text } = new DefaultMailTheme().render(
      data({ blocks: [{ type: "panel", text: "line one\nline two" }] }),
    );

    expect(text).toContain("> line one\n> line two");
  });

  it("column-aligns a table", () => {
    const { text } = new DefaultMailTheme().render(
      data({
        blocks: [
          {
            type: "table",
            header: ["Item", "Qty"],
            rows: [
              ["Widget", "2"],
              ["Thingamabob", "10"],
            ],
          },
        ],
      }),
    );

    expect(text).toContain("Item         Qty");
    expect(text).toContain("Widget       2");
    expect(text).toContain("Thingamabob  10");
  });
});

describe("DefaultMailTheme defaults and config", () => {
  it('greets with "Hello!" by default and "Whoops!" on an error', () => {
    expect(new DefaultMailTheme().render(data()).text).toContain("Hello!");
    expect(new DefaultMailTheme().render(data({ level: "error" })).text).toContain("Whoops!");
  });

  it("lets an explicit greeting win", () => {
    const { text } = new DefaultMailTheme().render(data({ greeting: "Hi Ada," }));

    expect(text).toContain("Hi Ada,");
    expect(text).not.toContain("Hello!");
  });

  it("brands the salutation and header with the configured product name", () => {
    const theme = new DefaultMailTheme({ productName: "Acme" });
    const { html, text } = theme.render(data({ blocks: [{ type: "line", text: "body" }] }));

    expect(text).toContain("Regards,\nAcme");
    expect(html).toContain("Acme");
  });

  it("applies configured level colours", () => {
    const theme = new DefaultMailTheme({ primaryColor: "#7c3aed" });
    const { html } = theme.render(
      data({ blocks: [{ type: "button", label: "Go", url: "https://x.test", level: "info" }] }),
    );

    expect(html).toContain("#7c3aed");
  });

  it("renders footer lines after the salutation", () => {
    const { text } = new DefaultMailTheme().render(
      data({ blocks: [{ type: "line", text: "body" }], footer: ["https://example.com/raw"] }),
    );

    expect(text.indexOf("https://example.com/raw")).toBeGreaterThan(text.indexOf("Regards,"));
  });
});
