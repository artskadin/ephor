import { CheckHostProvider } from "../reachability/check-host-provider";
import { DirectHttpRequester } from "../reachability/direct-http-requester";
import { ReachabilityProbe } from "./reachability/reachability-probe";
import { ProbeRegistry } from "./registry";
import { SystemProbe } from "./system/system-probe";

interface RegistryOptions {
  /** A check with no daemon: each probe runs once and is gone. */
  isSingleRun?: boolean;
}

/** One registry for daemon and no-daemon check: the schema comes from it. */
export function createRegistry(options: RegistryOptions = {}): ProbeRegistry {
  const registry = new ProbeRegistry();

  registry.register(
    new SystemProbe({ readsTwicePerRun: options.isSingleRun ?? false }),
  );

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
