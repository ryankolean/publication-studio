/**
 * Draft content for a package -- design doc section 7.2, "description draft"
 * and "credits block".
 *
 * These are starting points a human edits, not finished copy. They state only
 * what the intake recorded; nothing here embellishes, because an editor can
 * tell the difference and the design's own diagnosis of a rejected submission
 * was a generic angle.
 */

export interface CreditRow {
  role: string;
  businessName: string;
  website: string | null;
  instagram: string | null;
}

export interface DescriptionSource {
  coupleNames: string;
  eventDate: string;
  venueName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  coupleStory: string | null;
  uniqueAngle: string | null;
}

const text = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Publications ask for complete vendor credits, and order is curated rather
 * than alphabetical, so the given order is preserved.
 */
export function buildCreditsBlock(credits: CreditRow[]): string {
  return credits
    .filter((credit) => text(credit.businessName) !== null)
    .map((credit) => {
      const parts = [`- ${credit.role.trim()}: ${credit.businessName.trim()}`];
      const website = text(credit.website);
      const instagram = text(credit.instagram);
      if (website !== null) parts.push(website);
      if (instagram !== null) parts.push(`@${instagram.replace(/^@/, "")}`);
      return parts.join(" — ");
    })
    .join("\n");
}

function placePhrase(source: DescriptionSource): string {
  const venue = text(source.venueName);
  const city = text(source.city);
  const region = text(source.state) ?? text(source.country);

  const locality = [city, region].filter((part) => part !== null).join(", ");

  const segments: string[] = [];
  if (venue !== null) segments.push(`at ${venue}`);
  if (locality.length > 0) segments.push(`in ${locality}`);

  return segments.join(" ");
}

export function buildDescriptionDraft(source: DescriptionSource): string {
  const place = placePhrase(source);
  const opening =
    place.length > 0
      ? `${source.coupleNames} were married on ${source.eventDate} ${place}.`
      : `${source.coupleNames} were married on ${source.eventDate}.`;

  const paragraphs = [opening, text(source.coupleStory), text(source.uniqueAngle)];

  return paragraphs.filter((part) => part !== null).join("\n\n");
}
