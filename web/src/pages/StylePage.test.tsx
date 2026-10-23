import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../api/client.js";
import { createSession, type StorageLike } from "../auth/session.js";
import { SessionProvider } from "../session-context.js";
import type { ProfileBody } from "../style/tags.js";
import { StylePage } from "./StylePage.js";

function fakeStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, v) => void entries.set(k, v),
    removeItem: (k) => void entries.delete(k),
  };
}

let api: Record<"get" | "post" | "put" | "delete", ReturnType<typeof vi.fn>>;

const profile = (overrides: Partial<ProfileBody> = {}): ProfileBody => ({
  tagged: 2,
  categories: [
    { category: "landscape_venue", tags: [{ id: "lakefront", weddings: 1 }] },
    { category: "aesthetic", tags: [{ id: "romantic", weddings: 2 }] },
  ],
  weddings: [
    { id: "e1", coupleNames: "Ada and Bo", eventDate: "2026-01-31", secondShooter: false, confirmed: 2, suggested: 1 },
    { id: "e2", coupleNames: "Cy and Di", eventDate: "2025-07-04", secondShooter: true, confirmed: 0, suggested: 0 },
  ],
  features: [
    {
      id: "f1",
      publicationId: "pub-known",
      outletName: "Known Weddings",
      eventId: "e1",
      coupleNames: "Ada and Bo",
      featureUrl: "https://known.example.com/ada-bo",
      publishedOn: "2026-03",
      role: "lead",
      notes: null,
    },
  ],
  ...overrides,
});

function serve(body: ProfileBody | (() => ProfileBody) = profile()) {
  api.get.mockImplementation(async (path: string) => {
    if (path === "/style/profile") return typeof body === "function" ? body() : body;
    if (path === "/publications") return { publications: [{ id: "pub-known", name: "Known Weddings" }] };
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const session = createSession(fakeStorage());
  session.signIn({ accessToken: "a", refreshToken: "r", user: { id: "u1", email: "p@example.com", name: "P", role: "photographer" } });
  return render(
    <MemoryRouter>
      <SessionProvider session={session} api={api as unknown as ApiClient}>
        <StylePage />
      </SessionProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
});

describe("StylePage", () => {
  it("shows her style from confirmed tags, with counts", async () => {
    serve();
    renderPage();
    expect(await screen.findByText("From 2 of your weddings. Weddings where you were the second shooter are not counted.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Style" })).toHaveTextContent("Romantic, 2 weddings");
    expect(screen.getByRole("list", { name: "Setting and venue" })).toHaveTextContent("Lakefront, 1 wedding");
  });

  it("links each wedding to its look, and says which are not counted", async () => {
    serve();
    renderPage();
    expect(await screen.findByRole("link", { name: "Tag the look of Ada and Bo" })).toHaveAttribute("href", "/wizard/e1/look");
    expect(screen.getByText("January 31, 2026, 2 kept, 1 to answer")).toBeInTheDocument();
    expect(screen.getByText("July 4, 2025, 0 kept, second shooter, not counted")).toBeInTheDocument();
  });

  it("invites her to tag a wedding when nothing is kept yet", async () => {
    serve(profile({ tagged: 0, categories: [] }));
    renderPage();
    expect(await screen.findByText("Keep a few tags on one of your weddings and your style shows up here.")).toBeInTheDocument();
  });

  it("lists past features with their month, wedding and link", async () => {
    serve();
    renderPage();
    expect(await screen.findByText("March 2026, Ada and Bo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See the feature" })).toHaveAttribute("href", "https://known.example.com/ada-bo");
  });

  it("adds a feature at an outlet she types, holding Save until it is complete", async () => {
    serve(profile({ features: [] }));
    api.post.mockResolvedValue({ feature: {} });
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a feature" });
    const save = within(form).getByRole("button", { name: "Save feature" });
    expect(save).toBeDisabled();
    expect(within(form).getByText("Choose the outlet.")).toBeInTheDocument();

    await userEvent.selectOptions(within(form).getByLabelText("Outlet"), "another");
    await userEvent.type(within(form).getByLabelText("Outlet name"), "Old Blog");
    await userEvent.selectOptions(within(form).getByLabelText("Month"), "05");
    expect(within(form).getByText("Pick both the month and the year, or neither.")).toBeInTheDocument();
    await userEvent.selectOptions(within(form).getByLabelText("Year"), "2024");
    await userEvent.click(within(form).getByRole("checkbox", { name: "I was the second shooter" }));
    await userEvent.click(save);

    expect(api.post).toHaveBeenCalledWith("/style/features", {
      publicationId: null,
      outletName: "Old Blog",
      eventId: null,
      featureUrl: null,
      publishedOn: "2024-05",
      role: "second_shooter",
      notes: null,
    });
  });

  it("edits and removes a feature", async () => {
    serve();
    api.put.mockResolvedValue({ feature: {} });
    api.delete.mockResolvedValue({ deleted: "f1" });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Known Weddings" }));
    const form = screen.getByRole("form", { name: "Edit the feature" });
    expect(within(form).getByLabelText("Outlet")).toHaveValue("pub-known");
    expect(within(form).getByLabelText("Year")).toHaveValue("2026");
    await userEvent.type(within(form).getByLabelText("Notes"), "Cover story");
    await userEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    expect(api.put).toHaveBeenCalledWith("/style/features/f1", expect.objectContaining({ publicationId: "pub-known", publishedOn: "2026-03", notes: "Cover story" }));

    await userEvent.click(await screen.findByRole("button", { name: "Remove Known Weddings" }));
    expect(api.delete).toHaveBeenCalledWith("/style/features/f1");
  });
});
