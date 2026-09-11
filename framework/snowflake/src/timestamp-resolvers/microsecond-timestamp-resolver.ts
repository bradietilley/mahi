import { epochMicrosecondsNow } from "../epoch-microseconds.js";
import type { TimestampResolver } from "./timestamp-resolver.js";

/**
 * Microsecond-precision wall clock, the default timestamp source.
 * Preferring microseconds over milliseconds (traditional Snowflake /
 * ULID) makes sequentially enumerable IDs much harder to guess when
 * several IDs are generated in the same second.
 */
export class MicrosecondTimestampResolver implements TimestampResolver {
  timestamp(): number {
    return epochMicrosecondsNow();
  }
}
