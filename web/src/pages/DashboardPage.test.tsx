import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardPage, type EventSummary } from "./DashboardPage.js";
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

const event = (overrides: Partial<EventSummary> = {}): EventSummary => ({
  id: "w1",
  slug: "sarah-and-james-2026",
  coupleNames: "Sarah and James",
  eventDate: "2026-06-14",
  venueName: "The Barn",
  city: "Detroit",
  state: "MI",
  hasGalleryUrl: true,
  gate: { allowed: true },
  ...overrides,
});

let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn() };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <DashboardPage />
      </SessionProvider>
    </MemoryRouter>,
  );

describe("DashboardPage", () => {
  it("invites the first entry when the inventory is empty", async () => {
    api.get.mockResolvedValueOnce({ events: [] });
    renderPage();
    expect(await screen.findByText(/No events yet/)).toBeInTheDocument();
  });

  it("lists an event with its date and place", async () => {
    api.get.mockResolvedValueOnce({ events: [event()] });
    renderPage();
    expect(await screen.findByText("Sarah and James")).toBeInTheDocument();
    expect(screen.getByText(/2026-06-14/)).toHaveTextContent("The Barn");
  });

  it("shows a ready badge for an event that clears the gate", async () => {
    api.get.mockResolvedValueOnce({ events: [event()] });
    renderPage();
    expect(await screen.findByText("Ready to package")).toBeInTheDocument();
  });

  it("shows the remedies for a blocked event", async () => {
    api.get.mockResolvedValueOnce({
      events: [
        event({
          gate: {
            allowed: false,
            code: "RIGHTS_BLOCKED",
            route: "submission",
            reasons: [
              { code: "CONSENT_UNVERIFIED", field: "consent_status", remedy: "Record the couple's consent." },
            ],
          },
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Record the couple's consent.")).toBeInTheDocument();
  });

  it("marks a second-shooter event as credit recovery only", async () => {
    api.get.mockResolvedValueOnce({
      events: [
        event({
          gate: {
            allowed: false,
            code: "RIGHTS_BLOCKED",
            route: "credit_recovery",
            reasons: [
              { code: "RIGHTS_SECOND_SHOOTER", field: "rights_status", remedy: "Log a credit request instead." },
            ],
          },
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText("Credit recovery only")).toBeInTheDocument();
  });

  it("flags an event with no gallery link", async () => {
    api.get.mockResolvedValueOnce({ events: [event({ hasGalleryUrl: false })] });
    renderPage();
    expect(await screen.findByText("No gallery link on file.")).toBeInTheDocument();
  });

  it("surfaces a load failure instead of showing an empty inventory", async () => {
    api.get.mockRejectedValueOnce(new ApiError(500, "INTERNAL", "Something went wrong."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    expect(screen.queryByText(/No events yet/)).not.toBeInTheDocument();
  });
});
