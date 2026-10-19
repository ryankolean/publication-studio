/** URL-safe identifiers for weddings. Pure; collision handling belongs to the route. */

const MAX_NAME_LENGTH = 70;

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    // Strip combining marks, so accented letters keep their base letter
    // instead of vanishing.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A wedding's readable identifier: the couple and the year. The year is enough
 * to disambiguate a photographer's inventory in practice; the route still has
 * to handle the exact collision, since slug is UNIQUE.
 */
export function eventSlug(coupleNames: string, eventDate: string): string {
  const names = slugify(coupleNames).slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  const year = /^\d{4}-\d{2}-\d{2}$/.test(eventDate)
    ? eventDate.slice(0, 4)
    : slugify(eventDate);

  if (names.length === 0) return `event-${eventDate}`;
  return year.length === 0 ? names : `${names}-${year}`;
}
