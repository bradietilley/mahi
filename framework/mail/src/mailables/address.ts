/**
 * A single email address, optionally with a display name, the atomic
 * value object every recipient/sender field is built from. Mirrors
 * Laravel's `Illuminate\Mail\Mailables\Address` (`{ address, name }`),
 * minus PHP-object ceremony.
 *
 * Kept as a plain interface (not a class) because it carries no behavior:
 * it is pure data flowing from an `Envelope` into a `RenderedMail` and out
 * to a transport. `formatAddress()` handles the one bit of logic, turning
 * it into an RFC-5322 `"Name <addr>"` header string, as a free function
 * so transports and the log/array drivers can share it.
 */
export interface Address {
  address: string;
  name?: string;
}

/**
 * Render an `Address` as an RFC-5322 header value: `"Name <addr>"` when a
 * display name is present, otherwise the bare `addr`. Display names
 * containing characters that must be quoted (commas, `<`, `>`, `"`) are
 * wrapped in double quotes with any embedded quotes/backslashes escaped.
 */
export function formatAddress({ address, name }: Address): string {
  if (!name) {
    return address;
  }

  if (/[,<>"@]/.test(name)) {
    const escaped = name.replace(/(["\\])/g, "\\$1");

    return `"${escaped}" <${address}>`;
  }

  return `${name} <${address}>`;
}

/** Render a list of addresses as a comma-joined header value. */
export function formatAddressList(addresses: Address[]): string {
  return addresses.map(formatAddress).join(", ");
}
