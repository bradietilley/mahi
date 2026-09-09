import { MailException } from "./mail-exception.js";
import type { Address } from "./mailables/address.js";

/**
 * Header-injection guard. Email header fields are CRLF-delimited, so a
 * `\r`/`\n` (or a bare `\n`) smuggled into an address, display name,
 * subject, tag or metadata key/value can inject arbitrary extra headers
 * (`Bcc:`, `Content-Type:`, a whole second message body). nodemailer
 * strips these for its own SMTP output, but `log`/`array` — and any future
 * transport — are otherwise unprotected, so Mahi rejects them at the
 * `Mailable.render()` boundary, before the message reaches any transport.
 */
const CR_OR_LF = /[\r\n]/;

/** Throw a `MailException` if `value` contains a CR or LF. */
export function assertNoCrlf(value: string, field: string): string {
  if (CR_OR_LF.test(value)) {
    throw new MailException(
      `Mail ${field} may not contain CR/LF characters (header-injection attempt): ${JSON.stringify(value)}`,
    );
  }

  return value;
}

/** Validate a single address (and its optional display name) for CRLF. */
export function assertAddressClean(address: Address, field: string): Address {
  assertNoCrlf(address.address, `${field} address`);

  if (address.name !== undefined) {
    assertNoCrlf(address.name, `${field} name`);
  }

  return address;
}

/** Validate a list of addresses for CRLF. */
export function assertAddressesClean(addresses: Address[], field: string): Address[] {
  for (const address of addresses) {
    assertAddressClean(address, field);
  }

  return addresses;
}
