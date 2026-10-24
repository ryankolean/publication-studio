/**
 * Location codes from research/vocab/geo.yaml, as the research import stores
 * them (SUMMIT-336). A wedding's location is one place: a US state, a metro
 * inside one, or a country. An outlet's coverage lists places and wider
 * scopes. Containment runs metro, state, US region, US, WORLD, or country,
 * INTL, WORLD.
 *
 * Pure: the geo JSON is passed in.
 */

export interface Geo {
  /** "US:midwest" to its states. */
  regions: ReadonlyMap<string, readonly string[]>;
  /** "US:midwest" to "Midwest", and the scopes ("WORLD" to "Anywhere"). */
  names: ReadonlyMap<string, string>;
  /** "US-MI" to "Michigan". */
  states: ReadonlyMap<string, string>;
  /** "US-MI:detroit" to "Metro Detroit". */
  metros: ReadonlyMap<string, string>;
  /** "MX" to "Mexico". */
  countries: ReadonlyMap<string, string>;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Reads the stored geo vocabulary; anything malformed is simply absent. */
export function readGeo(raw: unknown): Geo {
  const source = record(raw);
  const regions = new Map<string, string[]>();
  const names = new Map(Object.entries(record(source["scopes"])).map(([code, name]) => [code, String(name)]));
  for (const [code, entry] of Object.entries(record(source["us_regions"]))) {
    const states = record(entry)["states"];
    if (Array.isArray(states)) regions.set(code, states.filter((state): state is string => typeof state === "string"));
    const name = record(entry)["name"];
    if (typeof name === "string") names.set(code, name);
  }
  const states = new Map(Object.entries(record(source["states"])).map(([code, name]) => [code, String(name)]));
  const metros = new Map<string, string>();
  for (const [state, entries] of Object.entries(record(source["metros"]))) {
    for (const [slug, name] of Object.entries(record(entries))) metros.set(`${state}:${slug}`, String(name));
  }
  const countries = new Map(Object.entries(record(source["countries"])).map(([code, name]) => [code, String(name)]));
  return { regions, names, states, metros, countries };
}

/** A place a wedding can be: a state, a metro or a country, never a scope or a region. */
export function isLocationCode(code: string, geo: Geo): boolean {
  return geo.states.has(code) || geo.metros.has(code) || geo.countries.has(code);
}

const stateOf = (code: string): string => code.split(":")[0] as string;

/**
 * The place and every wider place that contains it, most specific first:
 * "US-FL:florida-keys" gives US-FL:florida-keys, US-FL, US:southeast, US,
 * WORLD; "MX" gives MX, INTL, WORLD.
 */
export function locationAncestors(code: string, geo: Geo): string[] {
  if (geo.countries.has(code)) return [code, "INTL", "WORLD"];
  if (!geo.states.has(code) && !geo.metros.has(code)) return [];
  const state = stateOf(code);
  const regions = [...geo.regions].filter(([, states]) => states.includes(state)).map(([region]) => region);
  return [...(code === state ? [] : [code]), state, ...regions, "US", "WORLD"];
}

/** "Florida Keys, Florida", "Michigan", "Mexico", "Midwest". */
export function locationLabel(code: string, geo: Geo): string {
  const metro = geo.metros.get(code);
  if (metro !== undefined) return `${metro}, ${geo.states.get(stateOf(code)) ?? stateOf(code)}`;
  return geo.states.get(code) ?? geo.countries.get(code) ?? geo.names.get(code) ?? code;
}

/** Every place a wedding can be, for the location dropdown: US states with their metros, then countries. */
export function locationOptions(geo: Geo): Array<{ code: string; label: string; group: "us" | "intl" }> {
  const us = [...geo.states.keys()].sort((a, b) => locationLabel(a, geo).localeCompare(locationLabel(b, geo))).flatMap((state) => [
    { code: state, label: locationLabel(state, geo), group: "us" as const },
    ...[...geo.metros.keys()]
      .filter((metro) => stateOf(metro) === state)
      .map((metro) => ({ code: metro, label: locationLabel(metro, geo), group: "us" as const })),
  ]);
  const intl = [...geo.countries.keys()]
    .map((code) => ({ code, label: locationLabel(code, geo), group: "intl" as const }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...us, ...intl];
}

/** The region tag for each US region in geo.yaml. */
const REGION_TAG: Record<string, string> = {
  "US:northeast": "northeast_us",
  "US:mid-atlantic": "mid_atlantic_us",
  "US:southeast": "southeast_us",
  "US:south-central": "south_central_us",
  "US:midwest": "midwest_us",
  "US:southwest": "southwest_us",
  "US:mountain-west": "mountain_west_us",
  "US:pacific-northwest": "pacific_northwest_us",
};

/** States the tag vocabulary names on their own, ahead of their region. */
const STATE_TAG: Record<string, string> = { "US-MI": "michigan", "US-FL": "florida", "US-CA": "california" };

const MEXICO_CARIBBEAN = new Set([
  "MX", "BS", "TC", "KY", "JM", "DO", "BB", "LC", "AG", "AW", "CW", "VG", "VI", "PR", "BM", "BZ", "GD", "KN", "VC", "SX", "MF", "BL", "TT", "HT", "CU",
]);
const BRITISH_ISLES = new Set(["GB", "IE", "IM", "JE", "GG"]);
const MEDITERRANEAN_EUROPE = new Set(["IT", "ES", "FR", "GR", "PT", "HR", "MT", "CY", "MC", "SM", "VA", "ME", "AL", "SI"]);

/**
 * The region tags a wedding's location suggests: its own state tag where the
 * vocabulary has one, its US region, or the international region of its
 * country.
 */
export function regionTagsForLocation(code: string | null, geo: Geo): string[] {
  if (code === null || !isLocationCode(code, geo)) return [];
  if (geo.countries.has(code)) {
    if (MEXICO_CARIBBEAN.has(code)) return ["mexico_caribbean"];
    if (BRITISH_ISLES.has(code)) return ["british_isles"];
    if (MEDITERRANEAN_EUROPE.has(code)) return ["mediterranean_europe"];
    return ["international_other"];
  }
  const ancestors = locationAncestors(code, geo);
  const own = STATE_TAG[stateOf(code)];
  return [
    ...(own === undefined ? [] : [own]),
    ...ancestors.map((place) => REGION_TAG[place]).filter((tag): tag is string => tag !== undefined),
  ];
}
