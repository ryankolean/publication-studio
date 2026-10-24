import { describe, expect, it } from "vitest";

import { validateEventIntake } from "../src/domain/event-intake.js";

const minimal = { coupleNames: "Sarah and James", eventDate: "2026-06-14" };

const ok = (input: unknown) => {
  const result = validateEventIntake(input);
  if (!result.ok) throw new Error(`expected valid: ${JSON.stringify(result.errors)}`);
  return result.value;
};

const errorFields = (input: unknown) => {
  const result = validateEventIntake(input);
  if (result.ok) throw new Error("expected invalid");
  return result.errors.map((e) => e.field);
};

describe("required fields", () => {
  it("accepts the minimum viable intake", () => {
    expect(ok(minimal)).toMatchObject({
      coupleNames: "Sarah and James",
      eventDate: "2026-06-14",
    });
  });

  it("requires couple names", () => {
    expect(errorFields({ eventDate: "2026-06-14" })).toContain("coupleNames");
  });

  it("requires an event date", () => {
    expect(errorFields({ coupleNames: "Sarah and James" })).toContain("eventDate");
  });

  it("rejects blank couple names", () => {
    expect(errorFields({ ...minimal, coupleNames: "   " })).toContain("coupleNames");
  });

  it("rejects a body that is not an object", () => {
    for (const body of [null, "hello", 42, [1, 2]]) {
      const result = validateEventIntake(body);
      expect(result.ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("reports every problem at once rather than the first", () => {
    const fields = errorFields({ rightsStatus: "bogus", consentStatus: "bogus" });
    expect(fields).toEqual(
      expect.arrayContaining(["coupleNames", "eventDate", "rightsStatus", "consentStatus"]),
    );
  });
});

describe("event date", () => {
  it("requires ISO yyyy-mm-dd", () => {
    for (const date of ["14/06/2026", "2026-6-14", "June 14 2026", "2026-06-14T00:00:00Z"]) {
      expect(errorFields({ ...minimal, eventDate: date }), date).toContain("eventDate");
    }
  });

  it("rejects an impossible calendar date", () => {
    expect(errorFields({ ...minimal, eventDate: "2026-02-30" })).toContain("eventDate");
    expect(errorFields({ ...minimal, eventDate: "2026-13-01" })).toContain("eventDate");
  });

  it("accepts a leap day in a leap year", () => {
    expect(ok({ ...minimal, eventDate: "2028-02-29" }).eventDate).toBe("2028-02-29");
  });
});

describe("rights and consent", () => {
  it("defaults both to unverified, so nothing is assumed permitted", () => {
    const value = ok(minimal);
    expect(value.rightsStatus).toBe("unverified");
    expect(value.consentStatus).toBe("unverified");
  });

  it("accepts every documented status", () => {
    for (const rights of ["unverified", "own_contract", "second_shooter", "blocked"]) {
      expect(ok({ ...minimal, rightsStatus: rights }).rightsStatus).toBe(rights);
    }
    for (const consent of ["unverified", "granted", "granted_limited", "declined"]) {
      expect(ok({ ...minimal, consentStatus: consent }).consentStatus).toBe(consent);
    }
  });

  it("rejects an undocumented status rather than coercing it", () => {
    expect(errorFields({ ...minimal, rightsStatus: "probably_fine" })).toContain("rightsStatus");
    expect(errorFields({ ...minimal, consentStatus: "verbal" })).toContain("consentStatus");
  });
});

describe("optional text fields", () => {
  it("trims and keeps them", () => {
    const value = ok({
      ...minimal,
      venueName: "  The Barn  ",
      city: "Detroit",
      state: "MI",
      country: "USA",
      uniqueAngle: "Rain the whole day",
      consentNotes: "First names only",
      nameDisplay: "first names only",
      coupleStory: "They met at a bus stop",
      heroPicks: "IMG_001, IMG_204",
      targetOutletNotes: "Carats and Cake first",
    });
    expect(value.venueName).toBe("The Barn");
    expect(value.consentNotes).toBe("First names only");
  });

  it("turns a blank optional field into null rather than an empty string", () => {
    expect(ok({ ...minimal, venueName: "   " }).venueName).toBeNull();
  });

  it("omits an absent optional field as null", () => {
    expect(ok(minimal).venueName).toBeNull();
  });
});

describe("urls", () => {
  it("accepts an https gallery url", () => {
    const value = ok({ ...minimal, galleryUrl: "https://gallery.example.com/abc?token=xyz" });
    expect(value.galleryUrl).toBe("https://gallery.example.com/abc?token=xyz");
  });

  it("rejects a non-http scheme", () => {
    for (const url of ["javascript:alert(1)", "ftp://example.com", "data:text/html,x"]) {
      expect(errorFields({ ...minimal, galleryUrl: url }), url).toContain("galleryUrl");
    }
  });

  it("rejects a malformed url", () => {
    expect(errorFields({ ...minimal, galleryUrl: "not a url" })).toContain("galleryUrl");
  });

  it("applies the same rule to the video url", () => {
    expect(errorFields({ ...minimal, videoUrl: "javascript:alert(1)" })).toContain("videoUrl");
    expect(ok({ ...minimal, videoUrl: "https://vimeo.com/123" }).videoUrl).toBe(
      "https://vimeo.com/123",
    );
  });
});

describe("destination flag", () => {
  it("defaults to false", () => {
    expect(ok(minimal).isDestination).toBe(false);
  });

  it("accepts a boolean", () => {
    expect(ok({ ...minimal, isDestination: true }).isDestination).toBe(true);
  });

  it("rejects a non-boolean rather than coercing a truthy string", () => {
    expect(errorFields({ ...minimal, isDestination: "yes" })).toContain("isDestination");
  });
});

describe("place and kind of wedding", () => {
  it("defaults to no place and a real wedding", () => {
    expect(ok(minimal)).toMatchObject({ locationCode: null, contentType: "real_wedding" });
  });

  it("keeps a place code for the route to check, and an elopement or styled shoot", () => {
    expect(ok({ ...minimal, locationCode: " US-FL:florida-keys ", contentType: "elopement" })).toMatchObject({
      locationCode: "US-FL:florida-keys",
      contentType: "elopement",
    });
  });

  it("rejects a kind of wedding it does not know", () => {
    expect(errorFields({ ...minimal, contentType: "party" })).toContain("contentType");
  });
});

describe("vendor credits", () => {
  it("defaults to an empty list", () => {
    expect(ok(minimal).vendorCredits).toEqual([]);
  });

  it("keeps role and business name and preserves order", () => {
    const value = ok({
      ...minimal,
      vendorCredits: [
        { role: "Florist", businessName: "Stems" },
        { role: "Venue", businessName: "The Barn", website: "https://barn.example" },
      ],
    });
    expect(value.vendorCredits).toEqual([
      { role: "Florist", businessName: "Stems", website: null, instagram: null },
      {
        role: "Venue",
        businessName: "The Barn",
        website: "https://barn.example",
        instagram: null,
      },
    ]);
  });

  it("requires a role and a business name on each row", () => {
    expect(errorFields({ ...minimal, vendorCredits: [{ role: "Florist" }] })).toContain(
      "vendorCredits.0.businessName",
    );
    expect(errorFields({ ...minimal, vendorCredits: [{ businessName: "Stems" }] })).toContain(
      "vendorCredits.0.role",
    );
  });

  it("reports the index of the offending row", () => {
    const fields = errorFields({
      ...minimal,
      vendorCredits: [{ role: "Florist", businessName: "Stems" }, { role: "Venue" }],
    });
    expect(fields).toContain("vendorCredits.1.businessName");
  });

  it("normalises an instagram handle to a bare handle", () => {
    const value = ok({
      ...minimal,
      vendorCredits: [{ role: "Florist", businessName: "Stems", instagram: "@stems" }],
    });
    expect(value.vendorCredits[0]?.instagram).toBe("stems");
  });

  it("rejects a vendor website with a non-http scheme", () => {
    expect(
      errorFields({
        ...minimal,
        vendorCredits: [
          { role: "Florist", businessName: "Stems", website: "javascript:alert(1)" },
        ],
      }),
    ).toContain("vendorCredits.0.website");
  });

  it("rejects a non-array", () => {
    expect(errorFields({ ...minimal, vendorCredits: {} })).toContain("vendorCredits");
  });
});
