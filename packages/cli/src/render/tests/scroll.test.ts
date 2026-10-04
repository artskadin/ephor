import { describe, expect, it } from "vitest";
import { Scroll } from "../scroll";

const names = (count: number) =>
  Array.from({ length: count }, (_, index) => `node-${index}`);

/** Ten nodes of two lines each, room for four. */
const TEN = { names: names(10), heights: Array(10).fill(2), budget: 8 };

describe("Scroll", () => {
  it("starts at the top with as many nodes as fit", () => {
    expect(new Scroll().viewport(TEN)).toEqual({ first: 0, count: 4 });
  });

  it("stays pinned to the top while new nodes sort in above", () => {
    const scroll = new Scroll();
    scroll.viewport(TEN);

    const reordered = { ...TEN, names: ["new", ...TEN.names.slice(0, 9)] };
    expect(scroll.viewport(reordered).first).toBe(0);
  });

  // Scrolled to node-3, the fleet reorders: node-3 stays the first drawn.
  it("follows the top node by name through a reorder", () => {
    const scroll = new Scroll();
    scroll.move("down", TEN);
    scroll.move("down", TEN);
    scroll.move("down", TEN);

    const reordered = { ...TEN, names: [...TEN.names].reverse() };
    const { first } = scroll.viewport(reordered);
    expect(reordered.names[first]).toBe("node-3");
  });

  // node-1 on top, node-0 recovers and sorts below: node-1 is the top now,
  // and a critical that sorts in above must show.
  it("follows the top again once its node has sorted up to it", () => {
    const scroll = new Scroll();
    scroll.move("down", TEN);

    const recovered = {
      ...TEN,
      names: ["node-1", ...TEN.names.filter((name) => name !== "node-1")],
    };
    expect(scroll.viewport(recovered).first).toBe(0);

    const worse = { ...TEN, names: ["new", ...recovered.names.slice(0, 9)] };
    expect(scroll.viewport(worse).first).toBe(0);
  });

  it("keeps the place when the top node is gone", () => {
    const scroll = new Scroll();
    scroll.move("down", TEN);
    scroll.move("down", TEN);

    const without = {
      ...TEN,
      names: TEN.names.filter((name) => name !== "node-2"),
      heights: Array(9).fill(2),
    };
    expect(scroll.viewport(without).first).toBe(2);
  });

  it("never leaves the last page part empty", () => {
    const scroll = new Scroll();
    scroll.move("end", TEN);
    expect(scroll.viewport(TEN)).toEqual({ first: 6, count: 4 });

    scroll.move("down", TEN);
    expect(scroll.viewport(TEN)).toEqual({ first: 6, count: 4 });

    // The fleet shrinks under a scrolled view: it slides back to fill.
    const shorter = { ...TEN, names: names(7), heights: Array(7).fill(2) };
    expect(scroll.viewport(shorter)).toEqual({ first: 3, count: 4 });
  });

  it("pages by what fits, both ways, and stops at the ends", () => {
    const scroll = new Scroll();
    scroll.move("pageDown", TEN);
    expect(scroll.viewport(TEN).first).toBe(4);
    scroll.move("pageDown", TEN);
    expect(scroll.viewport(TEN).first).toBe(6);
    scroll.move("pageUp", TEN);
    expect(scroll.viewport(TEN).first).toBe(2);
    scroll.move("pageUp", TEN);
    scroll.move("up", TEN);
    expect(scroll.viewport(TEN).first).toBe(0);
  });

  it("goes back to following the top once it is there", () => {
    const scroll = new Scroll();
    scroll.move("down", TEN);
    scroll.move("top", TEN);

    const reordered = { ...TEN, names: [...TEN.names].reverse() };
    expect(scroll.viewport(reordered).first).toBe(0);
  });

  it("draws a node taller than the window on its own, cut", () => {
    const tall = { names: names(3), heights: [2, 20, 2], budget: 8 };
    const scroll = new Scroll();

    scroll.move("down", tall);
    expect(scroll.viewport(tall)).toEqual({ first: 1, count: 1 });
    scroll.move("down", tall);
    expect(scroll.viewport(tall)).toEqual({ first: 2, count: 1 });
  });

  it("draws nothing for no nodes, and moves nowhere", () => {
    const empty = { names: [], heights: [], budget: 8 };
    const scroll = new Scroll();

    scroll.move("end", empty);
    expect(scroll.viewport(empty)).toEqual({ first: 0, count: 0 });
  });
});
