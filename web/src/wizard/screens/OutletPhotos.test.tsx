import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../../api/client.js";
import {
  fakeApi,
  location,
  packageView,
  renderWizard,
  serve,
  walkthrough,
  wizardAt,
  type FakeApi,
} from "../test-utils.js";

let api: FakeApi;

beforeEach(() => {
  api = fakeApi();
});

const continueButton = () => screen.getByRole("button", { name: "Continue" });

describe("[outlet]", () => {
  const openWith = async (body = walkthrough(wizardAt("outlet")), entry = "/wizard/w1/outlet") => {
    serve(api, {
      "/events/w1/walkthrough": body,
      "/events/w1/walkthrough?package=pk1": body,
      "/events/w1/walkthrough?package=pk9": walkthrough(wizardAt("photos", { packageId: "pk9" })),
      "/packages/pk1": packageView(),
      "/packages/pk9": packageView({ id: "pk9" }),
      "/events/w1/images": { images: [] },
    });
    renderWizard(api, entry);
    await screen.findByRole("heading", { name: "Choose an outlet" });
  };

  it("shows a card per outlet: name, tier, one line of taste, facts and warnings", async () => {
    await openWith();
    expect(screen.getByText("One outlet at a time per wedding. Start with the one you want most.")).toBeInTheDocument();

    const a = screen.getByRole("radio", { name: /Outlet A/ }).closest("label") as HTMLElement;
    expect(a).toHaveTextContent("Top tier");
    expect(a).toHaveTextContent("Loves winter light and real moments.");
    expect(a).not.toHaveTextContent("Avoids anything staged.");
    expect(a).toHaveTextContent("30 to 40 photos - replies in about 28 days - web form");

    const b = screen.getByRole("radio", { name: /Outlet B/ }).closest("label") as HTMLElement;
    expect(b).toHaveTextContent("Dream");
    expect(b).toHaveTextContent("no stated count - no stated reply time - pitch to an editor");
    expect(within(b).getByRole("listitem")).toHaveTextContent("pitch to an editor, not a form");
  });

  it("keeps Continue off until an outlet is picked", async () => {
    await openWith();
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText("Pick an outlet to continue.")).toBeInTheDocument();
  });

  it("starts the package for the chosen outlet and moves to the photos with it", async () => {
    await openWith();
    api.post.mockResolvedValueOnce({ id: "pk9" });
    await userEvent.click(screen.getByRole("radio", { name: /Outlet A/ }));
    await userEvent.click(continueButton());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/packages", { eventId: "w1", publicationId: "pub-a" }));
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/photos?package=pk9"));
  });

  it("lists packages already started first, and continues one without starting another", async () => {
    const body = walkthrough(wizardAt("photos"), {
      packages: [
        {
          id: "pk1",
          publicationId: "pub-a",
          publicationName: "Outlet A",
          complete: false,
          imageCount: 3,
          submission: null,
        },
      ],
    });
    await openWith(body, "/wizard/w1/outlet?package=pk1");

    const started = screen.getByRole("heading", { name: "Already started" });
    const another = screen.getByRole("heading", { name: "Another outlet" });
    expect(started.compareDocumentPosition(another) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The started outlet is not offered twice.
    expect(screen.getAllByRole("radio", { name: /Outlet A/ })).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /Outlet A/ })).toBeChecked();
    expect(screen.getByText("Not in the queue yet")).toBeInTheDocument();

    await userEvent.click(continueButton());
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/photos?package=pk1"));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("stops a blocked wedding with the reasons and a way to fix them", async () => {
    await openWith(
      walkthrough(
        wizardAt("outlet", {
          blocked: { step: "outlet", reasons: ["Second-shooter weddings cannot be submitted under your name."] },
        }),
      ),
    );
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Why this wedding is on hold" })).toHaveTextContent(
      "Second-shooter weddings cannot be submitted under your name.",
    );
    expect(screen.getByRole("link", { name: "Edit permissions" })).toHaveAttribute("href", "/wizard/w1/permissions");
    expect(continueButton()).toBeDisabled();
    expect(screen.getAllByText("This wedding cannot go to an outlet yet.").length).toBeGreaterThan(0);
  });

  it("shows the server's refusal to start", async () => {
    await openWith();
    api.post.mockRejectedValueOnce(new ApiError(403, "RIGHTS_BLOCKED", "This event cannot be packaged yet."));
    await userEvent.click(screen.getByRole("radio", { name: /Outlet B/ }));
    await userEvent.click(continueButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("This event cannot be packaged yet.");
  });
});

