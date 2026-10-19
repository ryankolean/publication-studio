/**
 * The shared tag vocabulary (SUMMIT-300). Events and publications are tagged
 * from the same list so matching (SUMMIT-303) is a set intersection, not a
 * text comparison. The vocabulary itself lives in the tags table, seeded by
 * migration 0006 and editable in-app later; this module only fixes the
 * category order, which is a display and matching priority, not an alphabet.
 */
export const TAG_CATEGORIES = [
  "region",
  "landscape_venue",
  "architecture",
  "aesthetic",
  "dress_style",
  "season",
] as const;

export type TagCategory = (typeof TAG_CATEGORIES)[number];

/** SQL fragment ordering tags.category by TAG_CATEGORIES. */
export const TAG_CATEGORY_ORDER = `CASE tags.category ${TAG_CATEGORIES.map(
  (category, index) => `WHEN '${category}' THEN ${index}`,
).join(" ")} ELSE ${TAG_CATEGORIES.length} END`;

/** "farm_ranch_countryside" -> "Farm ranch countryside". */
export function tagLabel(id: string): string {
  const words = id.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
