import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { fakeApi, location, packageView, renderWizard, serve, walkthrough, wizardAt, type FakeApi } from "../test-utils.js";

let api: FakeApi;

beforeEach(() => {
  api = fakeApi();
});

const continueButton = () => screen.getByRole("button", { name: "Continue" });

describe("[writeup]", () => {
  const open = async (view = packageView()) => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("writeup")),
      "/packages/pk1": view,
    });
    renderWizard(api, "/wizard/w1/writeup?package=pk1");
    await screen.findByLabelText("The write-up");
  };

  it("prefills the write-up and credits from the package", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Write-up and credits" })).toBeInTheDocument();
    expect(screen.getByText("Say what happened, not how beautiful it was. The outlet's editor rewrites anyway.")).toBeInTheDocument();
    expect(screen.getByLabelText("The write-up")).toHaveValue("Sarah and James married on the ice.");
    expect(screen.getByLabelText("The credits")).toHaveValue("Florist: Stems");
  });

  it("holds Continue while either is empty, saying which", async () => {
    await open();
    await userEvent.clear(screen.getByLabelText("The write-up"));
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText("Add the write-up to continue.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("The write-up"), "They married on the ice.");
    await userEvent.clear(screen.getByLabelText("The credits"));
    expect(screen.getByText("Add the credits to continue.")).toBeInTheDocument();
  });

  it("puts the couple's limits beside the writing", async () => {
    await open(packageView({ consent: { nameDisplay: "First names only", consentNotes: null } }));
    expect(screen.getByText("First names only")).toBeInTheDocument();
  });

  it("saves both and moves to the final checks", async () => {
    await open();
    api.patch.mockResolvedValueOnce(packageView());
    await userEvent.type(screen.getByLabelText("The credits"), "\nVenue: The Barn");
    await userEvent.click(continueButton());
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/packages/pk1", {
        descriptionMd: "Sarah and James married on the ice.",
        creditsBlockMd: "Florist: Stems\nVenue: The Barn",
      }),
    );
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/confirm?package=pk1"));
  });
});

describe("[confirm]", () => {
  const checklist = (ticked: boolean, countMet = true) => [
    { id: "images_present", kind: "derived", label: "At least one image selected", satisfied: true },
    {
      id: "image_count",
      kind: "derived",
      label: "Image count within the outlet's range (2 to 3)",
      satisfied: countMet,
      detail: "1 selected; this outlet expects 2 to 3.",
    },
    { id: "no_watermarks", kind: "attested", label: "Confirm no image carries a watermark", satisfied: ticked },
    {
      id: "consent_limits",
      kind: "attested",
      label: "Confirm the package honours the couple's limits",
      satisfied: ticked,
      detail: "First names only",
    },
  ];

  const viewWith = (ticked: boolean, countMet = true) =>
    packageView({
      checklist: checklist(ticked, countMet),
      complete: ticked && countMet,
      missing: [...(countMet ? [] : ["image_count"]), ...(ticked ? [] : ["no_watermarks", "consent_limits"])],
    });

  const open = async (view: ReturnType<typeof packageView>, later?: () => unknown) => {
    serve(api, {
      "/events/w1/walkthrough?package=pk1": walkthrough(wizardAt("confirm")),
      "/packages/pk1": later ?? view,
    });
    renderWizard(api, "/wizard/w1/confirm?package=pk1");
    await screen.findByRole("list", { name: "Checks" });
  };

  it("names the outlet and lists its checks: boxes for what she confirms, ticks for what the package shows", async () => {
    await open(viewWith(false));
    expect(screen.getByRole("heading", { name: "Final checks" })).toBeInTheDocument();
    expect(screen.getByText("Outlet A asks for these. Tick what you can confirm.")).toBeInTheDocument();

    const checks = screen.getByRole("list", { name: "Checks" });
    expect(within(checks).getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "Confirm no photo carries a watermark" })).not.toBeChecked();
    // The outlet's detail text sits under its box.
    expect(screen.getByRole("checkbox", { name: /couple's limits/ }).closest("li")).toHaveTextContent("First names only");
    expect(within(checks).getByText("At least one photo chosen")).toBeInTheDocument();
  });

  it("holds Continue until the server reports the package complete", async () => {
    await open(viewWith(false));
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText("Tick every check to continue.")).toBeInTheDocument();
  });

  it("saves each tick as it is made, and Continue follows the server's verdict", async () => {
    await open(viewWith(false));
    api.patch
      .mockResolvedValueOnce(
        packageView({
          checklist: checklist(false).map((item) => (item.id === "no_watermarks" ? { ...item, satisfied: true } : item)),
          complete: false,
          missing: ["consent_limits"],
        }),
      )
      .mockResolvedValueOnce(viewWith(true));

    await userEvent.click(screen.getByRole("checkbox", { name: "Confirm no photo carries a watermark" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenLastCalledWith("/packages/pk1", {
        attestations: { no_watermarks: true, consent_limits: false },
      }),
    );
    expect(continueButton()).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox", { name: /couple's limits/ }));
    await waitFor(() => expect(continueButton()).toBeEnabled());
  });

  it("re-reads the package on Continue and moves on only when it is complete", async () => {
    let reads = 0;
    await open(viewWith(true), () => {
      reads++;
      return viewWith(true);
    });
    api.patch.mockResolvedValue(viewWith(true));
    await userEvent.click(continueButton());
    await waitFor(() => expect(location(screen)).toBe("/wizard/w1/review?package=pk1"));
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("shows the server's open items when the re-read is not complete", async () => {
    let reads = 0;
    await open(viewWith(true), () => (reads++ === 0 ? viewWith(true) : viewWith(true, false)));
    api.patch.mockResolvedValue(viewWith(true));
    await userEvent.click(continueButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Still open: The number of photos fits the outlet's range.",
    );
    expect(location(screen)).toBe("/wizard/w1/confirm?package=pk1");
  });

  it("points an open package item at the screen that fixes it", async () => {
    await open(viewWith(true, false));
    expect(screen.getByText("Fix the open items above to continue.")).toBeInTheDocument();
    expect(screen.getByText("Not done: The number of photos fits the outlet's range")).toBeInTheDocument();
    expect(screen.getByText("1 chosen; this outlet expects 2 to 3.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fix this" })).toHaveAttribute("href", "/wizard/w1/photos?package=pk1");
  });
});
