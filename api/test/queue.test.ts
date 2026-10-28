import { describe, expect, it } from "vitest";

import { QUEUE_MAX, queueNext, queueView, validateQueue } from "../src/domain/queue.js";
import type { QueuedPackage } from "../src/domain/queue.js";
import type { SubmissionStatus } from "../src/domain/submission-status.js";

const order = [
  { publicationId: "pub-a", name: "A" },
  { publicationId: "pub-b", name: "B" },
  { publicationId: "pub-c", name: "C" },
];

const pkg = (publicationId: string, complete: boolean, status: SubmissionStatus | null = null): QueuedPackage => ({
  id: `pkg-${publicationId}`,
  publicationId,
  complete,
  submission: status === null ? null : { status },
});

describe("validateQueue", () => {
  it("takes outlet ids, each once", () => {
    expect(validateQueue({ publicationIds: ["pub-a", "pub-b"] })).toEqual({ ok: true, value: ["pub-a", "pub-b"] });
  });

  it("refuses an empty, overlong, repeated or malformed order", () => {
    expect(validateQueue({ publicationIds: [] })).toMatchObject({ ok: false, errors: [{ field: "publicationIds" }] });
    expect(validateQueue(null)).toMatchObject({ ok: false });
    expect(validateQueue({ publicationIds: "pub-a" })).toMatchObject({ ok: false });
    expect(validateQueue({ publicationIds: Array.from({ length: QUEUE_MAX + 1 }, (_, i) => `pub-${i}`) })).toMatchObject({
      ok: false,
      errors: [{ message: `Keep the order to ${QUEUE_MAX} outlets or fewer.` }],
    });
    const result = validateQueue({ publicationIds: ["pub-a", "pub-a", "", 3] });
    expect(result.ok ? [] : result.errors).toEqual([
      { field: "publicationIds.1", message: "Listed twice: pub-a." },
      { field: "publicationIds.2", message: "Expected an outlet id." },
      { field: "publicationIds.3", message: "Expected an outlet id." },
    ]);
  });
});

describe("queueView", () => {
  it("says where each outlet stands, and puts the first unreleased one up next", () => {
    const view = queueView(order, [pkg("pub-a", true, "declined"), pkg("pub-b", false), pkg("pub-x", true)]);
    expect(view.entries).toEqual([
      { position: 1, publicationId: "pub-a", name: "A", state: "declined", words: "declined; the wedding is free again", packageId: "pkg-pub-a" },
      { position: 2, publicationId: "pub-b", name: "B", state: "package_incomplete", words: "package started, not complete", packageId: "pkg-pub-b" },
      { position: 3, publicationId: "pub-c", name: "C", state: "no_package", words: "no package yet", packageId: null },
    ]);
    expect(view.upNext?.publicationId).toBe("pub-b");
    expect(view.placed).toBeNull();
  });

  it("is placed, with nothing up next, once the open outlet accepts", () => {
    const view = queueView(order, [pkg("pub-a", true, "withdrawn"), pkg("pub-b", true, "accepted")]);
    expect(view.placed?.publicationId).toBe("pub-b");
    expect(view.upNext).toBeNull();
  });

  it("has nothing up next when every outlet released it, or there is no order", () => {
    const released = queueView(order.slice(0, 2), [pkg("pub-a", true, "declined"), pkg("pub-b", true, "cancelled")]);
    expect(released).toMatchObject({ upNext: null, placed: null });
    expect(queueView([], [])).toMatchObject({ entries: [], upNext: null, placed: null });
  });
});

describe("queueNext", () => {
  const next = (packages: QueuedPackage[], outlets = order) => queueNext(queueView(outlets, packages));

  it.each([
    [[], "Build the package for A with build_package_draft."],
    [[pkg("pub-a", false)], "Finish the package for A with build_package_draft; it lists what is left."],
    [[pkg("pub-a", false, "draft")], "Finish the package for A with build_package_draft; it lists what is left."],
    [[pkg("pub-a", true)], "The package for A is complete; set_queue readies it."],
    [[pkg("pub-a", true, "ready")], "Ready to send to A. She sends it herself through the outlet's own route, then marks it sent in the studio."],
    [[pkg("pub-a", true, "queued")], "Ready to send to A. She sends it herself through the outlet's own route, then marks it sent in the studio."],
    [[pkg("pub-a", true, "sent")], "With A; wait for its answer before the next outlet."],
    [[pkg("pub-a", true, "expired")], "A did not answer in time. Withdraw it in the studio to move to the next outlet."],
    [[pkg("pub-a", true, "withdraw_pending")], "Waiting for A to confirm the withdrawal."],
    [[pkg("pub-a", true, "published")], "The wedding is placed with A; nothing else in the order is needed."],
  ] as Array<[QueuedPackage[], string]>)("%#: %s", (packages, words) => {
    expect(next(packages)).toBe(words);
  });

  it("says when the order is empty or used up", () => {
    expect(next([], [])).toBe("There is no order yet. Rank the outlets and set one with set_queue.");
    expect(next([pkg("pub-a", true, "declined")], order.slice(0, 1))).toBe(
      "Every outlet in the order has released the wedding. Rank again and set a new order.",
    );
  });
});
