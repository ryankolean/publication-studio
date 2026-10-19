import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IntakePage } from "./IntakePage.js";
import { SessionProvider } from "../session-context.js";
import { ApiError, type ApiClient } from "../api/client.js";
import { createSession, type StorageLike } from "../auth/session.js";

function fakeStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, v) => void entries.set(k, v),
    removeItem: (k) => void entries.delete(k),
  };
}

let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn(), patch: vi.fn() };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <IntakePage />
      </SessionProvider>
    </MemoryRouter>,
  );

const submit = () => userEvent.click(screen.getByRole("button", { name: "Save event" }));

const lastPayload = () => api.post.mock.calls[0]?.[1] as Record<string, any>;

describe("the ten intake sections are present", () => {
  it("asks for everything the design doc lists", () => {
    renderPage();
    for (const label of [
      "Couple names",
      "Event date",
      "Venue",
      "City",
      "Gallery link",
      "Rights",
      "Couple consent",
      "Name display preference",
      "Consent notes",
      "Couple story",
      "What made this event unique",
      "Hero image picks",
      "Video link",
      "Dream outlet and alternates",
    ]) {
      expect(screen.getByLabelText(label), label).toBeInTheDocument();
    }
    expect(screen.getByLabelText("This reads as a destination wedding")).toBeInTheDocument();
    expect(screen.getByLabelText("Posted on my own blog")).toBeInTheDocument();
  });
});

