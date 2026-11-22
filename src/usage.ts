type Usage = { count: number; lastOpened: number };
type QueryUsage = Usage & { query: string };
type PathUsage = Usage & { path: string; queries: QueryUsage[] };

export type UsageHistory = PathUsage[];
export const visibleResultLimit = 60;
export const rankingPoolLimit = 180;

const day = 24 * 60 * 60 * 1000;
const historyLimit = 250;
const queryLimit = 5;

function queryKey(query: string) {
  return query.trim().normalize("NFC").toLowerCase().slice(0, 160);
}

function opened(previous: Usage | undefined, now: number): Usage {
  return { count: (previous?.count ?? 0) + 1, lastOpened: now };
}

export function trackOpen(history: UsageHistory, path: string, query: string, now: number): UsageHistory {
  const previous = history.find((entry) => entry.path === path);
  let queries = previous?.queries ?? [];
  const key = queryKey(query);
  if (key) {
    const match = queries.find((item) => item.query === key);
    queries = [
      { query: key, ...opened(match, now) },
      ...queries.filter((item) => item.query !== key),
    ].slice(0, queryLimit);
  }

  return [
    { path, ...opened(previous, now), queries },
    ...history.filter((item) => item.path !== path),
  ].slice(0, historyLimit);
}

function recency(usage: Usage, now: number) {
  const daysAgo = Math.max(0, now - usage.lastOpened) / day;
  return 1 / (1 + daysAgo / 7);
}

export function rankMatches(paths: string[], history: UsageHistory, query: string, now: number) {
  const key = queryKey(query);
  if (!key || !history.length) return paths.slice(0, visibleResultLimit);
  const lookup = new Map(history.map((entry) => [entry.path, entry]));

  return paths
    .map((path, index) => {
      const usage = lookup.get(path);
      if (!usage) return { path, index, score: -index, queryScore: 0 };

      const match = usage.queries.find((entry) => entry.query === key);
      // Frequency has a diminishing effect so recent selections can change the order.
      const queryScore = match ? Math.log2(1 + match.count) + recency(match, now) : 0;
      const boost = Math.min(10, Math.log2(1 + usage.count) * 2 + recency(usage, now) * 3);
      return { path, index, score: boost - index, queryScore };
    })
    .sort((a, b) => b.queryScore - a.queryScore || b.score - a.score || a.index - b.index)
    .slice(0, visibleResultLimit)
    .map(({ path }) => path);
}
