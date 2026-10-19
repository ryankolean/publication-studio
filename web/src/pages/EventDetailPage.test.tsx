import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventDetailPage } from "./EventDetailPage.js";
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

const BLOCKED_GATE = {
  allowed: false,
  code: "RIGHTS_BLOCKED",
  route: "submission",
  reasons: [{ code: "CONSENT_UNVERIFIED", field: "consent_status", remedy: "Record the couple's consent." }],
};

const event = (overrides: Record<string, unknown> = {}) => ({
  id: "w1",
  slug: "sarah-and-james-2026",
  coupleNames: "Sarah and James",
  eventDate: "2026-06-14",
  venueName: "The Barn",
  city: "Detroit",
  state: "MI",
  country: null,
  consentStatus: "granted_limited",
  consentNotes: "No guest faces",
  nameDisplay: "First names only",
  hasGalleryUrl: true,
  gate: { allowed: true },
  ...overrides,
});

const image = (n: number) => ({
  key: `events/w1/img-${n}.jpg`,
  contentType: "image/jpeg",
  bytes: 1000,
  createdAt: "2026-10-01T00:00:00Z",
  readUrl: `/images/events/w1/img-${n}.jpg?token=t${n}`,
  expiresIn: 900,
});

const PACKAGES = [
  {
    id: "pk1",
    publicationId: "pub-loverly",
    publicationName: "Loverly",
    version: 1,
    complete: false,
    imageCount: 3,
    createdAt: "2026-10-02T00:00:00Z",
    submission: null,
  },
  {
    id: "pk2",
    publicationId: "pub-the-lane",
    publicationName: "The Lane",
    version: 1,
    complete: true,
    imageCount: 30,
    createdAt: "2026-10-01T00:00:00Z",
    submission: { id: "s1", status: "sent", sentAt: "2026-10-03T00:00:00Z", responseDueAt: null },
  },
];

const PUBLICATIONS = [
  { id: "pub-loverly", name: "Loverly" },
  { id: "pub-brides", name: "Brides" },
];

type Mock = ReturnType<typeof vi.fn>;
let api: { get: Mock; post: Mock; patch: Mock; delete: Mock; putBytes: Mock };

function serveGets(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    "/events/w1": event(),
    "/events/w1/images": { images: [image(1), image(2)] },
    "/events/w1/packages": { packages: PACKAGES },
    "/publications": { publications: PUBLICATIONS },
    ...overrides,
  };
  api.get.mockImplementation(async (path: string) => {
    if (!(path in responses)) throw new ApiError(404, "NOT_FOUND", `unexpected ${path}`);
    return responses[path];
  });
}

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), putBytes: vi.fn() };
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/events/w1"]}>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <Routes>
          <Route path="/events/:id" element={<EventDetailPage />} />
          <Route path="/packages/:id" element={<p>Package editor stub</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );

const jpeg = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });

