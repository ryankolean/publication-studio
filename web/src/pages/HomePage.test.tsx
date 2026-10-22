import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "../api/client.js";
import { createSession, type StorageLike } from "../auth/session.js";
import { SessionProvider } from "../session-context.js";
import { WELCOME } from "../wizard/guide.js";
import { CARD_ACTION, cardHref, HomePage, type WeddingCard } from "./HomePage.js";

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

const card = (overrides: Partial<WeddingCard> = {}): WeddingCard => ({
  id: "w1",
  coupleNames: "Sarah and James",
  eventDate: "2026-06-14",
  chip: { kind: "ready", label: "Ready to send", packageId: null },
  hasPackage: false,
  inProgress: false,
  ...overrides,
});

const submission = (status: string, responseDueAt: string | null = null) => ({
  id: `s-${status}-${responseDueAt ?? ""}`,
  eventId: "w1",
  coupleNames: "Sarah and James",
  publicationId: "pub-a",
  publicationName: "Outlet A",
  status,
  packageId: "pk1",
  queuedAt: null,
  sentAt: null,
  responseDueAt,
  outcomeAt: null,
  outcomeNotes: null,
  publishedUrl: null,
  daysRemaining: null,
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

const renderHome = () =>
  render(
    <MemoryRouter>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <HomePage />
      </SessionProvider>
    </MemoryRouter>,
  );

describe("HomePage", () => {
  it("welcomes a first-time photographer and offers her weddings", async () => {
    serve({ events: [card()] });
    renderHome();
    const welcome = await screen.findByRole("region", { name: "Welcome" });
    expect(welcome).toHaveTextContent("It never sends anything itself");
    expect(within(welcome).getAllByRole("listitem").map((item) => item.textContent)).toEqual(WELCOME.journey);
    expect(welcome).toHaveTextContent(WELCOME.closing);
    expect(screen.getByRole("link", { name: "Start this one: Sarah and James" })).toHaveAttribute("href", "/wizard/w1");
    expect(screen.getByText("Everything is in place. Choose an outlet when you are ready.")).toBeInTheDocument();
    expect(screen.getByText("June 14, 2026")).toBeInTheDocument();
    expect(screen.getByText("Ready to send")).toBeInTheDocument();
  });

  it("collapses the welcome once any wedding has had a submission, even a declined one", async () => {
    serve({ events: [card({ hasPackage: true, inProgress: false })] });
    renderHome();
    expect(await screen.findByRole("link", { name: "Start this one: Sarah and James" })).toHaveAttribute("href", "/wizard/w1");
    expect(screen.queryByRole("region", { name: "Welcome" })).toBeNull();
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/help");
  });

  it("tells her to carry on with a wedding she is partway through", async () => {
    serve({ events: [card({ hasPackage: true, inProgress: true })] });
    renderHome();
    expect(await screen.findByRole("link", { name: "Carry on: Sarah and James" })).toHaveAttribute("href", "/wizard/w1");
    expect(screen.getByText("You are partway through. It opens where you left off.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Start this one: Sarah and James" })).toBeNull();
  });

  it("opens a published wedding on its own submission", async () => {
    serve({ events: [card({ chip: { kind: "published", label: "Published at Outlet A", packageId: "pk3" }, hasPackage: true })] });
    renderHome();
    expect(await screen.findByRole("link", { name: "See how it went: Sarah and James" })).toHaveAttribute(
      "href",
      "/wizard/w1?package=pk3",
    );
    expect(screen.getByText("Published. Nothing more to do here.")).toBeInTheDocument();
  });

  it("gives every status its own button and next line", () => {
    for (const [kind, action] of Object.entries(CARD_ACTION)) {
      expect(action.button, kind).not.toBe("");
      expect(action.next, kind).toMatch(/\.$/);
    }
    expect(cardHref({ id: "w9", chip: { kind: "live", packageId: "pk8" } })).toBe("/wizard/w9?package=pk8");
    expect(cardHref({ id: "w9", chip: { kind: "blocked", packageId: null } })).toBe("/wizard/w9");
  });

  it("sums the queue in one line and hides it when there is nothing to say", async () => {
    serve(
      { events: [card({ hasPackage: true })] },
      { submissions: [submission("ready"), submission("queued"), submission("sent", "2026-11-03T12:00:00Z")] },
    );
    renderHome();
    expect(await screen.findByText("2 ready to send, 1 waiting on a reply, earliest due November 3, 2026.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the queue" })).toHaveAttribute("href", "/queue");
  });

  it("says nothing about the queue when it is empty", async () => {
    serve({ events: [card()] });
    renderHome();
    await screen.findByRole("region", { name: "Welcome" });
    expect(screen.queryByRole("link", { name: "Open the queue" })).toBeNull();
  });

  it("with no weddings at all shows the welcome and Add a wedding", async () => {
    serve({ events: [] });
    renderHome();
    expect(await screen.findByRole("region", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a wedding" })).toHaveAttribute("href", "/wizard/new/wedding");
    expect(screen.getByText("No weddings yet. Add one to begin.")).toBeInTheDocument();
  });

  it("shows a load failure in plain words", async () => {
    serve(new ApiError(500, "SERVER", "Something went wrong on our side."));
    renderHome();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong on our side.");
  });
});
