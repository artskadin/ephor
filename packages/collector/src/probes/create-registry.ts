import { CheckHostProvider } from "../reachability/check-host-provider.js";
import { DirectHttpRequester } from "../reachability/direct-http-requester.js";
import { ReachabilityProbe } from "./reachability/reachability-probe.js";
import { ProbeRegistry } from "./registry.js";
import { SystemProbe } from "./system/system-probe.js";

/** One registry for daemon and no-daemon check: the schema comes from it. */
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
      // From the collector until `requestFrom: nodes` exists.
      requesterFor: () => requester,
    }),
  );

  return registry;
}