describe("submitting", () => {
  it("posts the entered event", async () => {
    api.post.mockResolvedValueOnce({ id: "w1" });
    renderPage();

    await userEvent.type(screen.getByLabelText("Couple names"), "Sarah and James");
    await userEvent.type(screen.getByLabelText("Event date"), "2026-06-14");
    await submit();

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/events", expect.anything()));
    expect(lastPayload()).toMatchObject({
      coupleNames: "Sarah and James",
      eventDate: "2026-06-14",
    });
  });

  it("defaults rights and consent to unverified", async () => {
    api.post.mockResolvedValueOnce({ id: "w1" });
    renderPage();
    await userEvent.type(screen.getByLabelText("Couple names"), "A and B");
    await submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(lastPayload()["rightsStatus"]).toBe("unverified");
    expect(lastPayload()["consentStatus"]).toBe("unverified");
  });

  it("sends the chosen rights status", async () => {
    api.post.mockResolvedValueOnce({ id: "w1" });
    renderPage();
    await userEvent.selectOptions(screen.getByLabelText("Rights"), "second_shooter");
    await userEvent.type(screen.getByLabelText("Couple names"), "A and B");
    await submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(lastPayload()["rightsStatus"]).toBe("second_shooter");
  });

  it("splits comma separated style tags into a list", async () => {
    api.post.mockResolvedValueOnce({ id: "w1" });
    renderPage();
    await userEvent.type(screen.getByLabelText("Couple names"), "A and B");
    await userEvent.type(screen.getByLabelText("Style tags, comma separated"), "editorial, destination");
    await submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(lastPayload()["styleTags"]).toEqual(["editorial", "destination"]);
  });

  it("sends prior exposure as the documented object", async () => {
    api.post.mockResolvedValueOnce({ id: "w1" });
    renderPage();
    await userEvent.type(screen.getByLabelText("Couple names"), "A and B");
    await userEvent.click(screen.getByLabelText("Posted on my own blog"));
    await submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(lastPayload()["priorExposure"]).toEqual({
      ownBlog: true,
      igPosted: false,
      priorPubs: [],
    });
  });

  it("drops a vendor row the user never filled in", async () => {
    api.post.mockResolvedValueOnce({ id: "w1" });
    renderPage();
    await userEvent.type(screen.getByLabelText("Couple names"), "A and B");
    await submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(lastPayload()["vendorCredits"]).toEqual([]);
  });

  it("sends a vendor row the user did fill in", async () => {
    api.post.mockResolvedValueOnce({ id: "w1" });
    renderPage();
    await userEvent.type(screen.getByLabelText("Couple names"), "A and B");
    await userEvent.type(screen.getByLabelText("Role"), "Florist");
    await userEvent.type(screen.getByLabelText("Business name"), "Stems");
    await submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(lastPayload()["vendorCredits"]).toEqual([
      { role: "Florist", businessName: "Stems", website: undefined, instagram: undefined },
    ]);
  });

  it("adds another vendor row on request", async () => {
    renderPage();
    expect(screen.getAllByLabelText("Role")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Add another vendor" }));
    expect(screen.getAllByLabelText("Role")).toHaveLength(2);
  });
});

describe("server validation is what the form renders", () => {
  it("shows a field error against the field it belongs to", async () => {
    api.post.mockRejectedValueOnce(
      new ApiError(400, "VALIDATION", "Some fields need attention.", [
        { field: "coupleNames", message: "This field is required." },
      ]),
    );
    renderPage();
    await submit();

    expect(await screen.findByTestId("error-coupleNames")).toHaveTextContent(
      "This field is required.",
    );
  });

  it("shows a vendor row error against that row", async () => {
    api.post.mockRejectedValueOnce(
      new ApiError(400, "VALIDATION", "Some fields need attention.", [
        { field: "vendorCredits.0.businessName", message: "This field is required." },
      ]),
    );
    renderPage();
    await submit();

    expect(await screen.findByTestId("error-vendor-name-0")).toHaveTextContent(
      "This field is required.",
    );
  });

  it("shows the summary message too", async () => {
    api.post.mockRejectedValueOnce(
      new ApiError(400, "VALIDATION", "Some fields need attention.", []),
    );
    renderPage();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Some fields need attention.");
  });

  it("clears previous errors on the next submit", async () => {
    api.post
      .mockRejectedValueOnce(
        new ApiError(400, "VALIDATION", "Some fields need attention.", [
          { field: "coupleNames", message: "This field is required." },
        ]),
      )
      .mockResolvedValueOnce({ id: "w1" });

    renderPage();
    await submit();
    await screen.findByTestId("error-coupleNames");

    await userEvent.type(screen.getByLabelText("Couple names"), "A and B");
    await submit();
    await waitFor(() => expect(screen.queryByTestId("error-coupleNames")).not.toBeInTheDocument());
  });

  it("reports a non-api failure generically", async () => {
    api.post.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
  });
});

describe("the gallery link is presented as a credential", () => {
  it("tells the user it is never sent back to the page", () => {
    renderPage();
    expect(screen.getByText(/treated as a credential/i)).toBeInTheDocument();
  });

  it("leaves the gallery field out of a new event when it is blank", async () => {
    api.post.mockResolvedValueOnce({ id: "w1" });
    renderPage();
    await userEvent.type(screen.getByLabelText("Couple names"), "A and B");
    await submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect("galleryUrl" in lastPayload()).toBe(false);
  });
});

describe("editing an event", () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    id: "w1",
    slug: "sarah-and-james-2026",
    coupleNames: "Sarah and James",
    eventDate: "2026-06-14",
    venueName: "The Barn",
    city: "Detroit",
    state: "MI",
    country: null,
    styleTags: ["editorial", "garden"],
    uniqueAngle: "A ferry ceremony.",
    rightsStatus: "own_contract",
    consentStatus: "granted_limited",
    consentNotes: "No guest faces",
    nameDisplay: "First names only",
    coupleStory: "They met at a bookshop.",
    isDestination: true,
    heroPicks: "12, 40",
    videoUrl: null,
    targetOutletNotes: null,
    priorExposure: { ownBlog: true, igPosted: false, priorPubs: ["Somewhere"] },
    hasGalleryUrl: true,
    gate: { allowed: true },
    vendorCredits: [{ role: "Florist", businessName: "Stems", website: null, instagram: "stems" }],
    ...overrides,
  });

  const renderEdit = (state: unknown = null) =>
    render(
      <MemoryRouter initialEntries={[{ pathname: "/events/w1/edit", state }]}>
        <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
          <Routes>
            <Route path="/events/:id/edit" element={<IntakePage />} />
            <Route path="/events/:id" element={<p>Event page stub</p>} />
            <Route path="/events/:id/submit" element={<p>Walkthrough stub</p>} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );

  const save = () => userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const patched = () => api.patch.mock.calls[0]?.[1] as Record<string, any>;

  it("loads the stored event into the form", async () => {
    api.get.mockResolvedValueOnce(stored());
    renderEdit();

    expect(await screen.findByRole("heading", { name: "Edit event" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/events/w1");
    expect(screen.getByLabelText("Couple names")).toHaveValue("Sarah and James");
    expect(screen.getByLabelText("Event date")).toHaveValue("2026-06-14");
    expect(screen.getByLabelText("Venue")).toHaveValue("The Barn");
    expect(screen.getByLabelText("Country")).toHaveValue("");
    expect(screen.getByLabelText("Rights")).toHaveValue("own_contract");
    expect(screen.getByLabelText("Couple consent")).toHaveValue("granted_limited");
    expect(screen.getByLabelText("Consent notes")).toHaveValue("No guest faces");
    expect(screen.getByLabelText("Style tags, comma separated")).toHaveValue("editorial, garden");
    expect(screen.getByLabelText("This reads as a destination wedding")).toBeChecked();
    expect(screen.getByLabelText("Posted on my own blog")).toBeChecked();
    expect(screen.getByLabelText("Posted to Instagram")).not.toBeChecked();
    expect(screen.getByLabelText("Previously submitted or published, comma separated")).toHaveValue("Somewhere");
    expect(screen.getByLabelText("Business name")).toHaveValue("Stems");
    expect(screen.getByLabelText("Instagram")).toHaveValue("stems");
  });

  it("never prefills the gallery link, and says one is on file", async () => {
    api.get.mockResolvedValueOnce(stored());
    renderEdit();
    expect(await screen.findByLabelText("Gallery link")).toHaveValue("");
    expect(
      screen.getByText("A gallery link is on file; paste a new one only to replace it."),
    ).toBeInTheDocument();
  });

  it("does not claim a gallery link that is not on file", async () => {
    api.get.mockResolvedValueOnce(stored({ hasGalleryUrl: false }));
    renderEdit();
    await screen.findByLabelText("Gallery link");
    expect(screen.queryByText(/A gallery link is on file/)).not.toBeInTheDocument();
  });

  it("saves the rest with PATCH and never sends the gallery field unless typed", async () => {
    api.get.mockResolvedValueOnce(stored());
    api.patch.mockResolvedValueOnce(stored());
    renderEdit();
    await screen.findByLabelText("Couple names");

    await save();

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/events/w1", expect.anything()));
    expect(api.post).not.toHaveBeenCalled();
    expect("galleryUrl" in patched()).toBe(false);
    expect(patched()).toMatchObject({
      coupleNames: "Sarah and James",
      eventDate: "2026-06-14",
      venueName: "The Barn",
      rightsStatus: "own_contract",
      consentStatus: "granted_limited",
      styleTags: ["editorial", "garden"],
      isDestination: true,
      priorExposure: { ownBlog: true, igPosted: false, priorPubs: ["Somewhere"] },
      vendorCredits: [{ role: "Florist", businessName: "Stems", website: undefined, instagram: "stems" }],
    });
    expect(await screen.findByText("Event page stub")).toBeInTheDocument();
  });

  it("sends the edits that were made", async () => {
    api.get.mockResolvedValueOnce(stored());
    api.patch.mockResolvedValueOnce(stored());
    renderEdit();
    const names = await screen.findByLabelText("Couple names");

    await userEvent.clear(names);
    await userEvent.type(names, "Ada and Bo");
    await userEvent.selectOptions(screen.getByLabelText("Couple consent"), "granted");
    await save();

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(patched()).toMatchObject({ coupleNames: "Ada and Bo", consentStatus: "granted" });
  });

  it("sends a gallery link only once one is typed", async () => {
    api.get.mockResolvedValueOnce(stored());
    api.patch.mockResolvedValueOnce(stored());
    renderEdit();
    await userEvent.type(await screen.findByLabelText("Gallery link"), "https://new.example.com/g");
    await save();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(patched()["galleryUrl"]).toBe("https://new.example.com/g");
  });

  it("returns to the page that sent it here", async () => {
    api.get.mockResolvedValueOnce(stored());
    api.patch.mockResolvedValueOnce(stored());
    renderEdit({ returnTo: "/events/w1/submit" });
    await screen.findByLabelText("Couple names");
    await save();
    expect(await screen.findByText("Walkthrough stub")).toBeInTheDocument();
  });

  it("renders the server's field errors from the edit", async () => {
    api.get.mockResolvedValueOnce(stored());
    api.patch.mockRejectedValueOnce(
      new ApiError(400, "VALIDATION", "Some fields need attention.", [
        { field: "eventDate", message: "Enter a real date as yyyy-mm-dd." },
      ]),
    );
    renderEdit();
    await screen.findByLabelText("Couple names");
    await save();
    expect(await screen.findByTestId("error-eventDate")).toHaveTextContent("Enter a real date");
  });

  it("surfaces a load failure", async () => {
    api.get.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "No such event."));
    renderEdit();
    expect(await screen.findByRole("alert")).toHaveTextContent("No such event.");
  });
});
