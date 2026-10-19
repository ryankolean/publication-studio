import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PackageEditorPage } from "./PackageEditorPage.js";
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

const key = (n: number) => `events/w1/img-${n}.jpg`;

const image = (n: number) => ({
  key: key(n),
  contentType: "image/jpeg",
  bytes: 1000,
  createdAt: "2026-10-01T00:00:00Z",
  readUrl: `/images/${key(n)}?token=t${n}`,
  expiresIn: 900,
});

const spec = (imgMin: number | null, imgMax: number | null) => ({
  imgMin,
  imgMax,
  size: "web",
  watermarksAllowed: false,
  videoAccepted: null,
  videoNotes: null,
  requirements: [],
  notes: null,
});

const CHECKLIST = [
  {
    id: "images_present",
    kind: "derived",
    label: "At least one image selected",
    satisfied: false,
    detail: "Select the images to submit.",
  },
  {
    id: "image_count",
    kind: "derived",
    label: "Image count within the outlet's range (40 to 80)",
    satisfied: false,
    detail: "0 selected; this outlet expects 40 to 80.",
  },
  { id: "no_watermarks", kind: "attested", label: "Confirm no image carries a watermark", satisfied: false },
  { id: "web_size", kind: "attested", label: "Confirm every image is a web-size derivative", satisfied: true },
];

const view = (overrides: Record<string, unknown> = {}) => ({
  id: "pk1",
  eventId: "w1",
  publicationId: "pub-loverly",
  publication: {
    id: "pub-loverly",
    name: "Loverly",
    tier: "primary",
    method: "portal",
    submissionUrl: null,
    spec: spec(40, 80),
  },
  imageKeys: [] as string[],
  descriptionMd: "Drafted description.",
  creditsBlockMd: "- Florist: Stems",
  version: 1,
  createdAt: "2026-10-02T00:00:00Z",
  consent: { nameDisplay: null, consentNotes: null },
  checklist: CHECKLIST,
  complete: false,
  missing: ["images_present", "image_count", "no_watermarks"],
  submission: null as null | { id: string; status: string; sentAt: string | null; responseDueAt: string | null },
  ...overrides,
});

const COMPLETE = {
  checklist: CHECKLIST.map((item) => ({ ...item, satisfied: true })),
  complete: true,
  missing: [] as string[],
};

type Mock = ReturnType<typeof vi.fn>;
let api: { get: Mock; post: Mock; patch: Mock; delete: Mock; putBytes: Mock };

function serve(pkg = view(), images = [image(1), image(2), image(3)]) {
  api.get.mockImplementation(async (path: string) => {
    if (path === "/packages/pk1") return pkg;
    if (path === "/events/w1/images") return { images };
    throw new ApiError(404, "NOT_FOUND", `unexpected ${path}`);
  });
}

beforeEach(() => {
  api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), putBytes: vi.fn() };
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/packages/pk1"]}>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <Routes>
          <Route path="/packages/:id" element={<PackageEditorPage />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );

const poolButton = (n: number) => screen.getByRole("button", { name: `Pool image ${n}` });

/** The selected keys, in order, read from the rendered selection list. */
const selectedOrder = () =>
  within(screen.getByRole("list", { name: "Selected images" }))
    .queryAllByRole("listitem")
    .map((item) => item.getAttribute("data-key"));

