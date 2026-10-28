import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { readGeo } from "../src/domain/geo.js";

import {
  STAGE_WORDS,
  STATUS_WORDS,
  auditArgs,
  placeOf,
  studioOverview,
  weddingCard,
  weddingLine,
  weddingPage,
} from "../src/domain/mcp-views.js";
import type { CardWedding, QueueRecord, WeddingRecord } from "../src/domain/mcp-views.js";
import type { ChipKind } from "../src/domain/wizard.js";
import { SUBMISSION_STATUSES } from "../src/domain/submission-status.js";

function wedding(n: number, kind: ChipKind = "ready", label = "Ready to send"): WeddingRecord {
  return {
    id: `id-${n}`,
    slug: `couple-${n}-2026`,
    coupleNames: `Couple ${n}`,
    eventDate: `2026-0${(n % 9) + 1}-14`,
    venueName: `Venue ${n}`,
    city: "Duck Key",
    state: "FL",
    country: "US",
    chip: { kind, label },
  };
}

function queued(eventId: string, status: QueueRecord["status"], daysRemaining: number | null = null): QueueRecord {
  return {
    eventId,
    publicationName: `Outlet for ${eventId}`,
    status,
    responseDueAt: daysRemaining === null ? null : `2026-11-${String(10 + daysRemaining).padStart(2, "0")}T00:00:00Z`,
    daysRemaining,
  };
}

/** About four characters a token: the spec's ~500-token default budget. */
const BUDGET = 2000;

