import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../api/client.js";
import { fakeApi, location, renderWizard, serve, storedEvent, walkthrough, wizardAt, type FakeApi } from "./test-utils.js";

let api: FakeApi;

beforeEach(() => {
  api = fakeApi();
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

  it("says so when the wedding cannot be opened", async () => {
    serve(api, { "/events/w9/walkthrough": new ApiError(404, "NOT_FOUND", "That wedding could not be found.") });
    renderWizard(api, "/wizard/w9");
    expect(await screen.findByRole("alert")).toHaveTextContent("That wedding could not be found.");
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
