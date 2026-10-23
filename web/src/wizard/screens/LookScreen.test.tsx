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
  source: "operator",
  confidence: "high",
  reason: null,
  ...overrides,
});

const look = (overrides: Partial<LookBody> = {}): LookBody => ({
  tags: [
    tag("lakefront", "landscape_venue", { reason: "Photos 1 and 3: dock on a lake." }),
    tag("romantic", "aesthetic", { state: "confirmed" }),
    tag("bohemian", "aesthetic", { state: "rejected" }),
    tag("midwest_us", "region", { source: "derived", confidence: null, reason: "From where the wedding was." }),
    tag("winter", "season", { source: "derived", confidence: null, reason: "From the wedding date." }),
  ],
  vocabulary: [
    { id: "midwest_us", category: "region" },
    { id: "lakefront", category: "landscape_venue" },
    { id: "romantic", category: "aesthetic" },
    { id: "bohemian", category: "aesthetic" },
    { id: "whimsical", category: "aesthetic" },
    { id: "ball_gown", category: "dress_style" },
    { id: "winter", category: "season" },
  ],
  ...overrides,
});

function open(body: LookBody = look()) {
  serve(api, {
    "/events/w1/walkthrough": walkthrough(wizardAt("look")),
    "/style/events/w1": body,
  });
  renderWizard(api, "/wizard/w1/look");
}

const location = () => screen.getByTestId("location").textContent;

describe("LookScreen", () => {
  it("lists suggestions with their reasons and kept tags, and hides tags she turned down", async () => {
    open();
    expect(await screen.findByText("Photos 1 and 3: dock on a lake.")).toBeInTheDocument();
    expect(screen.getByText("From the wedding date.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep Lakefront" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep Midwest US" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Romantic" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Tags" })).queryByText("Bohemian")).toBeNull();
    expect(screen.getByText("1 tag kept.")).toBeInTheDocument();
  });

  it("saves Keep and Remove, and shows the server's answer", async () => {
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
    expect(screen.getByText("No suggestions for this wedding. Add tags below.")).toBeInTheDocument();
  });

  it("turns a suggestion down with Not this", async () => {
    open();
    api.put.mockResolvedValueOnce(look());
    await userEvent.click(await screen.findByRole("button", { name: "Not this: Winter" }));
    expect(api.put).toHaveBeenCalledWith("/style/events/w1/tags/winter", { state: "rejected" });
  });

  it("shows the server's reason when a save fails", async () => {
    open();
    api.put.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "That tag could not be found."));
    await userEvent.click(await screen.findByRole("button", { name: "Keep Lakefront" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That tag could not be found.");
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
