import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  isLocationCode,
  locationAncestors,
  locationLabel,
  locationOptions,
  readGeo,
  regionTagsForLocation,
} from "../src/domain/geo.js";

const here = dirname(fileURLToPath(import.meta.url));
const GEO = readGeo(parse(readFileSync(join(here, "../../research/vocab/geo.yaml"), "utf8")));
const TAGS = parse(readFileSync(join(here, "../../research/vocab/tags.yaml"), "utf8")) as { region: string[] };

describe("location codes", () => {
  it("accepts states, metros and countries, never scopes or regions", () => {
    for (const code of ["US-MI", "US-FL:florida-keys", "MX", "FR"]) expect(isLocationCode(code, GEO), code).toBe(true);
    for (const code of ["WORLD", "US", "INTL", "US:southeast", "US-FL:atlantis", "ZZ"]) expect(isLocationCode(code, GEO), code).toBe(false);
  });

  it("walks from a metro up to WORLD through its state and region", () => {
    expect(locationAncestors("US-FL:florida-keys", GEO)).toEqual(["US-FL:florida-keys", "US-FL", "US:southeast", "US", "WORLD"]);
    expect(locationAncestors("US-MI", GEO)).toEqual(["US-MI", "US:midwest", "US", "WORLD"]);
    expect(locationAncestors("US-CA", GEO)).toEqual(["US-CA", "US", "WORLD"]);
    expect(locationAncestors("MX", GEO)).toEqual(["MX", "INTL", "WORLD"]);
    expect(locationAncestors("nowhere", GEO)).toEqual([]);
  });

  it("names a place the way the dropdown shows it", () => {
    expect(locationLabel("US-FL:florida-keys", GEO)).toBe("Florida Keys, Florida");
    expect(locationLabel("US-MI", GEO)).toBe("Michigan");
    expect(locationLabel("TC", GEO)).toBe("Turks and Caicos Islands");
    expect(locationLabel("US:midwest", GEO)).toBe("Midwest");
    expect(locationLabel("WORLD", GEO)).toBe("Anywhere");
  });

  it("offers every state with its metros under it, then countries", () => {
    const options = locationOptions(GEO);
    const at = (code: string) => options.findIndex((option) => option.code === code);
    expect(options[at("US-FL") + 1]?.code.startsWith("US-FL:")).toBe(true);
    expect(at("US-FL:florida-keys")).toBeGreaterThan(at("US-FL"));
    expect(at("US-GA")).toBeGreaterThan(at("US-FL:florida-keys"));
    expect(options.at(-1)?.group).toBe("intl");
    expect(new Set(options.map((option) => option.code)).size).toBe(options.length);
  });
});

describe("regionTagsForLocation", () => {
  it.each([
    ["US-MI:detroit", ["michigan", "midwest_us"]],
    ["US-FL:florida-keys", ["florida", "southeast_us"]],
    ["US-TX", ["south_central_us"]],
    ["US-CA", ["california"]],
    ["TC", ["mexico_caribbean"]],
    ["FR", ["mediterranean_europe"]],
    ["CA", ["international_other"]],
  ])("%s suggests %j", (code, tags) => {
    expect(regionTagsForLocation(code, GEO)).toEqual(tags);
  });

  it("suggests nothing without a place, or for a code it does not know", () => {
    expect(regionTagsForLocation(null, GEO)).toEqual([]);
    expect(regionTagsForLocation("US:southeast", GEO)).toEqual([]);
  });

  it("only ever suggests vocabulary tags", () => {
    for (const { code } of locationOptions(GEO)) {
      for (const tag of regionTagsForLocation(code, GEO)) expect(TAGS.region, `${code} -> ${tag}`).toContain(tag);
    }
  });
});
