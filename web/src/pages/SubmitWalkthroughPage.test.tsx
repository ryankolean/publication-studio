import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubmitWalkthroughPage } from "./SubmitWalkthroughPage.js";
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

type Mock = ReturnType<typeof vi.fn>;
let api: { get: Mock; post: Mock; patch: Mock };

type Step = {
  id: string;
  title: string;
  status: "done" | "current" | "todo" | "blocked";
  summary: string;
  detail: string[];
  action: { label: string; href: string } | null;
};

const s = (id: string, title: string, status: Step["status"], extra: Partial<Step> = {}): Step => ({
  id,
  title,
  status,
  summary: `${title} summary`,
  detail: [],
  action: null,
  ...extra,
});

const OUTLETS = [
  {
    id: "pub-a",
    name: "Outlet A",
    tier: "primary",
    method: "web_form",
    imgMin: 30,
    imgMax: 40,
    typicalResponseDays: 28,
    warnings: [],
  },
  {
    id: "pub-b",
    name: "Outlet B",
    tier: "dream",
    method: null,
    imgMin: null,
    imgMax: null,
    typicalResponseDays: null,
    warnings: [
      { code: "no_public_route", text: "No public submission route: reaching this outlet is a pitch to an editor, not a form." },
    ],
  },
];

/** Before an outlet is chosen. */
const fresh = () => ({
  event: { id: "w1", coupleNames: "Sarah and James" },
  packages: [] as unknown[],
  package: null as unknown,
  outlets: OUTLETS,
  steps: [
    s("intake", "Complete the event record", "done", {
      action: { label: "Edit the event", href: "/events/w1/edit" },
    }),
    s("rights", "Clear rights and consent", "done", {
      detail: ['Name display: "First names only"'],
      action: { label: "Edit rights and consent", href: "/events/w1/edit" },
    }),
    s("outlet", "Choose an outlet", "current", { detail: ["Outlet A (primary, web form): 30 to 40 images."] }),
    s("images", "Gather the images", "done", {
      detail: ["Cover the whole day: getting ready, details, ceremony, portraits, reception."],
      action: { label: "Open the event", href: "/events/w1" },
    }),
    s("package", "Build the package", "todo"),
    s("submission", "Put it in the queue", "todo"),
    s("send", "Send it yourself", "todo", {
      detail: ["Nothing is sent by this tool. Send it yourself, then mark it sent in the queue."],
      action: { label: "Open the queue", href: "/queue" },
    }),
    s("response", "Wait for the reply", "todo"),
  ] as Step[],
});

const PACKAGE = {
  id: "pk1",
  publicationId: "pub-a",
  publicationName: "Outlet A",
  submissionUrl: "https://a.example.com/submit",
  descriptionMd: "Sarah and James married at The Barn.",
  creditsBlockMd: "Florist: Stems",
  imageCount: 32,
  complete: true,
  submission: { id: "s1", status: "ready", responseDueAt: null, daysRemaining: null, publishedUrl: null },
};

/** A package chosen, the submission waiting to be sent. */
const readyToSend = () => {
  const base = fresh();
  return {
    ...base,
    packages: [
      {
        id: "pk1",
        publicationId: "pub-a",
        publicationName: "Outlet A",
        version: 1,
        complete: true,
        imageCount: 32,
        createdAt: "2026-10-01T00:00:00Z",
        submission: { id: "s1", status: "ready", sentAt: null, responseDueAt: null },
      },
    ],
    package: PACKAGE,
    steps: base.steps.map((entry) =>
      entry.id === "send"
        ? { ...entry, status: "current" as const }
        : entry.id === "response"
          ? entry
          : { ...entry, status: "done" as const },
    ),
  };
};

/** Accepted: the live-link step is current. */
const accepted = () => {
  const base = readyToSend();
  return {
    ...base,
    package: { ...PACKAGE, submission: { ...PACKAGE.submission, status: "accepted" } },
    steps: [
      ...base.steps.map((entry) => ({ ...entry, status: "done" as const })),
      s("published", "Record the live link", "current", { detail: ["Paste the address of the live feature."] }),
    ],
  };
};

/** Answers GET by path; anything unexpected is a 404. */
function serve(answers: Record<string, unknown>) {
  api.get.mockImplementation(async (path: string) => {
    if (!(path in answers)) throw new ApiError(404, "NOT_FOUND", `unexpected ${path}`);
    return answers[path];
  });
}

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn(), patch: vi.fn() };
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

const renderPage = (entry = "/events/w1/submit") =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <Routes>
          <Route path="/events/:id/submit" element={<SubmitWalkthroughPage />} />
          <Route path="/events/:id/edit" element={<p>Edit page stub</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );

const stepItem = (title: string) => {
  const heading = screen.getByRole("heading", { name: new RegExp(title) });
  const item = heading.closest("li");
  if (item === null) throw new Error(`no step item for ${title}`);
  return item;
};

