/**
 * `probes:` with each of these switched on, as a user writes them, for a
 * test about something else; a section the test wrote wins.
 */
export function withProbesOn(
  config: Readonly<Record<string, unknown>>,
  probeNames: readonly string[],
): Record<string, unknown> {
  const written = (config.probes ?? {}) as Record<string, unknown>;
  const sections = Object.fromEntries(probeNames.map((name) => [name, {}]));
  return { ...config, probes: { ...sections, ...written } };
}
