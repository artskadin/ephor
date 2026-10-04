/** The nodes drawn: `count` of them from `first`, in the table's order. */
interface Viewport {
  first: number;
  count: number;
}

export type ScrollMove = "down" | "up" | "pageDown" | "pageUp" | "top" | "end";

interface Fleet {
  /** Node names in the table's order. */
  names: readonly string[];
  /** Lines each node takes, in the same order. */
  heights: readonly number[];
  /** Lines the nodes may take in all. */
  budget: number;
}

/**
 * Where `watch` is scrolled, kept outside React: a resize remounts the
 * view, and the place must survive it. Held by the top node's name, not
 * its index, so a refresh that reorders the fleet does not jump.
 */
export class Scroll {
  /** `undefined`: pinned to the top, so new trouble shows at once. */
  private anchor: string | undefined;
  /** Where the anchor was, for when its node is gone. */
  private anchorIndex = 0;

  viewport(fleet: Fleet): Viewport {
    const { names } = fleet;
    if (names.length === 0) return { first: 0, count: 0 };

    let first = 0;
    if (this.anchor !== undefined) {
      const index = names.indexOf(this.anchor);
      first =
        index === -1 ? Math.min(this.anchorIndex, names.length - 1) : index;
      if (index === -1) this.anchor = names[first];
    }

    // Never a part-empty last page: scrolled to the end, the end is full.
    first = Math.min(first, lastPageFirst(fleet));
    this.anchorIndex = first;
    // Sorted up to the top, it is the top: follow it, or new trouble that
    // sorts in above would stay out of sight.
    if (first === 0) this.anchor = undefined;

    return { first, count: countFrom(fleet, first) };
  }

  move(move: ScrollMove, fleet: Fleet): void {
    const { first, count } = this.viewport(fleet);
    const last = lastPageFirst(fleet);

    const target = {
      down: Math.min(first + 1, last),
      up: Math.max(first - 1, 0),
      pageDown: Math.min(first + count, last),
      pageUp: pageBefore(fleet, first),
      top: 0,
      end: last,
    }[move];

    this.anchor = target === 0 ? undefined : fleet.names[target];
    this.anchorIndex = target;
  }
}

/** How many nodes from `first` fit; at least one, cut if it must be. */
function countFrom(fleet: Fleet, first: number): number {
  let used = 0;
  let count = 0;

  for (let index = first; index < fleet.heights.length; index += 1) {
    used += fleet.heights[index] ?? 0;
    if (used > fleet.budget && count > 0) break;
    count += 1;
    if (used >= fleet.budget) break;
  }

  return count;
}

/** The first node of the page that ends with the last node. */
function lastPageFirst(fleet: Fleet): number {
  let used = 0;
  let first = fleet.heights.length;

  while (first > 0) {
    used += fleet.heights[first - 1] ?? 0;
    if (used > fleet.budget && first < fleet.heights.length) break;
    first -= 1;
  }

  return first;
}

/** The first node of the page that ends just above `first`. */
function pageBefore(fleet: Fleet, first: number): number {
  let used = 0;
  let start = first;

  while (start > 0) {
    used += fleet.heights[start - 1] ?? 0;
    if (used > fleet.budget && start < first) break;
    start -= 1;
  }

  return start;
}
