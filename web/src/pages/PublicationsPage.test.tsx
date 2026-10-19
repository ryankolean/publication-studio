import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PublicationsPage } from "./PublicationsPage.js";
import { SessionProvider } from "../session-context.js";
import type { ApiClient } from "../api/client.js";
import { createSession, type StorageLike } from "../auth/session.js";

function fakeStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, v) => void entries.set(k, v),
    removeItem: (k) => void entries.delete(k),
  };
}

const publication = (overrides: Record<string, unknown> = {}) => ({
  id: "pub-loverly",
  name: "Loverly",
  tier: "secondary",
  method: "portal",
  submissionUrl: "https://loverly.example/submit",
  spec: {
    imgMin: 30,
    imgMax: 40,
    size: "web",
    watermarksAllowed: null,
    videoAccepted: true,
    videoNotes: null,
    requirements: ["full_vendor_credits"],
    notes: null,
  },
  exclusivityPolicy: "non_exclusive",
  typicalResponseDays: 14,
  responseWindowNote: "Approval typically takes about two weeks.",
  earnedOrPaid: "earned",
  tasteNotes: "Editorial lens on details.",
  lastVerified: "2026-10-19",
  tags: ["garden_botanical", "classic_timeless"],
  ...overrides,
});

let api: { get: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = { get: vi.fn() };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <PublicationsPage />
      </SessionProvider>
    </MemoryRouter>,
  );

describe("PublicationsPage", () => {
  it("shows each outlet's tags as chips", async () => {
    api.get.mockResolvedValueOnce({ publications: [publication()] });
    renderPage();
    const list = await screen.findByRole("list", { name: "Loverly tags" });
    expect(list).toHaveTextContent("Garden botanical");
    expect(list).toHaveTextContent("Classic timeless");
  });

  it("quotes the outlet's own response-window wording under the number", async () => {
    api.get.mockResolvedValueOnce({ publications: [publication()] });
    renderPage();
    expect(await screen.findByText("About 14 days")).toBeInTheDocument();
    expect(screen.getByText(/Approval typically takes about two weeks/)).toBeInTheDocument();
  });

  it("labels a dream outlet and says it has no public route", async () => {
    api.get.mockResolvedValueOnce({
      publications: [
        publication({
          id: "pub-vogue-weddings",
          name: "Vogue Weddings",
          tier: "dream",
          method: null,
          submissionUrl: null,
          typicalResponseDays: null,
          responseWindowNote: null,
          tags: [],
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText(/Dream - No public submission route/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Vogue Weddings tags" })).not.toBeInTheDocument();
  });
});
