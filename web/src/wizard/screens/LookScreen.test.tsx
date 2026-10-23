import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../../api/client.js";
import type { LookBody, LookTag } from "../../style/tags.js";
import { fakeApi, renderWizard, serve, walkthrough, wizardAt, type FakeApi } from "../test-utils.js";

let api: FakeApi;

beforeEach(() => {
  api = fakeApi();
});

const tag = (id: string, category: string, overrides: Partial<LookTag> = {}): LookTag => ({
  id,
  category,
  state: "suggested",
  source: "analysis",
  confidence: "high",
  reason: null,
  ...overrides,
});

const look = (overrides: Partial<LookBody> = {}): LookBody => ({
  tags: [
    tag("lakefront", "landscape_venue", { reason: "Photos 1 and 3: dock on a lake." }),
    tag("romantic", "aesthetic", { state: "confirmed" }),
    tag("bohemian", "aesthetic", { state: "rejected" }),
    tag("winter", "season", { source: "derived", confidence: null, reason: "From the wedding date." }),
  ],
  vocabulary: [
    { id: "lakefront", category: "landscape_venue" },
    { id: "romantic", category: "aesthetic" },
    { id: "bohemian", category: "aesthetic" },
    { id: "whimsical", category: "aesthetic" },
    { id: "ball_gown", category: "dress_style" },
    { id: "winter", category: "season" },
  ],
  photos: { count: 2, usable: 2 },
  analysis: { enabled: true, available: true, lastRun: null, current: false },
  ...overrides,
});

const image = (name: string) => ({
  key: `events/w1/${name}.jpg`,
  originalName: `${name}.jpg`,
  contentType: "image/jpeg",
  bytes: 5,
  createdAt: "",
  readUrl: `/images/events/w1/${name}.jpg?token=${name}`,
  expiresIn: 900,
});

function open(body: LookBody | (() => LookBody) = look()) {
  serve(api, {
    "/events/w1/walkthrough": walkthrough(wizardAt("look")),
    "/style/events/w1": body,
    "/events/w1/images": { images: [image("a"), image("b")] },
  });
  renderWizard(api, "/wizard/w1/look");
}

const location = () => screen.getByTestId("location").textContent;

describe("LookScreen", () => {
  it("lists suggestions with their reasons, kept tags, and hides tags she turned down", async () => {
    open();
    expect(await screen.findByText("Photos 1 and 3: dock on a lake.")).toBeInTheDocument();
    expect(screen.getByText("From the wedding date.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep Lakefront" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Romantic" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Tags" })).queryByText("Bohemian")).toBeNull();
    expect(screen.getByText("1 tag kept.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Photos so far" }).querySelectorAll("img")).toHaveLength(2);
  });

  it("saves Keep and Not this, and shows the server's answer", async () => {
    open();
    api.put.mockResolvedValueOnce(
      look({ tags: [tag("lakefront", "landscape_venue", { state: "confirmed" }), tag("romantic", "aesthetic", { state: "confirmed" })] }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Keep Lakefront" }));
    expect(api.put).toHaveBeenCalledWith("/style/events/w1/tags/lakefront", { state: "confirmed" });
    expect(await screen.findByText("2 tags kept.")).toBeInTheDocument();

    api.put.mockResolvedValueOnce(look({ tags: [] }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Romantic" }));
    expect(api.put).toHaveBeenLastCalledWith("/style/events/w1/tags/romantic", { state: "rejected" });
    expect(await screen.findByText("No tags kept yet.")).toBeInTheDocument();
  });

  it("suggests tags from the photos", async () => {
    open(look({ tags: [] }));
    let finish: (value: LookBody) => void = () => undefined;
    api.post.mockReturnValueOnce(new Promise<LookBody>((resolve) => (finish = resolve)));
    await userEvent.click(await screen.findByRole("button", { name: "Suggest tags" }));
    expect(api.post).toHaveBeenCalledWith("/style/events/w1/suggest", {});
    expect(screen.getByText("Looking at your photos. This can take a minute.")).toBeInTheDocument();
    finish(look({ tags: [tag("whimsical", "aesthetic", { reason: "Photo 4: balloons." })], fresh: true }));
    expect(await screen.findByText("Photo 4: balloons.")).toBeInTheDocument();
  });

  it("says why it cannot suggest, and where to switch suggestions on", async () => {
    open(look({ analysis: { enabled: false, available: true, lastRun: null, current: false } }));
    const button = await screen.findByRole("button", { name: "Suggest tags" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Suggestions are switched off. Turn them on under Your work.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Your work" })).toHaveAttribute("href", "/style");
  });

  it.each([
    [{ photos: { count: 0, usable: 0 } }, "Add a few photos first."],
    [{ photos: { count: 3, usable: 0 } }, "Every photo here is over 7.5 MB. Add web-size copies first."],
    [{ analysis: { enabled: true, available: false, lastRun: null, current: false } }, "Suggestions are not set up yet. Choose the tags yourself for now."],
    [{ analysis: { enabled: true, available: true, lastRun: null, current: true } }, "These photos already have suggestions. Add more for a fresh look."],
  ])("holds Suggest tags: %j", async (overrides, reason) => {
    open(look(overrides as Partial<LookBody>));
    expect(await screen.findByRole("button", { name: "Suggest tags" })).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("shows the server's reason when a suggestion fails", async () => {
    open(look({ tags: [] }));
    api.post.mockRejectedValueOnce(new ApiError(502, "ANALYSIS_FAILED", "Claude could not suggest tags just now. Try again later, or choose the tags yourself."));
    await userEvent.click(await screen.findByRole("button", { name: "Suggest tags" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Claude could not suggest tags just now.");
  });

  it("adds a tag she picks, offering only tags not already listed", async () => {
    open();
    const select = (await screen.findByLabelText("Add a tag")) as HTMLSelectElement;
    const offered = within(select).getAllByRole("option").map((option) => option.getAttribute("value"));
    expect(offered).toEqual(["", "bohemian", "whimsical", "ball_gown"]);
    api.put.mockResolvedValueOnce(look());
    await userEvent.selectOptions(select, "ball_gown");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(api.put).toHaveBeenCalledWith("/style/events/w1/tags/ball_gown", { state: "confirmed" });
  });

  it("goes on to the outlet whatever is tagged", async () => {
    open(look({ tags: [] }));
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(location()).toBe("/wizard/w1/outlet"));
  });
});
