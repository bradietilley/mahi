import { Snowflake } from "../snowflake.js";
import type { IdentifierResolver } from "./identifier-resolver.js";

/**
 * Packs `[ timestamp | cluster | worker | sequence ]` into a 63-bit
 * integer. The `$group` argument is ignored. Grouping is a testing
 * concern handled by `SequentialIdentifierResolver`.
 */
export class SnowflakeIdentifierResolver implements IdentifierResolver {
  identifier(time: number, sequence: number, _group?: string | null): bigint {
    const workerIdLeftShift = Snowflake.sequenceBits();
    const datacenterIdLeftShift = Snowflake.workerIdBits() + Snowflake.sequenceBits();
    const timestampLeftShift = Snowflake.ID_BITS - Snowflake.TIMESTAMP_BITS;

    return (
      (BigInt(time) << BigInt(timestampLeftShift)) |
      (BigInt(Snowflake.cluster) << BigInt(datacenterIdLeftShift)) |
      (BigInt(Snowflake.worker) << BigInt(workerIdLeftShift)) |
      BigInt(sequence)
    );
  }
}
