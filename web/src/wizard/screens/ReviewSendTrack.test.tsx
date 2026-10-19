import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../api/client.js";
import {
  fakeApi,
  location,
  packageView,
  renderWizard,
  serve,
  storedEvent,
  walkthrough,
  wizardAt,
  type FakeApi,
} from "../test-utils.js";
import { buildPackageZip, saveFile } from "../zip.js";

vi.mock("../zip.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../zip.js")>();
  return { ...actual, buildPackageZip: vi.fn(), saveFile: vi.fn() };
});

let api: FakeApi;

beforeEach(() => {
  api = fakeApi();
  vi.mocked(buildPackageZip).mockReset();
  vi.mocked(saveFile).mockReset();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

const images = Array.from({ length: 8 }, (_, n) => ({
  key: `events/w1/${n}.jpg`,
  originalName: `IMG_${n}.jpg`,
  contentType: "image/jpeg",
  bytes: 5,
  readUrl: `/images/events/w1/${n}.jpg?token=t`,
  expiresIn: 900,
}));

const submission = (status: string, sentAt: string | null = null) => ({
  id: "s1",
  status,
  sentAt,
  responseDueAt: null,
});

describe("[review]", () => {
  const open = async (view = packageView({ imageKeys: images.map((i) => i.key), complete: true }), queued = false) => {
    serve(api, {
      // Past the review once queued: the server's steps say whether it is done.
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt(queued ? "send" : "review")),
      "/events/w1": storedEvent({ consentStatus: "granted_limited", nameDisplay: "First names only" }),
      "/packages/pk1": view,
      "/packages/pk1/images": { images },
    });
    renderWizard(api, "/wizard/w1/review?package=pk1");
    await screen.findByText("Sarah and James, June 14, 2026 at The Barn, Detroit, MI");
  };

  it("summarises the wedding, outlet, photos, write-up, credits and limits", async () => {
    await open(
      packageView({
        imageKeys: images.map((i) => i.key),
        complete: true,
        consent: { nameDisplay: "First names only", consentNotes: null },
      }),
    );
    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByText("Outlet A")).toBeInTheDocument();
    expect(screen.getByText("8 photos")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "First photos" })).getAllByRole("img")).toHaveLength(6);
    expect(screen.getByText("Sarah and James married on the ice.")).toBeInTheDocument();
    expect(screen.getByText("Florist: Stems")).toBeInTheDocument();
    expect(screen.getByText("First names only")).toBeInTheDocument();
  });

  it("adds it to the queue, says nothing is sent, and moves to the send step", async () => {
    await open();
    expect(screen.getByText("This only puts it in your queue. Nothing is sent.")).toBeInTheDocument();
    api.post.mockResolvedValueOnce({ id: "s1", status: "ready" });
    await userEvent.click(screen.getByRole("button", { name: "Add to the queue" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/submissions", { packageId: "pk1" }));
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/send?package=pk1"));
  });

  it.each([
    [422, "PACKAGE_INCOMPLETE", "The package is not complete. Finish its checklist first."],
    [409, "SUBMISSION_EXISTS", "A submission already exists for this event and publication."],
  ])("shows a %s from the server as its message", async (status, code, message) => {
    await open();
    api.post.mockRejectedValueOnce(new ApiError(status, code, message));
    await userEvent.click(screen.getByRole("button", { name: "Add to the queue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(location(screen)).toBe("/wizard/w1/review?package=pk1");
  });

  it("offers Continue instead once it is already queued", async () => {
    await open(packageView({ complete: true, submission: submission("ready") }), true);
    expect(screen.queryByRole("button", { name: "Add to the queue" })).not.toBeInTheDocument();
    expect(screen.getByText("It is in your queue. Nothing has been sent.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(location(screen)).toBe("/wizard/w1/send?package=pk1");
  });
});

describe("[send]", () => {
  const warnings = [
    { code: "exclusive", text: "Exclusive: sending here blocks every other outlet for this event until it answers." },
  ];

  const open = async (status = "ready", overrides: Parameters<typeof wizardAt>[1] = {}) => {
    // Once sent, the server counts the send step done and resumes at the reply.
    const wizard = wizardAt(status === "sent" ? "track" : "send", {
      ...overrides,
      outlet: {
        id: "pub-a",
        name: "Outlet A",
        method: "portal",
        submissionUrl: "https://a.example.com/submit",
        typicalResponseDays: 28,
        warnings,
      },
    });
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(wizard),
      "/packages/pk1": packageView({
        complete: true,
        submission: submission(status, status === "sent" ? "2026-10-19T12:00:00Z" : null),
        publication: {
          id: "pub-a",
          name: "Outlet A",
          method: "portal",
          submissionUrl: "https://a.example.com/submit",
          spec: { imgMin: 2, imgMax: 3 },
        },
      }),
      "/packages/pk1/images": { images: images.slice(0, 3) },
    });
    renderWizard(api, "/wizard/w1/send?package=pk1");
    await screen.findByRole("heading", { name: "Send it to Outlet A" });
  };

  it("lays out the four things to do, and repeats the outlet's warnings", async () => {
    await open();
    expect(screen.getByText("You send it; the tool gets everything ready.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download the photos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the write-up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the credits" })).toBeInTheDocument();
    expect(screen.getByText("Outlet A takes submissions through a portal. You need an account there.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I sent it" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Before you send to Outlet A" })).toHaveTextContent(
      "Exclusive: sending here blocks every other outlet",
    );
  });

  it("opens the outlet's own page in a new tab", async () => {
    await open();
    const link = screen.getByRole("link", { name: "Open Outlet A's submission page" });
    expect(link).toHaveAttribute("href", "https://a.example.com/submit");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("zips the package's photos in order and hands the zip to the browser", async () => {
    await open();
    const bytes = new Uint8Array([1, 2, 3]);
    vi.mocked(buildPackageZip).mockResolvedValueOnce(bytes);
    await userEvent.click(screen.getByRole("button", { name: "Download the photos" }));

    await waitFor(() => expect(saveFile).toHaveBeenCalledWith("Sarah and James - Outlet A.zip", bytes));
    expect(api.get).toHaveBeenCalledWith("/packages/pk1/images");
    expect(vi.mocked(buildPackageZip).mock.calls[0]?.[0]).toEqual(images.slice(0, 3));
    expect(await screen.findByText("3 photos, numbered in your order.")).toBeInTheDocument();
  });

  it("says which photo failed when the zip cannot be built", async () => {
    await open();
    vi.mocked(buildPackageZip).mockRejectedValueOnce(new Error("Photo 2 could not be downloaded. Try again."));
    await userEvent.click(screen.getByRole("button", { name: "Download the photos" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Photo 2 could not be downloaded. Try again.");
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("copies the write-up and the credits, one Copied at a time", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Copy the write-up" }));
    expect(writeText).toHaveBeenCalledWith("Sarah and James married on the ice.");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy the credits" }));
    expect(writeText).toHaveBeenLastCalledWith("Florist: Stems");
    expect(screen.getByRole("button", { name: "Copy the write-up" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Copied" })).toHaveLength(1);
  });

  it("says so when the browser cannot copy", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Copy the credits" }));
    expect(await screen.findByText(/Copying is not available here/)).toBeInTheDocument();
  });

  it("asks before marking it sent, then walks ready to queued to sent and moves to the reply", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByText("Mark it as sent to continue.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "I sent it" }));
    expect(screen.getByText("Mark this as sent today? The reply window starts now.")).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();

    api.patch.mockResolvedValue({});
    await userEvent.click(screen.getByRole("button", { name: "Yes, mark it sent" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    expect(api.patch).toHaveBeenNthCalledWith(1, "/submissions/s1", { status: "queued" });
    expect(api.patch).toHaveBeenNthCalledWith(2, "/submissions/s1", { status: "sent" });
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/track?package=pk1"));
  });

  it("skips the queued step for a submission already queued", async () => {
    await open("queued");
    api.patch.mockResolvedValue({});
    await userEvent.click(screen.getByRole("button", { name: "I sent it" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, mark it sent" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith("/submissions/s1", { status: "sent" });
  });

  it("lets her back out of the confirm", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "I sent it" }));
    await userEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(screen.getByRole("button", { name: "I sent it" })).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and stays", async () => {
    await open("queued");
    api.patch.mockRejectedValueOnce(
      new ApiError(409, "EVENT_HAS_LIVE_SUBMISSION", "This event is already live at Outlet B."),
    );
    await userEvent.click(screen.getByRole("button", { name: "I sent it" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, mark it sent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This event is already live at Outlet B.");
    expect(location(screen)).toBe("/wizard/w1/send?package=pk1");
  });

  it("holds the send, with the server's reason, while another outlet has it", async () => {
    await open("queued", {
      blocked: {
        step: "send",
        reasons: ["This wedding is waiting on Outlet B. Record Outlet B's answer before sending it here."],
      },
    });
    expect(screen.getByText(/waiting on Outlet B/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I sent it" })).toBeDisabled();
  });

  it("says it was sent, and lets her continue, once it is", async () => {
    await open("sent");
    expect(screen.getByText(/Marked sent on October 19, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I sent it" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});

describe("[track]", () => {
  const sentState = (reply: Partial<NonNullable<ReturnType<typeof wizardAt>["reply"]>> = {}, status = "sent") =>
    wizardAt("track", {
      finished: status !== "sent",
      submission: { id: "s1", status: status as "sent", due: null, publishedUrl: status === "published" ? "https://outlet.example.com/f" : null },
      reply: { dueAt: "2026-11-16T12:00:00Z", daysRemaining: 28, outletWords: null, silenceMeansPass: null, ...reply },
    });

  const open = async (first: ReturnType<typeof wizardAt>, after?: ReturnType<typeof wizardAt>) => {
    let reads = 0;
    serve(api, {
      "/events/w1/walkthrough?package=pk1": () => walkthrough(reads++ === 0 || after === undefined ? first : after),
    });
    renderWizard(api, "/wizard/w1/track?package=pk1");
    await screen.findByRole("heading", { name: "Track the reply" });
  };

  it("shows the due date and the days left", async () => {
    await open(sentState());
    expect(screen.getByText("Reply due November 16, 2026: 28 days remaining.")).toBeInTheDocument();
    expect(screen.getByText("Outlet A does not say what silence means.")).toBeInTheDocument();
  });

  it("quotes the outlet's words when there is no window, and says what silence means", async () => {
    await open(
      sentState({ dueAt: null, daysRemaining: null, outletWords: "We reply only to successful submissions.", silenceMeansPass: true }),
    );
    expect(
      screen.getByText('Outlet A gives no reply window. In its own words: "We reply only to successful submissions."'),
    ).toBeInTheDocument();
    expect(screen.getByText("So no reply means it was a pass.")).toBeInTheDocument();
  });

  it("records an acceptance with a note, after a confirm, and reads the state again", async () => {
    await open(sentState(), sentState({}, "accepted"));
    api.patch.mockResolvedValueOnce({});
    await userEvent.click(screen.getByRole("button", { name: "Accepted" }));
    await userEvent.type(screen.getByLabelText("Note (optional)"), "Running in spring.");
    expect(screen.getByText("Record that Outlet A accepted it?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yes, it was accepted" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/submissions/s1", { status: "accepted", outcomeNotes: "Running in spring." }),
    );
    expect(await screen.findByLabelText("Live link")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Done. Start another submission" })).toHaveAttribute("href", "/wizard");
  });

  it("records a decline without a note", async () => {
    await open(sentState(), sentState({}, "declined"));
    api.patch.mockResolvedValueOnce({});
    await userEvent.click(screen.getByRole("button", { name: "Declined" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, it was declined" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/submissions/s1", { status: "declined" }));
    expect(await screen.findByText("Declined. The wedding is free for another outlet.")).toBeInTheDocument();
  });

  it("records the live link once accepted", async () => {
    await open(sentState({}, "accepted"), sentState({}, "published"));
    api.patch.mockResolvedValueOnce({});
    await userEvent.type(screen.getByLabelText("Live link"), " https://outlet.example.com/f ");
    await userEvent.click(screen.getByRole("button", { name: "Record it" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/submissions/s1", {
        status: "published",
        publishedUrl: "https://outlet.example.com/f",
      }),
    );
    expect(await screen.findByRole("link", { name: "https://outlet.example.com/f" })).toBeInTheDocument();
  });

  it("shows the server's refusal of a live link", async () => {
    await open(sentState({}, "accepted"));
    api.patch.mockRejectedValueOnce(
      new ApiError(400, "VALIDATION", "Some fields need attention.", [
        { field: "publishedUrl", message: "Add the web address where the feature ran." },
      ]),
    );
    await userEvent.type(screen.getByLabelText("Live link"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Record it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add the web address where the feature ran.");
  });

  it("asks for the send first when nothing was sent", async () => {
    serve(api, { "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("send")) });
    renderWizard(api, "/wizard/w1/track?package=pk1");
    expect(await screen.findByText("Mark it as sent first. The reply window starts then.")).toBeInTheDocument();
  });
});
