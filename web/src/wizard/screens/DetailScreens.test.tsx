import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../../api/client.js";
import { GUIDE } from "../guide.js";
import {
  fakeApi,
  location,
  renderWizard,
  serve,
  storedEvent,
  walkthrough,
  wizardAt,
  type FakeApi,
} from "../test-utils.js";

let api: FakeApi;

beforeEach(() => {
  api = fakeApi();
});

const continueButton = () => screen.getByRole("button", { name: "Continue" });

describe("[wedding] a new wedding", () => {
  it("says what is missing, one thing at a time, until it can continue", async () => {
    renderWizard(api, "/wizard/new/wedding");
    expect(await screen.findByRole("heading", { name: "The wedding" })).toBeInTheDocument();
    expect(screen.getByText(GUIDE.wedding.lead)).toBeInTheDocument();

    expect(continueButton()).toBeDisabled();
    expect(screen.getByText("Add the couple's names to continue.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Couple names, as they should appear"), "Sarah and James");
    expect(screen.getByText("Add the wedding date to continue.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Wedding date"), "2026-06-14");
    expect(screen.getByText("Add the venue or the city to continue.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("City"), "Detroit");
    expect(continueButton()).toBeEnabled();
    expect(screen.queryByText(/to continue\./)).not.toBeInTheDocument();
  });

  it("creates the wedding on Continue and moves to permissions", async () => {
    api.post.mockResolvedValueOnce({ id: "w7" });
    serve(api, { "/events/w7/walkthrough": walkthrough(wizardAt("permissions")), "/events/w7": storedEvent({ id: "w7" }) });
    renderWizard(api, "/wizard/new/wedding");

    await userEvent.type(await screen.findByLabelText("Couple names, as they should appear"), "Sarah and James");
    await userEvent.type(screen.getByLabelText("Wedding date"), "2026-06-14");
    await userEvent.type(screen.getByLabelText("Venue"), "The Barn");
    await userEvent.click(screen.getByLabelText("Reads as a destination wedding"));
    await userEvent.click(continueButton());

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/events", {
        coupleNames: "Sarah and James",
        eventDate: "2026-06-14",
        venueName: "The Barn",
        city: null,
        state: null,
        country: null,
        isDestination: true,
      }),
    );
    await waitFor(() => expect(location(screen)).toBe("/wizard/w7/permissions"));
  });

  it("shows the server's refusal", async () => {
    api.post.mockRejectedValueOnce(
      new ApiError(400, "VALIDATION", "Some fields need attention.", [
        { field: "eventDate", message: "Enter a real date as yyyy-mm-dd." },
      ]),
    );
    renderWizard(api, "/wizard/new/wedding");
    await userEvent.type(await screen.findByLabelText("Couple names, as they should appear"), "A and B");
    await userEvent.type(screen.getByLabelText("Wedding date"), "2026-06-14");
    await userEvent.type(screen.getByLabelText("City"), "Detroit");
    await userEvent.click(continueButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a real date as yyyy-mm-dd.");
  });
});

describe("[wedding] an existing wedding", () => {
  it("prefills the record and sends all of it back with the changes", async () => {
    serve(api, {
      "/events/w1/walkthrough": walkthrough(wizardAt("permissions")),
      "/events/w1": storedEvent(),
    });
    api.patch.mockResolvedValueOnce(storedEvent());
    renderWizard(api, "/wizard/w1/wedding");

    const names = await screen.findByLabelText("Couple names, as they should appear");
    expect(names).toHaveValue("Sarah and James");
    await userEvent.clear(screen.getByLabelText("Venue"));
    await userEvent.type(screen.getByLabelText("Venue"), "The Mill");
    await userEvent.click(continueButton());

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [path, body] = api.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/events/w1");
    expect(body).toMatchObject({
      venueName: "The Mill",
      // Fields this screen does not show still travel, so the full-replace PATCH keeps them.
      heroPicks: "The veil shot",
      priorExposure: { ownBlog: true, igPosted: false, priorPubs: [] },
      vendorCredits: [{ role: "Florist", businessName: "Stems", website: null, instagram: "stems" }],
    });
    expect(body).not.toHaveProperty("galleryUrl");
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/permissions"));
  });
});

