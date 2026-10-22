import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QueuePage, type SubmissionView } from "./QueuePage.js";
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

const submission = (overrides: Partial<SubmissionView> = {}): SubmissionView => ({
  id: "s1",
  eventId: "e1",
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

type Mock = ReturnType<typeof vi.fn>;
let api: { get: Mock; post: Mock; patch: Mock; delete: Mock; putBytes: Mock };

function serve(submissions: SubmissionView[]) {
  api.get.mockImplementation(async (path: string) => {
    if (path === "/submissions") return { submissions };
    throw new ApiError(404, "NOT_FOUND", `unexpected ${path}`);
  });
}

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), putBytes: vi.fn() };
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/queue"]}>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <Routes>
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/packages/:id" element={<p>Package editor stub</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );

const group = async (name: string) => screen.findByRole("list", { name });
const rowsOf = async (name: string) => within(await group(name)).getAllByRole("listitem");

describe("grouping", () => {
  it("puts ready and queued under ready to send, sent under live, and the rest under finished", async () => {
    serve([
      submission({ id: "s-live", status: "sent", coupleNames: "Ana and Ben", daysRemaining: 10 }),
      submission({ id: "s-ready", status: "ready", coupleNames: "Cleo and Dev" }),
      submission({ id: "s-queued", status: "queued", coupleNames: "Eve and Finn" }),
      submission({ id: "s-declined", status: "declined", coupleNames: "Gia and Hal" }),
      submission({ id: "s-cancelled", status: "cancelled", coupleNames: "Ivy and Jo" }),
    ]);
    renderPage();

    const ready = await rowsOf("Ready to send");
    expect(ready.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Cleo and Dev"),
      expect.stringContaining("Eve and Finn"),
    ]);
    expect((await rowsOf("Live")).map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ana and Ben"),
    ]);
    const finished = await rowsOf("Finished");
    expect(finished).toHaveLength(2);
    expect(finished[0]).toHaveTextContent("Declined");
    expect(finished[1]).toHaveTextContent("Cancelled");
  });

  it("shows an empty state for each group", async () => {
    serve([]);
    renderPage();
    expect(await screen.findByText(/Nothing is waiting to be sent/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is live at an outlet/)).toBeInTheDocument();
    expect(screen.getByText(/No finished submissions yet/)).toBeInTheDocument();
  });

  it("names the couple and the outlet, and opens the wedding on this submission", async () => {
    serve([submission()]);
    renderPage();
    const [row] = await rowsOf("Ready to send");
    expect(row).toHaveTextContent("Sarah and James");
    expect(row).toHaveTextContent("Loverly");
    expect(within(row as HTMLElement).getByRole("link", { name: "Open this wedding" })).toHaveAttribute(
      "href",
      "/wizard/e1?package=pk1",
    );
  });

  it("surfaces a load failure", async () => {
    api.get.mockRejectedValue(new ApiError(500, "INTERNAL", "Something went wrong."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
  });
});

describe("the live window", () => {
  it("counts the days left, and says when the window has passed or is unknown", async () => {
    serve([
      submission({ id: "a", status: "sent", coupleNames: "Ana and Ben", daysRemaining: 12, responseDueAt: "2026-10-31T12:00:00Z" }),
      submission({ id: "b", status: "sent", coupleNames: "Cleo and Dev", daysRemaining: 1, responseDueAt: "2026-10-20T12:00:00Z" }),
      submission({ id: "c", status: "sent", coupleNames: "Eve and Finn", daysRemaining: -2, responseDueAt: "2026-10-17T12:00:00Z" }),
      submission({ id: "d", status: "sent", coupleNames: "Gia and Hal", daysRemaining: null }),
    ]);
    renderPage();

    const rows = await rowsOf("Live");
    expect(rows[0]).toHaveTextContent("12 days remaining");
    expect(rows[0]).toHaveTextContent("Due 2026-10-31");
    expect(rows[1]).toHaveTextContent("1 day remaining");
    expect(rows[2]).toHaveTextContent("The reply window has passed");
    expect(rows[3]).toHaveTextContent("No reply window given");
    expect(within(rows[3] as HTMLElement).getByRole("link", { name: "Open this wedding" })).toHaveAttribute(
      "href",
      "/wizard/e1?package=pk1",
    );
  });
});

