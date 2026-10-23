/** The style profile's shapes (SUMMIT-337), as the /style routes send them. */

export type TagState = "suggested" | "confirmed" | "rejected";

export interface LookTag {
  id: string;
  category: string;
  state: TagState;
  /** analysis: Claude; derived: the date or the state; photographer: hers. */
  source: "analysis" | "derived" | "photographer";
  confidence: "high" | "medium" | "low" | null;
  reason: string | null;
}

/** GET /style/events/:id. */
export interface LookBody {
  tags: LookTag[];
  vocabulary: Array<{ id: string; category: string }>;
  photos: { count: number; usable: number };
  analysis: {
    enabled: boolean;
    available: boolean;
    lastRun: { at: string; status: string; photoCount: number } | null;
    /** The last run looked at exactly the photos there are now. */
    current: boolean;
  };
  fresh?: boolean;
}

export interface Feature {
  id: string;
  publicationId: string | null;
  outletName: string;
  eventId: string | null;
  coupleNames: string | null;
  featureUrl: string | null;
  publishedOn: string | null;
  role: "lead" | "second_shooter";
  notes: string | null;
}

/** GET /style/profile. */
export interface ProfileBody {
  analysis: { enabled: boolean; available: boolean };
  tagged: number;
  categories: Array<{ category: string; tags: Array<{ id: string; weddings: number }> }>;
  weddings: Array<{
    id: string;
    coupleNames: string;
    eventDate: string;
    secondShooter: boolean;
    confirmed: number;
    suggested: number;
  }>;
  features: Feature[];
}

/** The vocabulary's categories, in the order the server sends them. */
export const CATEGORY_LABEL: Record<string, string> = {
  region: "Region",
  landscape_venue: "Setting and venue",
  architecture: "Architecture",
  aesthetic: "Style",
  dress_style: "What they wore",
  season: "Season",
};

/** "farm_ranch_countryside" -> "Farm ranch countryside"; "midwest_us" -> "Midwest US". */
export function tagLabel(id: string): string {
  const words = id.replace(/_/g, " ").trim().replace(/\bus\b/g, "US");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
