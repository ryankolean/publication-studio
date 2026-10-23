import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResearchUpdatesPage } from "./ResearchUpdatesPage.js";
import { SessionProvider } from "../session-context.js";
import { ApiError, type ApiClient } from "../api/client.js";
import { createSession, type StorageLike } from "../auth/session.js";
import { formatValue, fieldLabel } from "../research/labels.js";

function fakeStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, v) => void entries.set(k, v),
    removeItem: (k) => void entries.delete(k),
  };
}

const revision = (overrides: Record<string, unknown> = {}) => ({
  id: "r1",
  publicationId: "pub-brides",
  name: "Brides",
  isNew: false,
  firstResearch: false,
  proposedAt: "2026-10-23T18:00:00Z",
  gitSha: "abc1234",
  changes: [{ field: "timing.response_window", before: { days: 60, replies: "success_only" }, after: { days: 45, replies: "success_only" } }],
  conflicts: [],
  ...overrides,
});

let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn().mockResolvedValue({}) };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <ResearchUpdatesPage />
      </SessionProvider>
    </MemoryRouter>,
  );

describe("ResearchUpdatesPage", () => {
  it("says so when nothing waits", async () => {
    api.get.mockResolvedValue({ revisions: [] });
    renderPage();
    expect(await screen.findByText("No outlet updates are waiting.")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/research/revisions");
  });

  it("shows what changed, field by field", async () => {
    api.get.mockResolvedValue({ revisions: [revision()] });
    renderPage();
    const card = await screen.findByRole("article", { name: "Brides" });
    expect(within(card).getByText("1 change")).toBeInTheDocument();
    expect(within(card).getByText("Reply time")).toBeInTheDocument();
    expect(within(card).getByText("Days: 60; replies: Success only")).toBeInTheDocument();
    expect(within(card).getByText("Days: 45; replies: Success only")).toBeInTheDocument();
  });

  it("describes a new outlet, first research and a re-check without listing nothing", async () => {
    api.get.mockResolvedValue({
      revisions: [
        revision({
          id: "r1",
          name: "Example Weddings",
          isNew: true,
          changes: [
            { field: "tier", before: null, after: "primary" },
            { field: "content.elopement", before: null, after: "unknown" },
          ],
        }),
        revision({ id: "r2", name: "Brides", firstResearch: true }),
        revision({ id: "r3", name: "Loverly", changes: [] }),
      ],
    });
    renderPage();
    expect(await screen.findByText("New outlet: 1 fact found, 1 unknown.")).toBeInTheDocument();
    expect(screen.getByText("Full research for an outlet already in the app: 1 fact found, 0 unknown.")).toBeInTheDocument();
    expect(screen.getByText("Checked again. Nothing changed.")).toBeInTheDocument();
  });

  it("warns when new research changes one of her corrections", async () => {
    const change = revision().changes[0];
    api.get.mockResolvedValue({ revisions: [revision({ conflicts: [change] })] });
    renderPage();
    expect(
      await screen.findByText(/You corrected Reply time\. Your correction stays in force/),
    ).toBeInTheDocument();
  });

  it("approves one update and takes it off the list", async () => {
    api.get.mockResolvedValue({ revisions: [revision()] });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Approve Brides" }));
    expect(api.post).toHaveBeenCalledWith("/research/revisions/r1/approve", {});
    expect(await screen.findByText("Approved Brides.")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Brides" })).not.toBeInTheDocument();
  });

  it("turns one down", async () => {
    api.get.mockResolvedValue({ revisions: [revision()] });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Turn down Brides" }));
    expect(api.post).toHaveBeenCalledWith("/research/revisions/r1/reject", {});
    expect(await screen.findByText("Turned down Brides.")).toBeInTheDocument();
  });

  it("approves every update that leaves her corrections alone, and only those", async () => {
    const change = revision().changes[0];
    api.get.mockResolvedValue({
      revisions: [
        revision({ id: "r1", name: "Brides" }),
        revision({ id: "r2", name: "Loverly" }),
        revision({ id: "r3", name: "The Knot", conflicts: [change] }),
      ],
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Approve all 2" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenCalledWith("/research/revisions/r1/approve", {});
    expect(api.post).toHaveBeenCalledWith("/research/revisions/r2/approve", {});
    expect(await screen.findByRole("article", { name: "The Knot" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Brides" })).not.toBeInTheDocument();
  });

  it("shows the server's reason when a decision fails", async () => {
    api.get.mockResolvedValue({ revisions: [revision()] });
    api.post.mockRejectedValue(new ApiError(409, "ILLEGAL_TRANSITION", "Only research waiting for approval can be approved."));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Approve Brides" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only research waiting for approval can be approved.");
  });

  it("shows the server's reason when the list cannot load", async () => {
    api.get.mockRejectedValue(new ApiError(500, "INTERNAL", "Something went wrong."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
  });
});

describe("research labels", () => {
  it("says each kind of value in plain words", () => {
    expect(formatValue(null)).toBe("Not recorded");
    expect(formatValue("unknown")).toBe("Unknown");
    expect(formatValue("none")).toBe("None");
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(false)).toBe("No");
    expect(formatValue(100182)).toBe("100,182");
    expect(formatValue("exclusive_required")).toBe("Exclusive required");
    expect(formatValue("A mix of vertical and horizontal images.")).toBe("A mix of vertical and horizontal images.");
    expect(formatValue([])).toBe("None listed");
    expect(formatValue(["US-MI", "US:midwest"])).toBe("US-MI, US:midwest");
    expect(formatValue({ policy: "non_exclusive", during_review: null })).toBe("Policy: Non exclusive");
    expect(fieldLabel("timing.response_window")).toBe("Reply time");
    expect(fieldLabel("rules.new_rule")).toBe("Rules new rule");
  });
});
