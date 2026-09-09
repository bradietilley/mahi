import { describe, expect, it } from "vitest";
import { formatAddress, formatAddressList } from "../src/mailables/address.js";

describe("formatAddress", () => {
  it("returns the bare address when no name is present", () => {
    expect(formatAddress({ address: "a@example.com" })).toBe("a@example.com");
  });

  it('formats a name + address as "Name <addr>"', () => {
    expect(formatAddress({ address: "a@example.com", name: "Ada" })).toBe("Ada <a@example.com>");
  });

  it("quotes and escapes names containing special characters", () => {
    expect(formatAddress({ address: "a@example.com", name: "Lovelace, Ada" })).toBe(
      '"Lovelace, Ada" <a@example.com>',
    );
    expect(formatAddress({ address: "a@example.com", name: 'A "B"' })).toBe(
      '"A \\"B\\"" <a@example.com>',
    );
  });
});

describe("formatAddressList", () => {
  it("comma-joins formatted addresses", () => {
    expect(
      formatAddressList([{ address: "a@example.com", name: "Ada" }, { address: "b@example.com" }]),
    ).toBe("Ada <a@example.com>, b@example.com");
  });
});
