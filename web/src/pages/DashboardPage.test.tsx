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

const submission = (overrides: Record<string, unknown> = {}) => ({
  id: "s1",
  eventId: "w1",
  coupleNames: "Sarah and James",
  publicationId: "pub-loverly",
  publicationName: "Loverly",
  status: "ready",
  packageId: "pk1",
  queuedAt: null,
  sentAt: null,
  responseDueAt: null,
  outcomeAt: null,
  outcomeNotes: null,
  publishedUrl: null,
  daysRemaining: null,
  ...overrides,
});

/** Each path answers on its own; an Error answer is thrown. */
function serve(events: unknown, submissions: unknown = { submissions: [] }) {
  api.get.mockImplementation(async (path: string) => {
    const answer = path === "/events" ? events : path === "/submissions" ? submissions : undefined;
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new ApiError(404, "NOT_FOUND", `unexpected ${path}`);
    return answer;
  });
}

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
    serve({ events: [] });
    renderPage();
    expect(await screen.findByText(/No events yet/)).toBeInTheDocument();
  });

  it("lists an event with its date and place", async () => {
    serve({ events: [event()] });
    renderPage();
    expect(await screen.findByText("Sarah and James")).toBeInTheDocument();
    expect(screen.getByText(/2026-06-14/)).toHaveTextContent("The Barn");
  });

  it("links each event to its curation board", async () => {
    serve({ events: [event()] });
    renderPage();
    expect(await screen.findByRole("link", { name: "Sarah and James" })).toHaveAttribute(
      "href",
      "/events/w1",
    );
  });

  it("links each event to its submission walkthrough", async () => {
    serve({ events: [event(), event({ id: "w2", coupleNames: "Ada and Bo" })] });
    renderPage();
    expect(await screen.findByRole("link", { name: "Submit Sarah and James" })).toHaveAttribute(
      "href",
      "/events/w1/submit",
    );
    expect(screen.getByRole("link", { name: "Submit Ada and Bo" })).toHaveAttribute(
      "href",
      "/events/w2/submit",
    );
  });

  it("shows a ready badge for an event that clears the gate", async () => {
    serve({ events: [event()] });
    renderPage();
    expect(await screen.findByText("Ready to package")).toBeInTheDocument();
  });

  it("shows the remedies for a blocked event", async () => {
    serve({
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
    serve({
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
    serve({ events: [event({ hasGalleryUrl: false })] });
    renderPage();
    expect(await screen.findByText("No gallery link on file.")).toBeInTheDocument();
  });

  it("surfaces a load failure instead of showing an empty inventory", async () => {
    serve(new ApiError(500, "INTERNAL", "Something went wrong."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    expect(screen.queryByText(/No events yet/)).not.toBeInTheDocument();
  });
});

describe("the action strip", () => {
  const strip = () => screen.findByRole("region", { name: "Action needed" });

  it("counts what is ready to send and what is live, with the earliest due date", async () => {
    serve(
      { events: [] },
      {
        submissions: [
          submission({ id: "a", status: "sent", responseDueAt: "2026-11-20T12:00:00Z" }),
          submission({ id: "b", status: "sent", responseDueAt: "2026-10-30T12:00:00Z" }),
          submission({ id: "c", status: "sent", responseDueAt: null }),
          submission({ id: "d", status: "ready" }),
          submission({ id: "e", status: "queued" }),
          submission({ id: "f", status: "declined" }),
        ],
      },
    );
    renderPage();

    const region = await strip();
    expect(region).toHaveTextContent("Ready to send: 2");
    expect(region).toHaveTextContent("Live: 3");
    expect(region).toHaveTextContent("Earliest due: 2026-10-30");
    expect(api.get.mock.calls.filter(([path]) => path === "/submissions")).toHaveLength(1);
  });

  it("says when nothing is due", async () => {
    serve({ events: [] }, { submissions: [submission({ status: "ready" })] });
    renderPage();
    expect(await strip()).toHaveTextContent("Earliest due: none");
  });

  it("links to the queue", async () => {
    serve({ events: [] });
    renderPage();
    const region = await strip();
    expect(region.querySelector("a")).toHaveAttribute("href", "/queue");
  });

  it("keeps the inventory when the queue cannot be read", async () => {
    serve({ events: [event()] }, new ApiError(500, "INTERNAL", "Something went wrong."));
    renderPage();
    expect(await screen.findByText("Sarah and James")).toBeInTheDocument();
    expect(await screen.findByText("Could not load the queue.")).toBeInTheDocument();
  });
});