describe("EventDetailPage header", () => {
  it("shows the couple, date, place, gate and consent limits", async () => {
    serveGets();
    renderPage();
    expect(await screen.findByRole("heading", { name: "Sarah and James" })).toBeInTheDocument();
    expect(screen.getByText(/2026-06-14/)).toHaveTextContent("The Barn");
    expect(screen.getByText("Ready to package")).toBeInTheDocument();
    expect(screen.getByText(/Granted with limits/)).toBeInTheDocument();
    expect(screen.getByText(/First names only/)).toBeInTheDocument();
    expect(screen.getByText(/No guest faces/)).toBeInTheDocument();
  });

  it("opens the submission walkthrough", async () => {
    serveGets();
    renderPage();
    expect(await screen.findByRole("link", { name: "Submit this event" })).toHaveAttribute(
      "href",
      "/events/w1/submit",
    );
  });

  it("opens the event for editing", async () => {
    serveGets();
    renderPage();
    expect(await screen.findByRole("link", { name: "Edit event" })).toHaveAttribute(
      "href",
      "/events/w1/edit",
    );
  });

  it("only says whether a gallery link is on file", async () => {
    serveGets();
    renderPage();
    expect(await screen.findByText("Gallery link on file")).toBeInTheDocument();
  });

  it("says when there is no gallery link", async () => {
    serveGets({ "/events/w1": event({ hasGalleryUrl: false }) });
    renderPage();
    expect(await screen.findByText("No gallery link")).toBeInTheDocument();
  });

  it("surfaces a load failure", async () => {
    api.get.mockRejectedValue(new ApiError(404, "NOT_FOUND", "No such event."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("No such event.");
  });
});

describe("the image pool", () => {
  it("renders a thumbnail per pooled image from its read url", async () => {
    serveGets();
    renderPage();
    const pool = await screen.findByRole("list", { name: "Image pool" });
    const thumbs = within(pool).getAllByRole("img");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]?.getAttribute("src")).toMatch(/\/images\/events\/w1\/img-1\.jpg\?token=t1$/);
  });

  it("uploads each file in order: request a grant, then put the bytes", async () => {
    serveGets();
    const calls: string[] = [];
    let grant = 0;
    api.post.mockImplementation(async (path: string, body: { contentType: string }) => {
      grant++;
      calls.push(`post ${path} ${body.contentType}`);
      return { key: `events/w1/new-${grant}.jpg`, uploadUrl: `/images/events/w1/new-${grant}.jpg?token=u${grant}` };
    });
    api.putBytes.mockImplementation(async (url: string, file: File, type: string) => {
      calls.push(`put ${url} ${file.name} ${type}`);
      return {};
    });

    renderPage();
    const input = await screen.findByLabelText("Add images");
    await userEvent.upload(input, [jpeg("a.jpg"), jpeg("b.jpg")]);

    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls).toEqual([
      "post /events/w1/images image/jpeg",
      "put /images/events/w1/new-1.jpg?token=u1 a.jpg image/jpeg",
      "post /events/w1/images image/jpeg",
      "put /images/events/w1/new-2.jpg?token=u2 b.jpg image/jpeg",
    ]);
    expect(await screen.findByText("a.jpg: uploaded")).toBeInTheDocument();
    expect(screen.getByText("b.jpg: uploaded")).toBeInTheDocument();

    // The pool is re-read once the batch finishes.
    await waitFor(() =>
      expect(api.get.mock.calls.filter((call) => call[0] === "/events/w1/images")).toHaveLength(2),
    );
  });

  it("shows the server's reason for a refused file and carries on with the rest", async () => {
    serveGets();
    api.post
      .mockRejectedValueOnce(
        new ApiError(400, "VALIDATION", "Images must be one of: image/jpeg, image/png, image/webp."),
      )
      .mockResolvedValueOnce({ key: "events/w1/ok.jpg", uploadUrl: "/images/events/w1/ok.jpg?token=u" });
    api.putBytes.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(await screen.findByLabelText("Add images"), [
      new File([new Uint8Array([1])], "c.gif", { type: "image/gif" }),
      jpeg("ok.jpg"),
    ]);

    expect(
      await screen.findByText("c.gif: Images must be one of: image/jpeg, image/png, image/webp."),
    ).toBeInTheDocument();
    expect(await screen.findByText("ok.jpg: uploaded")).toBeInTheDocument();
    expect(api.putBytes).toHaveBeenCalledTimes(1);
  });

  it("shows the size limit message the upload returns", async () => {
    serveGets();
    api.post.mockResolvedValue({ key: "events/w1/big.jpg", uploadUrl: "/images/events/w1/big.jpg?token=u" });
    api.putBytes.mockRejectedValue(new ApiError(400, "VALIDATION", "That image is larger than the limit."));

    renderPage();
    await userEvent.upload(await screen.findByLabelText("Add images"), [jpeg("big.jpg")]);
    expect(await screen.findByText("big.jpg: That image is larger than the limit.")).toBeInTheDocument();
  });

  it("swaps the uploader for the gate's reasons when an upload is refused by the gate", async () => {
    serveGets();
    api.post.mockRejectedValue(
      new ApiError(403, "RIGHTS_BLOCKED", "This event cannot be packaged yet.", BLOCKED_GATE.reasons as never),
    );

    renderPage();
    await userEvent.upload(await screen.findByLabelText("Add images"), [jpeg("a.jpg")]);
    expect(await screen.findByText("Record the couple's consent.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add images")).not.toBeInTheDocument();
    expect(api.putBytes).not.toHaveBeenCalled();
  });

  it("deletes an image after confirmation and re-reads the pool", async () => {
    serveGets();
    api.delete.mockResolvedValue({ deleted: true });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Delete image 1" }));
    expect(api.delete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete of image 1" }));

    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/events/w1/images/events/w1/img-1.jpg"),
    );
    await waitFor(() =>
      expect(api.get.mock.calls.filter((call) => call[0] === "/events/w1/images")).toHaveLength(2),
    );
  });

  it("explains that an image is in use when the delete is refused", async () => {
    serveGets();
    api.delete.mockRejectedValue(
      new ApiError(409, "IMAGE_IN_USE", "A package still uses this image. Remove it from the package first."),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Delete image 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete of image 2" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A package still uses this image. Remove it from the package first.",
    );
  });
});

describe("a blocked event", () => {
  it("shows the remedies in place of the uploader and the package starter", async () => {
    serveGets({ "/events/w1": event({ gate: BLOCKED_GATE }) });
    renderPage();

    expect(await screen.findByText("Blocked")).toBeInTheDocument();
    expect(screen.getAllByText("Record the couple's consent.").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Add images")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start package" })).not.toBeInTheDocument();
  });
});

describe("packages", () => {
  it("lists each package with a link to its editor, completeness and image count", async () => {
    serveGets();
    renderPage();

    const list = await screen.findByRole("list", { name: "Packages" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "Loverly" })).toHaveAttribute(
      "href",
      "/packages/pk1",
    );
    expect(rows[0]).toHaveTextContent("Incomplete");
    expect(rows[0]).toHaveTextContent("3 images");
    expect(rows[1]).toHaveTextContent("Complete");
    expect(rows[1]).toHaveTextContent("30 images");
  });

  it("shows the submission status beside a package that has one", async () => {
    serveGets();
    renderPage();

    const rows = within(await screen.findByRole("list", { name: "Packages" })).getAllByRole("listitem");
    expect(rows[1]).toHaveTextContent("Sent");
    expect(rows[0]).not.toHaveTextContent("Sent");
    expect(rows[0]).not.toHaveTextContent("Ready to send");
  });

  it("starts a package for the chosen publication and opens the editor", async () => {
    serveGets();
    api.post.mockResolvedValue({ id: "pk9" });
    renderPage();

    await userEvent.selectOptions(await screen.findByLabelText("Publication"), "pub-brides");
    await userEvent.click(screen.getByRole("button", { name: "Start package" }));

    expect(api.post).toHaveBeenCalledWith("/packages", { eventId: "w1", publicationId: "pub-brides" });
    expect(await screen.findByText("Package editor stub")).toBeInTheDocument();
  });

  it("shows why a package could not be started", async () => {
    serveGets();
    api.post.mockRejectedValue(new ApiError(400, "VALIDATION", "That publication is no longer active."));
    renderPage();

    await userEvent.selectOptions(await screen.findByLabelText("Publication"), "pub-loverly");
    await userEvent.click(screen.getByRole("button", { name: "Start package" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That publication is no longer active.");
  });
});
