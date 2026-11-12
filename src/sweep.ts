import type { Store } from "./store.ts";

/** Seconds between prunes of what has aged out; see `Store.prune`. */
export const PRUNE_SECONDS = 3600;

/** Prunes every `PRUNE_SECONDS` until the answer is called; a failed tick is logged and the next tried. */
export function startTimers(store: Store, log: (line: string) => void = console.log, now = () => new Date()): () => void {
  const prune = () => {
    try {
      const n = store.prune(now());
      if (n) log(JSON.stringify({ pruned: n }));
    } catch (err) {
      log(JSON.stringify({ pruned: "failed", error: (err as Error).message }));
    }
  };
  prune();
  const pruning = setInterval(prune, PRUNE_SECONDS * 1000);
  pruning.unref();
  return () => clearInterval(pruning);
}