describe("[photos]", () => {
  const pool = [
    { key: "events/w1/a.jpg", originalName: "arrival.jpg", contentType: "image/jpeg", bytes: 5, createdAt: "", readUrl: "/images/events/w1/a.jpg?token=a", expiresIn: 900 },
    { key: "events/w1/b.jpg", originalName: null, contentType: "image/jpeg", bytes: 5, createdAt: "", readUrl: "/images/events/w1/b.jpg?token=b", expiresIn: 900 },
    { key: "events/w1/c.jpg", originalName: "cake.jpg", contentType: "image/jpeg", bytes: 5, createdAt: "", readUrl: "/images/events/w1/c.jpg?token=c", expiresIn: 900 },
    { key: "events/w1/d.jpg", originalName: "dance.jpg", contentType: "image/jpeg", bytes: 5, createdAt: "", readUrl: "/images/events/w1/d.jpg?token=d", expiresIn: 900 },
  ];

  const open = async (view = packageView(), images = pool) => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("photos")),
      "/packages/pk1": view,
      "/events/w1/images": () => ({ images }),
    });
    renderWizard(api, "/wizard/w1/photos?package=pk1");
    await screen.findByRole("status");
  };

  it("asks for web-size files and covering the day", async () => {
    await open();
    expect(
      screen.getByText(
        "Download web-size files from your gallery, not full size. Cover the day: getting ready, details, ceremony, portraits, reception, party.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps a live count against the outlet's range and holds Continue below its minimum", async () => {
    await open();
    expect(screen.getByRole("status")).toHaveTextContent("0 chosen; Outlet A wants 2 to 3");
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText("Choose at least 2 to continue.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "arrival.jpg" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 chosen; Outlet A wants 2 to 3");
    await userEvent.click(screen.getByRole("button", { name: "Photo 2" }));
    expect(continueButton()).toBeEnabled();
  });

  it("holds Continue above the outlet's maximum", async () => {
    await open();
    for (const name of ["arrival.jpg", "Photo 2", "cake.jpg", "dance.jpg"]) {
      await userEvent.click(screen.getByRole("button", { name }));
    }
    expect(screen.getByText("Choose no more than 3 to continue.")).toBeInTheDocument();
  });

  it("says 'no stated count' and needs one photo when the outlet states none", async () => {
    await open(packageView({ publication: { id: "pub-b", name: "Outlet B", method: null, submissionUrl: null, spec: { imgMin: null, imgMax: null } } }));
    expect(screen.getByRole("status")).toHaveTextContent("0 chosen; no stated count");
    expect(screen.getByText("Choose at least one photo to continue.")).toBeInTheDocument();
  });

  it("orders the selection with up, down and remove, and saves it in that order", async () => {
    await open(packageView({ imageKeys: ["events/w1/c.jpg", "events/w1/a.jpg"] }));
    const selected = screen.getByRole("list", { name: "Selected photos" });
    expect(within(selected).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("cake.jpg"),
      expect.stringContaining("arrival.jpg"),
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Move arrival.jpg up" }));
    await userEvent.click(screen.getByRole("button", { name: "dance.jpg" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove cake.jpg" }));

    api.patch.mockResolvedValueOnce(packageView());
    await userEvent.click(continueButton());
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/packages/pk1", { imageKeys: ["events/w1/a.jpg", "events/w1/d.jpg"] }),
    );
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/writeup?package=pk1"));
  });

  it("uploads each file with its name, through the grant and back in the header", async () => {
    await open(packageView(), []);
    api.post
      .mockResolvedValueOnce({ uploadUrl: "/images/events/w1/n1.jpg?token=x", fileName: "IMG_1.jpg" })
      .mockResolvedValueOnce({ uploadUrl: "/images/events/w1/n2.png?token=y", fileName: "rings.png" });
    api.putBytes.mockResolvedValue({});

    const first = new File([new Uint8Array([1])], "IMG_1.jpg", { type: "image/jpeg" });
    const second = new File([new Uint8Array([2])], "rings.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Add photos"), [first, second]);

    await waitFor(() => expect(api.putBytes).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenNthCalledWith(1, "/events/w1/images", { contentType: "image/jpeg", fileName: "IMG_1.jpg" });
    expect(api.putBytes).toHaveBeenNthCalledWith(1, "/images/events/w1/n1.jpg?token=x", first, "image/jpeg", "IMG_1.jpg");
    expect(api.putBytes).toHaveBeenNthCalledWith(2, "/images/events/w1/n2.png?token=y", second, "image/png", "rings.png");
    const progress = await screen.findByRole("list", { name: "Upload progress" });
    await waitFor(() => expect(progress).toHaveTextContent("rings.png: uploaded"));
  });

  it("stops uploading when the server refuses on rights grounds", async () => {
    await open(packageView(), []);
    api.post.mockRejectedValueOnce(new ApiError(403, "RIGHTS_BLOCKED", "This event cannot be packaged yet."));
    await userEvent.upload(screen.getByLabelText("Add photos"), [
      new File([new Uint8Array([1])], "a.jpg", { type: "image/jpeg" }),
      new File([new Uint8Array([2])], "b.jpg", { type: "image/jpeg" }),
    ]);
    const progress = await screen.findByRole("list", { name: "Upload progress" });
    await waitFor(() => expect(progress).toHaveTextContent("a.jpg: This event cannot be packaged yet."));
    expect(progress).toHaveTextContent("b.jpg: waiting");
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("asks for an outlet first when no package is known", async () => {
    serve(api, { "/events/w1/walkthrough": walkthrough(wizardAt("photos", { packageId: null })) });
    renderWizard(api, "/wizard/w1/photos");
    expect(await screen.findByText("Choose an outlet first.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose an outlet" })).toHaveAttribute("href", "/wizard/w1/outlet");
  });
});
