import { describe, expect, it } from "vitest";
import { ArrayLogger } from "@mahiframework/core";
import { LogTransport } from "../src/transports/log-transport.js";
import { Mailable } from "../src/mailable.js";

class WelcomeMailable extends Mailable {
  build(): void {
    this.subject("Welcome")
      .from("sys@example.com", "Sys")
      .to("ada@example.com", "Ada")
      .text("Hi Ada");
  }
}

describe("LogTransport", () => {
  it("writes the rendered message through the logger", async () => {
    const logger = new ArrayLogger();
    const transport = new LogTransport(logger);

    const sent = await transport.send(await new WelcomeMailable().render());

    expect(logger.entries).toHaveLength(1);
    const entry = logger.entries[0]!;
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("Mail: Welcome");
    expect(entry.context?.from).toBe("Sys <sys@example.com>");
    expect(entry.context?.to).toBe("Ada <ada@example.com>");
    expect(entry.context?.body).toBe("Hi Ada");
    expect(sent.accepted).toEqual(["ada@example.com"]);
  });
});
