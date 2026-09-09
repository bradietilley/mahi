import { describe, expect, it } from "vitest";
import { ArrayTransport } from "../src/transports/array-transport.js";
import { Mailable } from "../src/mailable.js";

class WelcomeMailable extends Mailable {
  build(): void {
    this.subject("Welcome")
      .from("sys@example.com")
      .to("ada@example.com")
      .cc("cc@example.com")
      .html("<p>Hi</p>");
  }
}

describe("ArrayTransport", () => {
  it("captures sent messages in order", async () => {
    const transport = new ArrayTransport();
    await transport.send(await new WelcomeMailable().render());

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]?.subject).toBe("Welcome");
  });

  it("reports every recipient as accepted", async () => {
    const transport = new ArrayTransport();
    const sent = await transport.send(await new WelcomeMailable().render());

    expect(sent.accepted).toEqual(["ada@example.com", "cc@example.com"]);
    expect(sent.rejected).toEqual([]);
    expect(sent.messageId).toBe("array-1");
  });

  it("flush() clears captured messages", async () => {
    const transport = new ArrayTransport();
    await transport.send(await new WelcomeMailable().render());
    transport.flush();
    expect(transport.messages).toHaveLength(0);
  });
});
