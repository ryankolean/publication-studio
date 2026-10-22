import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Frame } from "./Frame.js";
import { STEPS } from "./model.js";

const guide = {
  title: "Pick the photos",
  lead: "Why this matters.",
  todo: ['Press "Add photos".', "Tap each photo."],
  next: "Next up: the write-up.",
  note: "A note.",
};

const rail = {
  eventId: "w1",
  packageId: null,
  current: "photos" as const,
  steps: STEPS.map((id, index) => ({ id, done: index < 4 })),
};

const noop = () => {};

describe("Frame", () => {
  it("says which step this is, lists what to do, and what comes next", () => {
    render(
      <MemoryRouter>
        <Frame guide={guide} rail={rail} primary={{ label: "Continue", onClick: noop, disabledReason: "Pick a photo to continue." }} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Step 5 of 10: Photos")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pick the photos" })).toBeInTheDocument();
    expect(screen.getByText("Why this matters.")).toBeInTheDocument();

    const box = screen.getByRole("region", { name: "What to do here" });
    expect(within(box).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      'Press "Add photos".',
      "Tap each photo.",
    ]);
    expect(within(box).getByText("A note.")).toBeInTheDocument();
    expect(within(box).getByRole("list")).toHaveClass("break-words");
    expect(screen.getByText("Next up: the write-up.")).toBeInTheDocument();
  });

  it("lets a screen put the outlet's name in the heading", () => {
    render(
      <MemoryRouter>
        <Frame guide={guide} title="Send it to Outlet A" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Send it to Outlet A" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pick the photos" })).toBeNull();
  });

  it("drops the next-up line once Continue is enabled", () => {
    render(
      <MemoryRouter>
        <Frame guide={guide} primary={{ label: "Continue", onClick: noop, disabledReason: null }} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Next up: the write-up.")).toBeNull();
    expect(screen.queryByText(/^Step \d+ of/)).toBeNull();
  });
});
