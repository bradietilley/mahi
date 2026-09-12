import type { ChannelRegistry } from "./channel-registry.js";

declare module "@mahiframework/core" {
  interface ProviderHooks {
    /**
     * Declare channel-authorization callbacks for `private-`/`presence-`
     * channels. Collected by `BroadcastServiceProvider` from every
     * provider during its own `boot()`, exactly like `@mahiframework/http`
     * collects `routes()`.
     *
     *   channels(broadcast: ChannelRegistry): void {
     *     broadcast.channel("orders.{orderId}", (user, orderId) => …);
     *   }
     */
    channels?(broadcast: ChannelRegistry): void;
  }
}
