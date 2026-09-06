import { CheckHostProvider } from "../reachability/check-host-provider.js";
import { DirectHttpRequester } from "../reachability/direct-http-requester.js";
import { ReachabilityProbe } from "./reachability/reachability-probe.js";
import { ProbeRegistry } from "./registry.js";
import { SystemProbe } from "./system/system-probe.js";

/**
 * Every probe the collector ships, wired to the real world. One function
 * for the daemon and for a check without one: the config schema is
 * generated from what is registered, so two registries could accept two
 * different configs.
 */
export function createRegistry(): ProbeRegistry {
  const registry = new ProbeRegistry();

  registry.register(new SystemProbe());

  const requester = new DirectHttpRequester();

  registry.register(
    new ReachabilityProbe({
      createProvider: (settings) =>
        new CheckHostProvider({
          regions: settings.regions,
          vantageTtlMs: settings.vantageRefresh * 1000,
        }),
      // Always from the collector for now; `requestFrom: nodes` will make
      // this a choice without the provider noticing.
      requesterFor: () => requester,
    }),
  );

  return registry;
}
