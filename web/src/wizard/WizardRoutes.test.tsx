import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../api/client.js";
import { fakeApi, location, renderWizard, serve, storedEvent, walkthrough, wizardAt, type FakeApi } from "./test-utils.js";

let api: FakeApi;

beforeEach(() => {
  api = fakeApi();
});

describe("the start screen", () => {
  const events = {
    events: [
      { id: "w1", coupleNames: "Sarah and James", eventDate: "2026-06-14", chip: { kind: "ready", label: "Ready to send" } },
      { id: "w2", coupleNames: "Ada and Bo", eventDate: "2026-07-01", chip: { kind: "needs_details", label: "Needs details" } },
      {
        id: "w3",
        coupleNames: "Cy and Di",
        eventDate: "2026-08-09",
        chip: { kind: "blocked", label: "Blocked: second-shooter wedding" },
      },
    ],
  };

  it("shows a card per wedding with its names, date and the server's chip", async () => {
    serve(api, { "/events": events });
    renderWizard(api, "/wizard");

    expect(await screen.findByRole("heading", { name: "Choose a wedding" })).toBeInTheDocument();
    expect(screen.getByText("Pick the wedding you want to submit, or add a new one.")).toBeInTheDocument();
    const sarah = screen.getByRole("radio", { name: /Sarah and James/ }).closest("label");
    expect(sarah).toHaveTextContent("June 14, 2026");
    expect(sarah).toHaveTextContent("Ready to send");
    expect(screen.getByRole("radio", { name: /Ada and Bo/ }).closest("label")).toHaveTextContent("Needs details");
    expect(screen.getByRole("radio", { name: /Cy and Di/ }).closest("label")).toHaveTextContent(
      "Blocked: second-shooter wedding",
    );
  });

  it("keeps Continue off until a wedding is picked, then resumes it", async () => {
    serve(api, { "/events": events, "/events/w2/walkthrough": walkthrough(wizardAt("story")) });
    renderWizard(api, "/wizard");

    const next = await screen.findByRole("button", { name: "Continue" });
    expect(next).toBeDisabled();
    expect(screen.getByText("Pick a wedding to continue.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /Ada and Bo/ }));
    expect(next).toBeEnabled();
    await userEvent.click(next);
    await waitFor(() => expect(location(screen)).toBe("/wizard/w2/story"));
  });

  it("adds a wedding without creating anything yet", async () => {
    serve(api, { "/events": events });
    renderWizard(api, "/wizard");
    await userEvent.click(await screen.findByRole("link", { name: "Add a wedding" }));
    expect(location(screen)).toBe("/wizard/new/wedding");
    expect(await screen.findByLabelText("Couple names, as they should appear")).toHaveValue("");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("invites a first wedding when there are none", async () => {
    serve(api, { "/events": { events: [] } });
    renderWizard(api, "/wizard");
    expect(await screen.findByText("No weddings yet. Add one to start.")).toBeInTheDocument();
  });

  it("shows a load failure", async () => {
    serve(api, { "/events": new ApiError(500, "INTERNAL", "Something went wrong.") });
    renderWizard(api, "/wizard");
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
  });
});

describe("resuming", () => {
  it("lands on the server's first unfinished step, carrying its package", async () => {
    serve(api, {
      "/events/w1/walkthrough": walkthrough(wizardAt("photos")),
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("photos")),
      "/packages/pk1": { id: "pk1", eventId: "w1", publication: null, imageKeys: [], checklist: [], consent: {} },
      "/events/w1/images": { images: [] },
    });
    renderWizard(api, "/wizard/w1");
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/photos?package=pk1"));
  });

  it("lands on an early step with no package in the address", async () => {
    serve(api, {
      "/events/w1/walkthrough": walkthrough(wizardAt("permissions")),
      "/events/w1": storedEvent(),
    });
    renderWizard(api, "/wizard/w1");
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/permissions"));
    expect(await screen.findByRole("heading", { name: "Your gallery and permissions" })).toBeInTheDocument();
  });

  it("sends the old step-list address to the wizard, package and all", async () => {
    serve(api, {
      "/events/w1/walkthrough?package=pk2": walkthrough(wizardAt("track", { packageId: "pk2", submission: null })),
    });
    renderWizard(api, "/events/w1/submit?package=pk2");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/events/w1/walkthrough?package=pk2"));
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/track?package=pk2"));
  });

  it("says so when the wedding cannot be opened", async () => {
    serve(api, { "/events/w9/walkthrough": new ApiError(404, "NOT_FOUND", "No such event.") });
    renderWizard(api, "/wizard/w9");
    expect(await screen.findByRole("alert")).toHaveTextContent("No such event.");
  });

  it("sends an unknown step back to the resume point", async () => {
    serve(api, {
      "/events/w1/walkthrough": walkthrough(wizardAt("story")),
      "/events/w1": storedEvent(),
    });
    renderWizard(api, "/wizard/w1/nonsense");
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/story"));
  });
});

describe("the progress rail", () => {
  it("ticks the server's done steps, highlights the current one and links back only to done ones", async () => {
    serve(api, {
      "/events/w1/walkthrough": walkthrough(wizardAt("story")),
      "/events/w1": storedEvent(),
    });
    renderWizard(api, "/wizard/w1/story");

    const rail = await screen.findByRole("navigation", { name: "Progress" });
    expect(within(rail).getByRole("link", { name: /Wedding/ })).toHaveAttribute("href", "/wizard/w1/wedding");
    expect(within(rail).getByRole("link", { name: /Permissions/ })).toHaveTextContent("(done)");
    const current = within(rail).getByText("Story").closest("li");
    expect(current).toHaveAttribute("aria-current", "step");
    expect(within(rail).queryByRole("link", { name: /Story/ })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: /Outlet/ })).not.toBeInTheDocument();
  });

  it("holds the screens after the outlet when the rights gate is closed", async () => {
    const wizard = wizardAt("outlet", {
      blocked: { step: "outlet", reasons: ["The couple said no. It cannot be submitted unless they change their answer in writing."] },
    });
    serve(api, { "/events/w1/walkthrough?package=pk1": walkthrough(wizard) });
    renderWizard(api, "/wizard/w1/photos?package=pk1");

    expect(await screen.findByRole("heading", { name: "Sort out the permissions first" })).toBeInTheDocument();
    expect(screen.getByText(/The couple said no/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit permissions" })).toHaveAttribute(
      "href",
      "/wizard/w1/permissions?package=pk1",
    );
  });
});
