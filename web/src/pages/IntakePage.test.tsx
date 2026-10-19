import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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

let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn() };
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
});
