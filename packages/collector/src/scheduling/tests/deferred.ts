/** A promise settled from outside: how a test holds a task mid-run. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;

  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}