describe("placeOf", () => {
  it("is the city and state", () => {
    expect(placeOf(wedding(1))).toBe("Duck Key, FL");
  });

  it("falls back to the country without a state, and to null with nothing", () => {
    expect(placeOf({ ...wedding(1), state: null, city: "Paris", country: "FR" })).toBe("Paris, FR");
    expect(placeOf({ ...wedding(1), city: null, state: null, country: null })).toBeNull();
  });

  it("is the place from the location list when the wedding has one, the place the matcher uses", () => {
    const geo = readGeo(parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../research/vocab/geo.yaml"), "utf8")));
    const keys = { ...wedding(1), city: null, state: null, country: null, locationCode: "US-FL:florida-keys" };
    expect(placeOf(keys, geo)).toBe("Florida Keys, Florida");
    expect(placeOf(keys)).toBeNull();
    expect(placeOf({ ...keys, locationCode: null }, geo)).toBeNull();
    expect(weddingLine({ ...keys }, geo).place).toBe("Florida Keys, Florida");
  });
});

describe("weddingLine", () => {
  it("is the short id, couple, date, place and next step, nothing else", () => {
    expect(weddingLine(wedding(3))).toEqual({
      wedding: "couple-3-2026",
      couple: "Couple 3",
      date: "2026-04-14",
      place: "Duck Key, FL",
      step: "Ready to send",
    });
  });
});

describe("studioOverview", () => {
  it("counts weddings by stage in plain words, leaving out empty stages", () => {
    const overview = studioOverview(
      [wedding(1, "blocked", "On hold"), wedding(2, "blocked", "On hold"), wedding(3, "live", "Sent to X")],
      [],
    );
    expect(overview.weddings).toEqual({ total: 3, byStage: { "on hold": 2, "with an outlet": 1 } });
  });

  it("puts what she can act on first: send, then details, then choose an outlet, then holds", () => {
    const overview = studioOverview(
      [
        wedding(1, "blocked", "On hold: no answer"),
        wedding(2, "ready", "Ready to send"),
        wedding(3, "live", "Sent to X"),
        wedding(4, "needs_details", "Needs details"),
        wedding(5, "queued", "In the queue for Y"),
      ],
      [],
    );
    expect(overview.nextSteps.map((step) => step.wedding)).toEqual([
      "couple-5-2026",
      "couple-4-2026",
      "couple-2-2026",
      "couple-1-2026",
    ]);
    expect(overview.nextSteps[0]).toEqual({ wedding: "couple-5-2026", couple: "Couple 5", step: "In the queue for Y" });
    expect(overview.moreSteps).toBe(0);
  });

  it("keeps the next steps to five and says how many more there are", () => {
    const overview = studioOverview(
      Array.from({ length: 8 }, (_, n) => wedding(n, "needs_details", "Needs details")),
      [],
    );
    expect(overview.nextSteps).toHaveLength(5);
    expect(overview.moreSteps).toBe(3);
  });

  it("counts the queue by what it is waiting on", () => {
    const overview = studioOverview(
      [wedding(1)],
      [
        queued("id-1", "ready"),
        queued("id-1", "queued"),
        queued("id-1", "sent", 4),
        queued("id-1", "expired", -2),
        queued("id-1", "withdraw_pending"),
        queued("id-1", "accepted"),
        queued("id-1", "declined"),
      ],
    );
    expect(overview.queue).toEqual({ waitingToSend: 2, withOutlets: 3, accepted: 1 });
  });

  it("lists replies due in the next two weeks, overdue first, at most five", () => {
    const overview = studioOverview(
      [wedding(1), wedding(2)],
      [
        queued("id-1", "sent", 9),
        queued("id-2", "sent", 15),
        queued("id-2", "expired", -3),
        queued("id-1", "sent", null),
        queued("id-1", "sent", 0),
        queued("id-1", "sent", 1),
        queued("id-1", "sent", 2),
        queued("id-1", "sent", 3),
      ],
    );
    expect(overview.deadlines.map((due) => due.daysLeft)).toEqual([-3, 0, 1, 2, 3]);
    const edge = studioOverview([wedding(1)], [queued("id-1", "sent", 14), queued("id-1", "sent", 15), queued("id-1", "declined", 2)]);
    expect(edge.deadlines.map((due) => due.daysLeft)).toEqual([14]);
    expect(overview.deadlines[0]).toEqual({
      wedding: "couple-2-2026",
      outlet: "Outlet for id-2",
      due: "2026-11-07",
      daysLeft: -3,
    });
  });

  it("leaves a deadline's wedding null if it is not in the list", () => {
    expect(studioOverview([], [queued("gone", "sent", 1)]).deadlines[0]?.wedding).toBeNull();
  });

  it("stays inside the token budget for a busy studio", () => {
    const weddings = Array.from({ length: 40 }, (_, n) => wedding(n, "needs_details", "On hold: the couple has not agreed yet"));
    const queue = Array.from({ length: 30 }, (_, n) => queued(`id-${n}`, "sent", n % 14));
    expect(JSON.stringify(studioOverview(weddings, queue)).length).toBeLessThan(BUDGET);
  });
});

describe("weddingPage", () => {
  const many = Array.from({ length: 23 }, (_, n) => wedding(n));

  it("pages ten at a time by default with a cursor to the next page", () => {
    const first = weddingPage(many, {});
    if ("error" in first) throw new Error(first.error);
    expect(first.weddings).toHaveLength(10);
    expect(first.total).toBe(23);
    expect(first.next).toBe("10");

    const last = weddingPage(many, { cursor: "20" });
    if ("error" in last) throw new Error(last.error);
    expect(last.weddings.map((line) => line.wedding)).toEqual(["couple-20-2026", "couple-21-2026", "couple-22-2026"]);
    expect(last).not.toHaveProperty("next");
  });

  it("takes a smaller or larger page, up to twenty-five", () => {
    const page = weddingPage(many, { limit: 3 });
    expect("error" in page ? [] : page.weddings).toHaveLength(3);
    const capped = weddingPage([...many, ...many], { limit: 99 });
    expect("error" in capped ? [] : capped.weddings).toHaveLength(25);
  });

  it.each(["abc", "-1", "24", "1.5", ""])("refuses the cursor %j", (cursor) => {
    expect(weddingPage(many, { cursor })).toEqual({ error: "That cursor is not valid. Ask again without one." });
  });

  it("allows the cursor that ends an exact page", () => {
    const page = weddingPage(many.slice(0, 20), { cursor: "20" });
    expect(page).toEqual({ weddings: [], total: 20 });
  });

  it("keeps a default page inside the token budget", () => {
    expect(JSON.stringify(weddingPage(many, {})).length).toBeLessThan(BUDGET);
  });
});

describe("weddingCard", () => {
  const base: CardWedding = {
    ...wedding(7, "blocked", "On hold: the couple has not agreed yet"),
    hasGalleryUrl: true,
    rightsStatus: "own_contract",
    consentStatus: "unverified",
    coupleStory: "They met at a regatta.",
    uniqueAngle: "Sunrise ceremony on the water.",
    contentType: "real_wedding",
    isDestination: true,
  };

  it("summarises by default: where it stands, any hold, and its outlets", () => {
    const card = weddingCard(base, [queued("id-7", "sent", 3), queued("id-7", "declined", -4)], null);
    expect(card).toEqual({
      wedding: "couple-7-2026",
      couple: "Couple 7",
      date: "2026-08-14",
      venue: "Venue 7",
      place: "Duck Key, FL",
      step: "On hold: the couple has not agreed yet",
      onHold: ["The couple has not agreed to a submission yet. Ask them, then record their answer."],
      gallery: true,
      outlets: [
        { outlet: "Outlet for id-7", status: "sent, waiting for a reply", daysLeft: 3 },
        { outlet: "Outlet for id-7", status: "declined" },
      ],
    });
  });

  it("has no hold line when nothing holds it", () => {
    const card = weddingCard({ ...base, consentStatus: "granted" }, [], null);
    expect(card).not.toHaveProperty("onHold");
  });

  it("adds the story, angle, kind and credits when asked, business names only", () => {
    const card = weddingCard(base, [], [{ role: "Florist", businessName: "Petal & Stem" }]);
    expect(card).toMatchObject({
      story: "They met at a regatta.",
      angle: "Sunrise ceremony on the water.",
      contentType: "real_wedding",
      destination: true,
      credits: [{ role: "Florist", business: "Petal & Stem" }],
    });
  });

  it("keeps a summary inside the token budget", () => {
    const outlets = Array.from({ length: 10 }, () => queued("id-7", "sent", 5));
    expect(JSON.stringify(weddingCard(base, outlets, null)).length).toBeLessThan(BUDGET);
  });
});

describe("plain words", () => {
  it("has a phrase for every submission status and stage", () => {
    for (const status of SUBMISSION_STATUSES) expect(STATUS_WORDS[status]).toMatch(/^[a-z]/);
    for (const words of Object.values(STAGE_WORDS)) expect(words).toMatch(/^[a-z]/);
  });

  it("never says package, event, intake or attestation", () => {
    const all = [...Object.values(STATUS_WORDS), ...Object.values(STAGE_WORDS)].join(" ");
    expect(all).not.toMatch(/package|event|intake|attestation/i);
  });
});

describe("auditArgs", () => {
  it("keeps ids, flags and numbers, and hides free text", () => {
    expect(
      auditArgs({
        wedding: "blake-and-anne-2026",
        detail: true,
        limit: 5,
        cursor: "10",
        note: "Please look at the Pic-Time gallery https://example.pic-time.com/abc",
        plain: "the macon wedding",
        nested: { a: 1 },
      }),
    ).toEqual({
      wedding: "blake-and-anne-2026",
      detail: true,
      limit: 5,
      cursor: "10",
      note: "[text]",
      plain: "[text]",
      nested: "[object]",
    });
  });

  it("is empty for no arguments", () => {
    expect(auditArgs(undefined)).toEqual({});
    expect(auditArgs("not an object")).toEqual({});
  });
});
