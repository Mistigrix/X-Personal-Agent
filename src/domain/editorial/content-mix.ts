/**
 * Compares the configured content mix with the categories of recent drafts, so
 * idea generation can favour under-represented categories.
 */

const UNDER_REPRESENTED_MARGIN = 0.1;

export function describeContentMix(
  targets: Readonly<Record<string, number>>,
  recentCategories: readonly string[],
): string {
  const totalWeight = Object.values(targets).reduce((sum, weight) => sum + weight, 0);
  const counts = new Map<string, number>();
  for (const category of recentCategories) counts.set(category, (counts.get(category) ?? 0) + 1);

  const lines = Object.entries(targets)
    .filter(([, weight]) => weight > 0)
    .map(([category, weight]) => {
      const target = weight / totalWeight;
      const recent =
        recentCategories.length > 0 ? (counts.get(category) ?? 0) / recentCategories.length : 0;
      const under =
        recent < target - UNDER_REPRESENTED_MARGIN || (recentCategories.length > 0 && recent === 0);
      const percent = (value: number) => `${Math.round(value * 100)}%`;
      return `- ${category}: target ${percent(target)}, recent ${percent(recent)}${under ? ' (under-represented)' : ''}`;
    });
  return [
    `Use exactly one of these categories for each idea: ${Object.keys(targets)
      .filter((key) => (targets[key] ?? 0) > 0)
      .join(', ')}.`,
    ...lines,
  ].join('\n');
}