describe("SubmitWalkthroughPage", () => {
  it("explains how it works in four sentences", async () => {
    serve({ "/events/w1/walkthrough": fresh() });
    renderPage();
    const intro = await screen.findByRole("region", { name: "How this works" });
    expect(intro).toHaveTextContent(/prepares the package and tracks the reply; you do the sending/);
    expect(intro).toHaveTextContent(/one outlet at a time/);
    expect(intro).toHaveTextContent(/The checklist is the outlet's own rules/);
    expect(intro).toHaveTextContent(/Mark things done here as you go/);
  });

  it("renders the numbered steps with their status and marks the current one", async () => {
    serve({ "/events/w1/walkthrough": fresh() });
    renderPage();
    expect(await screen.findByRole("heading", { name: /Sarah and James/ })).toBeInTheDocument();

    const steps = screen.getByRole("list", { name: "Submission steps" });
    const items = within(steps).getAllByRole("listitem").filter((li) => li.parentElement === steps);
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveTextContent("1");
    expect(items[0]).toHaveTextContent("Complete the event record");
    expect(items[0]).toHaveTextContent("Done");

    const current = items.filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Choose an outlet");
    expect(current[0]).toHaveTextContent("Current");
    expect(items[4]).toHaveTextContent("To do");
  });

  it("shows each step's summary, detail lines and action", async () => {
    serve({ "/events/w1/walkthrough": fresh() });
    renderPage();
    await screen.findByRole("heading", { name: /Sarah and James/ });

    const images = stepItem("Gather the images");
    expect(images).toHaveTextContent("Gather the images summary");
    expect(images).toHaveTextContent("getting ready, details, ceremony, portraits, reception");
    expect(within(images).getByRole("link", { name: "Open the event" })).toHaveAttribute("href", "/events/w1");
    expect(stepItem("Clear rights and consent")).toHaveTextContent('Name display: "First names only"');
  });

  it("shows a blocked step as blocked", async () => {
    const body = fresh();
    body.steps[1] = s("rights", "Clear rights and consent", "blocked");
    serve({ "/events/w1/walkthrough": body });
    renderPage();
    await screen.findByRole("heading", { name: /Sarah and James/ });
    expect(stepItem("Clear rights and consent")).toHaveTextContent("Blocked");
  });

  it("opens the edit page from the intake step", async () => {
    serve({ "/events/w1/walkthrough": fresh() });
    renderPage();
    await screen.findByRole("heading", { name: /Sarah and James/ });
    await userEvent.click(within(stepItem("Complete the event record")).getByRole("link", { name: "Edit the event" }));
    expect(await screen.findByText("Edit page stub")).toBeInTheDocument();
  });

  it("loads the walkthrough for the package named in the address", async () => {
    serve({ "/events/w1/walkthrough?package=pk1": readyToSend() });
    renderPage("/events/w1/submit?package=pk1");
    expect(await screen.findByRole("heading", { name: /Sarah and James/ })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/events/w1/walkthrough?package=pk1");
  });

  it("surfaces a load failure", async () => {
    api.get.mockRejectedValue(new ApiError(404, "NOT_FOUND", "No such event."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("No such event.");
  });

  describe("choosing an outlet", () => {
    it("lists the active outlets as choices with their warnings under each", async () => {
      serve({ "/events/w1/walkthrough": fresh() });
      renderPage();
      const a = await screen.findByRole("radio", { name: /Outlet A/ });
      const b = screen.getByRole("radio", { name: /Outlet B/ });
      expect(a).not.toBeChecked();

      const choiceB = b.closest("li");
      expect(choiceB).toHaveTextContent("pitch to an editor");
      expect(choiceB).toHaveTextContent("no public route");
      expect(a.closest("li")).toHaveTextContent("30 to 40 images");
      expect(a.closest("li")).toHaveTextContent("replies in about 28 days");
    });

    it("starts a package for the chosen outlet and reloads the walkthrough with it", async () => {
      serve({
        "/events/w1/walkthrough": fresh(),
        "/events/w1/walkthrough?package=pk9": readyToSend(),
      });
      api.post.mockResolvedValueOnce({ id: "pk9" });
      renderPage();

      const start = await screen.findByRole("button", { name: "Start package for this outlet" });
      expect(start).toBeDisabled();
      await userEvent.click(screen.getByRole("radio", { name: /Outlet A/ }));
      await userEvent.click(start);

      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith("/packages", { eventId: "w1", publicationId: "pub-a" }),
      );
      await waitFor(() => expect(api.get).toHaveBeenCalledWith("/events/w1/walkthrough?package=pk9"));
      expect(await screen.findByRole("button", { name: "Copy description" })).toBeInTheDocument();
    });

    it("reloads when the outlet already had this package open", async () => {
      serve({ "/events/w1/walkthrough?package=pk1": readyToSend() });
      api.post.mockResolvedValueOnce({ id: "pk1" });
      renderPage("/events/w1/submit?package=pk1");

      const radio = await screen.findByRole("radio", { name: /Outlet A/ });
      expect(radio).toBeChecked();
      await userEvent.click(screen.getByRole("button", { name: "Start package for this outlet" }));
      await waitFor(() =>
        expect(api.get.mock.calls.filter((call) => call[0] === "/events/w1/walkthrough?package=pk1")).toHaveLength(2),
      );
    });

    it("offers the event's existing packages as choices", async () => {
      const body = readyToSend();
      serve({ "/events/w1/walkthrough": { ...fresh(), packages: body.packages }, "/events/w1/walkthrough?package=pk1": body });
      renderPage();

      await userEvent.click(await screen.findByRole("button", { name: "Continue with Outlet A" }));
      await waitFor(() => expect(api.get).toHaveBeenCalledWith("/events/w1/walkthrough?package=pk1"));
    });

    it("shows the server's refusal", async () => {
      serve({ "/events/w1/walkthrough": fresh() });
      api.post.mockRejectedValueOnce(new ApiError(403, "RIGHTS_BLOCKED", "This event cannot be packaged yet."));
      renderPage();
      await userEvent.click(await screen.findByRole("radio", { name: /Outlet B/ }));
      await userEvent.click(screen.getByRole("button", { name: "Start package for this outlet" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This event cannot be packaged yet.");
    });
  });

  describe("sending", () => {
    it("copies the description and the credits, showing that it did", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      serve({ "/events/w1/walkthrough?package=pk1": readyToSend() });
      renderPage("/events/w1/submit?package=pk1");

      await userEvent.click(await screen.findByRole("button", { name: "Copy description" }));
      expect(writeText).toHaveBeenCalledWith("Sarah and James married at The Barn.");
      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Copy credits" }));
      expect(writeText).toHaveBeenLastCalledWith("Florist: Stems");
      // One "Copied" at a time: the description button reads normally again.
      expect(screen.getByRole("button", { name: "Copy description" })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Copied" })).toHaveLength(1);
    });

    it("says so when the browser cannot copy", async () => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      serve({ "/events/w1/walkthrough?package=pk1": readyToSend() });
      renderPage("/events/w1/submit?package=pk1");

      await userEvent.click(await screen.findByRole("button", { name: "Copy description" }));
      expect(await screen.findByText(/Copying is not available here/)).toBeInTheDocument();
    });

    it("says so when the copy is refused", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("denied"));
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      serve({ "/events/w1/walkthrough?package=pk1": readyToSend() });
      renderPage("/events/w1/submit?package=pk1");

      await userEvent.click(await screen.findByRole("button", { name: "Copy credits" }));
      expect(await screen.findByText(/Copying is not available here/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    });

    it("links to the outlet's own submission page in a new tab", async () => {
      serve({ "/events/w1/walkthrough?package=pk1": readyToSend() });
      renderPage("/events/w1/submit?package=pk1");
      const link = await screen.findByRole("link", { name: "Open the outlet's submission page" });
      expect(link).toHaveAttribute("href", "https://a.example.com/submit");
      expect(link).toHaveAttribute("target", "_blank");
    });
  });

  describe("recording the live link", () => {
    it("records the published address and reloads", async () => {
      serve({ "/events/w1/walkthrough?package=pk1": accepted() });
      api.patch.mockResolvedValueOnce({ id: "s1", status: "published" });
      renderPage("/events/w1/submit?package=pk1");

      await userEvent.type(await screen.findByLabelText("Live feature address"), " https://outlet.example.com/f ");
      await userEvent.click(screen.getByRole("button", { name: "Record published link" }));

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith("/submissions/s1", {
          status: "published",
          publishedUrl: "https://outlet.example.com/f",
        }),
      );
      await waitFor(() =>
        expect(api.get.mock.calls.filter((call) => call[0] === "/events/w1/walkthrough?package=pk1")).toHaveLength(2),
      );
    });

    it("shows the server's reason when the address is refused", async () => {
      serve({ "/events/w1/walkthrough?package=pk1": accepted() });
      api.patch.mockRejectedValueOnce(
        new ApiError(400, "VALIDATION", "Some fields need attention.", [
          { field: "publishedUrl", message: "Add the web address where the feature ran." },
        ]),
      );
      renderPage("/events/w1/submit?package=pk1");

      await userEvent.type(await screen.findByLabelText("Live feature address"), "not a url");
      await userEvent.click(screen.getByRole("button", { name: "Record published link" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Add the web address where the feature ran.");
    });

    it("is not offered before the outlet accepts", async () => {
      serve({ "/events/w1/walkthrough?package=pk1": readyToSend() });
      renderPage("/events/w1/submit?package=pk1");
      await screen.findByRole("heading", { name: /Sarah and James/ });
      expect(screen.queryByLabelText("Live feature address")).not.toBeInTheDocument();
    });
  });
});