describe("loading", () => {
  it("shows the outlet, the pool and the stored selection in order", async () => {
    serve(view({ imageKeys: [key(3), key(1)] }));
    renderPage();

    expect(await screen.findByRole("heading", { name: /Loverly/ })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Image pool" })).getAllByRole("img")).toHaveLength(3);
    expect(selectedOrder()).toEqual([key(3), key(1)]);
    expect(poolButton(3)).toHaveAttribute("aria-pressed", "true");
    expect(poolButton(2)).toHaveAttribute("aria-pressed", "false");
  });

  it("surfaces a load failure", async () => {
    api.get.mockRejectedValue(new ApiError(404, "NOT_FOUND", "No such package."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("No such package.");
  });
});

describe("curating the selection", () => {
  it("toggles an image in and out of the selection", async () => {
    serve();
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Pool image 2" }));
    expect(poolButton(2)).toHaveAttribute("aria-pressed", "true");
    expect(selectedOrder()).toEqual([key(2)]);

    await userEvent.click(poolButton(2));
    expect(poolButton(2)).toHaveAttribute("aria-pressed", "false");
    expect(selectedOrder()).toEqual([]);
  });

  it("appends in click order and reorders with up and down", async () => {
    serve();
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Pool image 1" }));
    await userEvent.click(poolButton(2));
    await userEvent.click(poolButton(3));
    expect(selectedOrder()).toEqual([key(1), key(2), key(3)]);

    await userEvent.click(screen.getByRole("button", { name: "Move pool image 3 up" }));
    expect(selectedOrder()).toEqual([key(1), key(3), key(2)]);

    await userEvent.click(screen.getByRole("button", { name: "Move pool image 1 down" }));
    expect(selectedOrder()).toEqual([key(3), key(1), key(2)]);
  });

  it("disables moves past either end", async () => {
    serve(view({ imageKeys: [key(1), key(2)] }));
    renderPage();
    expect(await screen.findByRole("button", { name: "Move pool image 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move pool image 2 down" })).toBeDisabled();
  });

  it("removes from the selection list too", async () => {
    serve(view({ imageKeys: [key(1), key(2)] }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Remove pool image 1" }));
    expect(selectedOrder()).toEqual([key(2)]);
  });
});

describe("counting against the outlet's spec", () => {
  it("counts live against both bounds", async () => {
    serve();
    renderPage();
    expect(await screen.findByText("0 selected, outlet wants 40 to 80")).toBeInTheDocument();
    await userEvent.click(poolButton(1));
    expect(screen.getByText("1 selected, outlet wants 40 to 80")).toBeInTheDocument();
  });

  it("says so when the outlet states no bounds", async () => {
    serve(view({ publication: { ...view().publication, spec: spec(null, null) } }));
    renderPage();
    expect(await screen.findByText("0 selected, no stated bounds")).toBeInTheDocument();
  });

  it("handles a one-sided bound", async () => {
    serve(view({ publication: { ...view().publication, spec: spec(25, null) } }));
    renderPage();
    expect(await screen.findByText("0 selected, outlet wants at least 25")).toBeInTheDocument();
  });
});

describe("the checklist", () => {
  it("renders derived items read-only and attested items as checkboxes", async () => {
    serve();
    renderPage();

    const checklist = await screen.findByRole("list", { name: "Checklist" });
    expect(within(checklist).getByText("At least one image selected")).toBeInTheDocument();
    expect(within(checklist).getByText("Select the images to submit.")).toBeInTheDocument();
    expect(within(checklist).queryByRole("checkbox", { name: "At least one image selected" })).toBeNull();

    expect(within(checklist).getByRole("checkbox", { name: "Confirm no image carries a watermark" })).not.toBeChecked();
    expect(
      within(checklist).getByRole("checkbox", { name: "Confirm every image is a web-size derivative" }),
    ).toBeChecked();
  });

  it("names what is missing", async () => {
    serve();
    renderPage();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Missing: At least one image selected, Image count within the outlet's range (40 to 80), Confirm no image carries a watermark",
    );
  });
});

describe("saving", () => {
  it("sends one patch with the whole edit and renders the returned verdict", async () => {
    serve();
    const saved = view({
      imageKeys: [key(2), key(1)],
      descriptionMd: "Rewritten.",
      creditsBlockMd: "- Venue: The Barn",
      checklist: CHECKLIST.map((item) => ({ ...item, satisfied: true })),
      complete: true,
      missing: [],
    });
    api.patch.mockResolvedValue(saved);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Pool image 1" }));
    await userEvent.click(poolButton(2));
    await userEvent.click(screen.getByRole("button", { name: "Move pool image 2 up" }));

    const description = screen.getByLabelText("Description");
    await userEvent.clear(description);
    await userEvent.type(description, "Rewritten.");
    const credits = screen.getByLabelText("Credits block");
    await userEvent.clear(credits);
    await userEvent.type(credits, "- Venue: The Barn");
    await userEvent.click(screen.getByRole("checkbox", { name: "Confirm no image carries a watermark" }));

    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save package" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith("/packages/pk1", {
      imageKeys: [key(2), key(1)],
      descriptionMd: "Rewritten.",
      creditsBlockMd: "- Venue: The Barn",
      attestations: { no_watermarks: true, web_size: true },
    });

    expect(await screen.findByRole("status")).toHaveTextContent("Package complete");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(selectedOrder()).toEqual([key(2), key(1)]);
  });

  it("sends an unticked attestation as false", async () => {
    serve();
    api.patch.mockResolvedValue(view());
    renderPage();

    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Confirm every image is a web-size derivative" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save package" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch.mock.calls[0]?.[1]).toMatchObject({
      attestations: { no_watermarks: false, web_size: false },
    });
  });

  it("shows the server's reason when a save is refused, and keeps the edit", async () => {
    serve();
    api.patch.mockRejectedValue(
      new ApiError(400, "VALIDATION", "Some fields need attention.", [
        { field: "imageKeys", message: "Those images belong to another event." },
      ]),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Pool image 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save package" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Those images belong to another event.");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(selectedOrder()).toEqual([key(1)]);
  });
});

describe("the submission", () => {
  const createButton = () => screen.queryByRole("button", { name: "Create submission" });

  it("offers no submission while the package is incomplete", async () => {
    serve();
    renderPage();
    await screen.findByRole("heading", { name: /Loverly/ });
    expect(createButton()).toBeNull();
  });

  it("offers a submission once the package is complete", async () => {
    serve(view(COMPLETE));
    renderPage();
    await screen.findByRole("heading", { name: /Loverly/ });
    expect(createButton()).toBeInTheDocument();
  });

  it("holds the button until unsaved edits are saved", async () => {
    serve(view(COMPLETE));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Pool image 1" }));
    expect(createButton()).toBeDisabled();
  });

  it("creates the submission and shows where it stands", async () => {
    serve(view(COMPLETE));
    api.post.mockResolvedValue({ id: "s1", status: "ready", sentAt: null, responseDueAt: null });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Create submission" }));

    expect(api.post).toHaveBeenCalledWith("/submissions", { packageId: "pk1" });
    expect(await screen.findByText("Ready to send")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the queue" })).toHaveAttribute("href", "/queue");
    expect(createButton()).toBeNull();
  });

  it("renders the server's refusal as-is", async () => {
    serve(view(COMPLETE));
    api.post.mockRejectedValue(
      new ApiError(422, "PACKAGE_INCOMPLETE", "The package is not complete. Finish its checklist first."),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Create submission" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The package is not complete. Finish its checklist first.",
    );
  });

  it("renders a conflict as-is", async () => {
    serve(view(COMPLETE));
    api.post.mockRejectedValue(
      new ApiError(409, "SUBMISSION_EXISTS", "A submission already exists for this event and publication."),
    );
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Create submission" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A submission already exists for this event and publication.",
    );
  });

  it("shows an existing submission's status and the way to the queue instead", async () => {
    serve(
      view({
        ...COMPLETE,
        submission: { id: "s1", status: "sent", sentAt: "2026-10-19T12:00:00Z", responseDueAt: null },
      }),
    );
    renderPage();

    expect(await screen.findByText("Sent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the queue" })).toHaveAttribute("href", "/queue");
    expect(createButton()).toBeNull();
  });
});