describe("marking a submission sent", () => {
  it("says the tool does not send anything, and asks for a second click", async () => {
    serve([submission({ status: "queued" })]);
    renderPage();

    const [row] = await rowsOf("Ready to send");
    const scope = within(row as HTMLElement);
    expect(scope.getByText(/does not send anything/)).toBeInTheDocument();

    await userEvent.click(scope.getByRole("button", { name: "Mark as sent" }));
    expect(api.patch).not.toHaveBeenCalled();
    expect(scope.getByRole("button", { name: "Confirm: I sent it" })).toBeInTheDocument();
  });

  it("records a queued submission as sent on confirm, then reloads", async () => {
    serve([submission({ status: "queued" })]);
    api.patch.mockResolvedValue(submission({ status: "sent" }));
    renderPage();

    const [row] = await rowsOf("Ready to send");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Mark as sent" }));
    serve([submission({ status: "sent", daysRemaining: 28 })]);
    await userEvent.click(screen.getByRole("button", { name: "Confirm: I sent it" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith("/submissions/s1", { status: "sent" });
    expect((await rowsOf("Live"))[0]).toHaveTextContent("28 days remaining");
  });

  it("walks a ready submission through the queue first, one step at a time", async () => {
    serve([submission({ status: "ready" })]);
    api.patch.mockResolvedValue(submission({ status: "sent" }));
    renderPage();

    const [row] = await rowsOf("Ready to send");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Mark as sent" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm: I sent it" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    expect(api.patch.mock.calls).toEqual([
      ["/submissions/s1", { status: "queued" }],
      ["/submissions/s1", { status: "sent" }],
    ]);
  });

  it("backs out without recording anything", async () => {
    serve([submission({ status: "queued" })]);
    renderPage();

    const [row] = await rowsOf("Ready to send");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Mark as sent" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(api.patch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Mark as sent" })).toBeInTheDocument();
  });

  it("shows the server's reason when the send is refused", async () => {
    serve([submission({ status: "queued" })]);
    api.patch.mockRejectedValue(
      new ApiError(
        409,
        "EVENT_HAS_LIVE_SUBMISSION",
        "This event is already live at The Lane. Record that outlet's answer before marking another one sent.",
      ),
    );
    renderPage();

    const [row] = await rowsOf("Ready to send");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Mark as sent" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm: I sent it" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This event is already live at The Lane. Record that outlet's answer before marking another one sent.",
    );
  });
});

describe("recording an outcome", () => {
  it("records an acceptance with notes after a confirm", async () => {
    serve([submission({ status: "sent", daysRemaining: 5 })]);
    api.patch.mockResolvedValue(submission({ status: "accepted" }));
    renderPage();

    const [row] = await rowsOf("Live");
    const scope = within(row as HTMLElement);
    await userEvent.click(scope.getByRole("button", { name: "Accepted" }));
    expect(api.patch).not.toHaveBeenCalled();

    await userEvent.type(scope.getByLabelText("Notes (optional)"), "Running in spring.");
    await userEvent.click(scope.getByRole("button", { name: "Confirm accepted" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith("/submissions/s1", {
      status: "accepted",
      outcomeNotes: "Running in spring.",
    });
  });

  it("records a decline without notes", async () => {
    serve([submission({ status: "sent", daysRemaining: 5 })]);
    api.patch.mockResolvedValue(submission({ status: "declined" }));
    renderPage();

    const [row] = await rowsOf("Live");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Declined" }));
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Confirm declined" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith("/submissions/s1", { status: "declined" });
  });

  it("backs out of an outcome without recording it", async () => {
    serve([submission({ status: "sent", daysRemaining: 5 })]);
    renderPage();

    const [row] = await rowsOf("Live");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Declined" }));
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Cancel" }));

    expect(api.patch).not.toHaveBeenCalled();
    expect(within(row as HTMLElement).getByRole("button", { name: "Accepted" })).toBeInTheDocument();
  });
});

describe("finished submissions", () => {
  it("shows the status and the published address when there is one", async () => {
    serve([
      submission({
        status: "published",
        publishedUrl: "https://outlet.example/features/sarah-and-james",
      }),
    ]);
    renderPage();

    const [row] = await rowsOf("Finished");
    expect(row).toHaveTextContent("Published");
    expect(within(row as HTMLElement).getByRole("link", { name: /outlet\.example/ })).toHaveAttribute(
      "href",
      "https://outlet.example/features/sarah-and-james",
    );
  });

  it("offers no send or outcome controls", async () => {
    serve([submission({ status: "declined", outcomeNotes: "Not the right fit." })]);
    renderPage();

    const [row] = await rowsOf("Finished");
    expect(row).toHaveTextContent("Not the right fit.");
    expect(within(row as HTMLElement).queryByRole("button")).toBeNull();
  });
});
