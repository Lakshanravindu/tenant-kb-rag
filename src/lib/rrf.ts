/** Standard RRF constant from Cormack et al. (2009). */
export const DEFAULT_RRF_K = 60;

export interface FusedResult<T> {
  item: T;
  score: number;
  /** 1-based rank of the item in each input list, or null if it wasn't there. */
  ranks: (number | null)[];
}

/**
 * Reciprocal Rank Fusion.
 *
 *   score(d) = Σ_i 1 / (k + rank_i(d))
 *
 * Only ranks are used, never the raw scores, so lists with incomparable scales
 * (cosine distance vs ts_rank) can be merged without normalisation.
 *
 * - Ranks are 1-based.
 * - If an id appears twice in the same list, only its first (best) rank counts.
 * - Ties are broken by the best individual rank, then by id, so the output is
 *   deterministic.
 * - The item object returned is the first one seen for that id.
 */
export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  getId: (item: T) => string,
  k: number = DEFAULT_RRF_K,
): FusedResult<T>[] {
  if (!Number.isFinite(k) || k < 0) {
    throw new RangeError(`RRF k must be a non-negative number, got ${k}`);
  }

  const fused = new Map<string, FusedResult<T>>();

  lists.forEach((list, listIndex) => {
    list.forEach((item, position) => {
      const id = getId(item);
      let entry = fused.get(id);
      if (!entry) {
        entry = { item, score: 0, ranks: lists.map(() => null) };
        fused.set(id, entry);
      }
      if (entry.ranks[listIndex] !== null) return; // duplicate within one list

      const rank = position + 1;
      entry.ranks[listIndex] = rank;
      entry.score += 1 / (k + rank);
    });
  });

  const bestRank = (r: FusedResult<T>) =>
    Math.min(...r.ranks.map((x) => x ?? Number.POSITIVE_INFINITY));

  return [...fused.entries()]
    .sort(([idA, a], [idB, b]) => {
      if (b.score !== a.score) return b.score - a.score;
      const rankDiff = bestRank(a) - bestRank(b);
      if (rankDiff !== 0) return rankDiff;
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    })
    .map(([, entry]) => entry);
}
