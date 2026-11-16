import { DEFAULT_RRF_K, reciprocalRankFusion } from '../src/lib/rrf';

type Doc = { id: string };
const d = (...ids: string[]): Doc[] => ids.map((id) => ({ id }));
const byId = (x: Doc) => x.id;
const ids = (results: { item: Doc }[]) => results.map((r) => r.item.id);

describe('reciprocalRankFusion', () => {
  it('uses k = 60 by default', () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });

  it('scores a single list as 1 / (k + rank) with 1-based ranks', () => {
    const [first, second, third] = reciprocalRankFusion([d('a', 'b', 'c')], byId);

    expect(first!.score).toBeCloseTo(1 / 61, 12);
    expect(second!.score).toBeCloseTo(1 / 62, 12);
    expect(third!.score).toBeCloseTo(1 / 63, 12);
  });

  it('sums contributions for an item found by both retrievers', () => {
    const vector = d('a', 'b', 'c');
    const keyword = d('c', 'a');

    const result = reciprocalRankFusion([vector, keyword], byId);
    const a = result.find((r) => r.item.id === 'a')!;
    const c = result.find((r) => r.item.id === 'c')!;

    expect(a.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(c.score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(a.ranks).toEqual([1, 2]);
    expect(c.ranks).toEqual([3, 1]);
  });

  it('ranks agreement between lists above a single top hit', () => {
    // 'x' is #1 for vector only; 'y' is #2 in both lists.
    const vector = d('x', 'y', 'z');
    const keyword = d('w', 'y', 'v');

    const result = reciprocalRankFusion([vector, keyword], byId);

    expect(result[0]!.item.id).toBe('y');
    expect(result[0]!.score).toBeCloseTo(2 / 62, 12);
  });

  it('produces the expected full ordering for a mixed example', () => {
    const vector = d('a', 'b', 'c', 'd');
    const keyword = d('d', 'c', 'e');

    // a: 1/61            = 0.016393
    // b: 1/62            = 0.016129
    // c: 1/63 + 1/62     = 0.032002
    // d: 1/64 + 1/61     = 0.032018
    // e: 1/63            = 0.015873
    expect(ids(reciprocalRankFusion([vector, keyword], byId))).toEqual(['d', 'c', 'a', 'b', 'e']);
  });

  it('respects a custom k', () => {
    const [top] = reciprocalRankFusion([d('a')], byId, 0);
    expect(top!.score).toBe(1);

    // Smaller k gives the top ranks more weight: with k = 0, being #1 in one
    // list beats being #3 in both (1 > 1/3 + 1/3).
    const vector = d('solo', 'x', 'both');
    const keyword = d('y', 'z', 'both');
    expect(reciprocalRankFusion([vector, keyword], byId, 0)[0]!.item.id).toBe('solo');
    expect(reciprocalRankFusion([vector, keyword], byId, 60)[0]!.item.id).toBe('both');
  });

  it('counts an id only once per list (first occurrence wins)', () => {
    const [a] = reciprocalRankFusion([d('a', 'b', 'a')], byId);
    expect(a!.item.id).toBe('a');
    expect(a!.score).toBeCloseTo(1 / 61, 12);
    expect(a!.ranks).toEqual([1]);
  });

  it('marks items missing from a list with a null rank', () => {
    const result = reciprocalRankFusion([d('a'), d('b')], byId);
    expect(result.find((r) => r.item.id === 'a')!.ranks).toEqual([1, null]);
    expect(result.find((r) => r.item.id === 'b')!.ranks).toEqual([null, 1]);
  });

  it('breaks score ties deterministically by id', () => {
    // Both are #1 in exactly one list -> identical score and best rank.
    expect(ids(reciprocalRankFusion([d('m'), d('k')], byId))).toEqual(['k', 'm']);
    expect(ids(reciprocalRankFusion([d('k'), d('m')], byId))).toEqual(['k', 'm']);
  });

  it('keeps the first item object seen for an id', () => {
    const fromVector = { id: 'a', source: 'vector' };
    const fromKeyword = { id: 'a', source: 'keyword' };
    const [top] = reciprocalRankFusion([[fromVector], [fromKeyword]], (x) => x.id);
    expect(top!.item).toBe(fromVector);
  });

  it('handles empty input', () => {
    expect(reciprocalRankFusion([], byId)).toEqual([]);
    expect(reciprocalRankFusion([[], []], byId)).toEqual([]);
  });

  it('rejects an invalid k', () => {
    expect(() => reciprocalRankFusion([d('a')], byId, -1)).toThrow(RangeError);
    expect(() => reciprocalRankFusion([d('a')], byId, Number.NaN)).toThrow(RangeError);
  });
});