describe("[permissions]", () => {
  const open = async (event = storedEvent()) => {
    serve(api, {
      "/events/w1/walkthrough": walkthrough(wizardAt("permissions")),
      "/events/w1": event,
    });
    renderWizard(api, "/wizard/w1/permissions");
    await screen.findByRole("heading", { name: "Your gallery and permissions" });
  };

  it("needs a gallery link when none is on file", async () => {
    await open(storedEvent({ hasGalleryUrl: false }));
    expect(screen.getByText(GUIDE.permissions.lead)).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText("Add the gallery link to continue.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Gallery link"), "https://gallery.example.com/x");
    expect(continueButton()).toBeEnabled();
  });

  it("says a link is on file, never shows it, and offers to replace it", async () => {
    await open();
    expect(screen.getByText("On file")).toBeInTheDocument();
    expect(screen.getByLabelText("Replace the gallery link")).toHaveValue("");
    expect(continueButton()).toBeEnabled();
  });

  it("reflects the stored answers in the two questions", async () => {
    await open(storedEvent({ rightsStatus: "unverified", consentStatus: "declined" }));
    const rights = screen.getByRole("group", { name: "Were you the lead photographer under your own contract?" });
    expect(rights).toHaveTextContent("No, I was the second shooter");
    expect(screen.getByRole("radio", { name: "Not sure" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "No" })).toBeChecked();
  });

  it("explains calmly what a second-shooter wedding means and still lets her continue", async () => {
    await open();
    await userEvent.click(screen.getByRole("radio", { name: "No, I was the second shooter" }));
    expect(
      screen.getByText(
        "Second-shooter weddings cannot be submitted under your name. The tool can help you ask the lead photographer for a credit instead.",
      ),
    ).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();
  });

  it("asks for the couple's limits when they agreed with limits", async () => {
    await open();
    expect(screen.queryByPlaceholderText("First names only")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Yes, with limits" }));
    expect(screen.getByPlaceholderText("First names only")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("No photos of the flower girl")).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText("Write down the couple's limits to continue.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("How their names should appear"), "First names only");
    expect(continueButton()).toBeEnabled();
  });

  it("saves the answers, a new link and the limits, then moves to the story", async () => {
    await open();
    api.patch.mockResolvedValueOnce(storedEvent());
    await userEvent.type(screen.getByLabelText("Replace the gallery link"), " https://gallery.example.com/new ");
    await userEvent.click(screen.getByRole("radio", { name: "Yes, with limits" }));
    await userEvent.type(screen.getByLabelText("What is off limits"), "No photos of the flower girl");
    await userEvent.click(continueButton());

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch.mock.calls[0]?.[1]).toMatchObject({
      galleryUrl: "https://gallery.example.com/new",
      rightsStatus: "own_contract",
      consentStatus: "granted_limited",
      nameDisplay: null,
      consentNotes: "No photos of the flower girl",
    });
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/story"));
  });

  it("clears stored limits when the answer is a plain yes", async () => {
    await open(storedEvent({ consentStatus: "granted_limited", nameDisplay: "First names only", consentNotes: "No kids" }));
    api.patch.mockResolvedValueOnce(storedEvent());
    await userEvent.click(screen.getByRole("radio", { name: "Yes" , checked: false }));
    await userEvent.click(continueButton());
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch.mock.calls[0]?.[1]).toMatchObject({ consentStatus: "granted", nameDisplay: null, consentNotes: null });
  });
});

describe("[story]", () => {
  const open = async (event = storedEvent()) => {
    serve(api, {
      "/events/w1/walkthrough": walkthrough(wizardAt("story")),
      "/events/w1": event,
    });
    renderWizard(api, "/wizard/w1/story");
    await screen.findByRole("heading", { name: GUIDE.story.title });
  };

  it("needs a standout detail or a story", async () => {
    await open(storedEvent({ uniqueAngle: null, coupleStory: null }));
    expect(screen.getByText(GUIDE.story.lead)).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText("Add what made this wedding stand out to continue.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("What made this wedding stand out?"), "Vows read by the grandmother.");
    expect(continueButton()).toBeEnabled();
  });

  it("needs at least one complete vendor, and says when a row is half filled", async () => {
    await open(storedEvent({ vendorCredits: [] }));
    expect(screen.getByText("Add at least one vendor to continue.")).toBeInTheDocument();
    expect(screen.getByText("Outlets will not publish without complete credits.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Role, vendor 1"), "Florist");
    expect(screen.getByText("Each vendor needs a role and a business name.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Business, vendor 1"), "Stems");
    expect(continueButton()).toBeEnabled();
  });

  it("adds vendor rows, drops blank ones, and saves the story", async () => {
    await open();
    api.patch.mockResolvedValueOnce(storedEvent());
    await userEvent.click(screen.getByRole("button", { name: "Add a vendor" }));
    await userEvent.type(screen.getByLabelText("Role, vendor 2"), "Venue");
    await userEvent.type(screen.getByLabelText("Business, vendor 2"), "The Barn");
    await userEvent.type(screen.getByLabelText("Instagram, vendor 2"), "@thebarn");
    await userEvent.click(screen.getByRole("button", { name: "Add a vendor" }));
    await userEvent.type(screen.getByLabelText("How they met, or anything the couple shared"), "Met at a bookshop.");
    await userEvent.click(continueButton());

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch.mock.calls[0]?.[1]).toMatchObject({
      uniqueAngle: "A ceremony on a frozen lake.",
      coupleStory: "Met at a bookshop.",
      vendorCredits: [
        { role: "Florist", businessName: "Stems", website: null, instagram: "stems" },
        { role: "Venue", businessName: "The Barn", website: null, instagram: "@thebarn" },
      ],
    });
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/look"));
  });

  it("removes a vendor row", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Add a vendor" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove vendor 2" }));
    expect(screen.queryByLabelText("Role, vendor 2")).not.toBeInTheDocument();
  });
});
