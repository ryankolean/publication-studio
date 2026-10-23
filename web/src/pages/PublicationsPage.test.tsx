import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PublicationsPage } from "./PublicationsPage.js";
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
  corrections: [],
  ...overrides,
});

let api: {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
});

const VOCAB = {
  tags: [
    { id: "garden_botanical", category: "landscape_venue" },
    { id: "classic_timeless", category: "aesthetic" },
    { id: "romantic", category: "aesthetic" },
  ],
};

/** Answers each GET by path, so a test states the whole server it renders against. */
function serve(publications: unknown[], revisions: unknown[] = []) {
  api.get.mockImplementation(async (path: string) => {
    if (path === "/publications") return { publications };
    if (path === "/research/revisions") return { revisions };
    if (path === "/tags") return VOCAB;
    throw new Error(`unexpected GET ${path}`);
  });
}

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
  it("points to the outlet updates waiting for approval", async () => {
    serve([publication()], [{ id: "r1" }, { id: "r2" }]);
    renderPage();
    expect(await screen.findByText("2 outlet updates are waiting for your OK.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review them" })).toHaveAttribute("href", "/publications/updates");
  });

  it("removes a tag", async () => {
    serve([publication()]);
    api.delete.mockResolvedValue({ tags: ["classic_timeless"] });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Remove Garden botanical" }));
    expect(api.delete).toHaveBeenCalledWith("/publications/pub-loverly/tags/garden_botanical");
    const list = await screen.findByRole("list", { name: "Loverly tags" });
    expect(list).not.toHaveTextContent("Garden botanical");
  });

  it("adds a tag from the vocabulary", async () => {
    serve([publication()]);
    api.post.mockResolvedValue({ tags: ["garden_botanical", "classic_timeless", "romantic"] });
    renderPage();
    const card = await screen.findByRole("article", { name: "Loverly" });
    await userEvent.click(within(card).getByText("Add a tag"));
    await userEvent.selectOptions(within(card).getByLabelText("Tag to add"), "romantic");
    await userEvent.click(within(card).getByRole("button", { name: "Add tag" }));
    expect(api.post).toHaveBeenCalledWith("/publications/pub-loverly/tags/romantic", {});
    expect(await within(card).findByRole("list", { name: "Loverly tags" })).toHaveTextContent("Romantic");
  });

  it("creates her own tag and adds it", async () => {
    serve([publication()]);
    api.post.mockImplementation(async (path: string) =>
      path === "/tags"
        ? { id: "candlelit_evening", category: "aesthetic", origin: "custom" }
        : { tags: ["garden_botanical", "classic_timeless", "candlelit_evening"] },
    );
    renderPage();
    const card = await screen.findByRole("article", { name: "Loverly" });
    await userEvent.click(within(card).getByText("Add a tag"));
    await userEvent.type(within(card).getByLabelText("New tag"), "Candlelit evening");
    await userEvent.selectOptions(within(card).getByLabelText("New tag group"), "aesthetic");
    await userEvent.click(within(card).getByRole("button", { name: "Create and add" }));
    expect(api.post).toHaveBeenCalledWith("/tags", { label: "Candlelit evening", category: "aesthetic" });
    expect(api.post).toHaveBeenCalledWith("/publications/pub-loverly/tags/candlelit_evening", {});
  });

  it("saves a correction and shows it", async () => {
    const corrected = publication({
      typicalResponseDays: 30,
      corrections: [{ field: "timing.response_window", value: { days: 30, replies: "all" }, note: "Editor told me" }],
    });
    let calls = 0;
    api.get.mockImplementation(async (path: string) => {
      if (path === "/publications") return { publications: [calls++ === 0 ? publication() : corrected] };
      if (path === "/research/revisions") return { revisions: [] };
      return VOCAB;
    });
    api.put.mockResolvedValue({});
    renderPage();
    const card = await screen.findByRole("article", { name: "Loverly" });
    await userEvent.click(within(card).getByText("Correct a detail"));
    await userEvent.selectOptions(within(card).getByLabelText("Detail"), "timing.response_window");
    await userEvent.type(within(card).getByLabelText("Days"), "30");
    await userEvent.selectOptions(within(card).getByLabelText("Replies"), "all");
    await userEvent.type(within(card).getByLabelText("Why (optional)"), "Editor told me");
    await userEvent.click(within(card).getByRole("button", { name: "Save correction" }));
    expect(api.put).toHaveBeenCalledWith("/publications/pub-loverly/edits/timing.response_window", {
      value: { days: 30, replies: "all" },
      note: "Editor told me",
    });
    expect(await screen.findByText("About 30 days")).toBeInTheDocument();
    expect(screen.getByText("Reply time: Days: 30; replies: All")).toBeInTheDocument();
  });

  it("saves a number correction", async () => {
    serve([publication()]);
    api.put.mockResolvedValue({});
    renderPage();
    const card = await screen.findByRole("article", { name: "Loverly" });
    await userEvent.click(within(card).getByText("Correct a detail"));
    await userEvent.selectOptions(within(card).getByLabelText("Detail"), "package.image_max");
    await userEvent.type(within(card).getByLabelText("Number"), "80");
    await userEvent.click(within(card).getByRole("button", { name: "Save correction" }));
    expect(api.put).toHaveBeenCalledWith("/publications/pub-loverly/edits/package.image_max", { value: 80, note: null });
  });

  it("saves an exclusivity correction", async () => {
    serve([publication()]);
    api.put.mockResolvedValue({});
    renderPage();
    const card = await screen.findByRole("article", { name: "Loverly" });
    await userEvent.click(within(card).getByText("Correct a detail"));
    await userEvent.selectOptions(within(card).getByLabelText("Detail"), "rules.exclusivity");
    await userEvent.selectOptions(within(card).getByLabelText("Policy"), "exclusive_required");
    await userEvent.click(within(card).getByRole("button", { name: "Save correction" }));
    expect(api.put).toHaveBeenCalledWith("/publications/pub-loverly/edits/rules.exclusivity", {
      value: { policy: "exclusive_required" },
      note: null,
    });
  });

  it("undoes a correction", async () => {
    serve([publication({ corrections: [{ field: "package.image_max", value: 80, note: null }] })]);
    api.delete.mockResolvedValue(undefined);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Undo the Most photos correction" }));
    expect(api.delete).toHaveBeenCalledWith("/publications/pub-loverly/edits/package.image_max");
  });

  it("shows why a correction was refused", async () => {
    serve([publication()]);
    api.put.mockRejectedValue(new ApiError(422, "VALIDATION", "That correction does not fit this field."));
    renderPage();
    const card = await screen.findByRole("article", { name: "Loverly" });
    await userEvent.click(within(card).getByText("Correct a detail"));
    await userEvent.selectOptions(within(card).getByLabelText("Detail"), "package.image_min");
    await userEvent.type(within(card).getByLabelText("Number"), "5");
    await userEvent.click(within(card).getByRole("button", { name: "Save correction" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("That correction does not fit this field.");
  });
});
