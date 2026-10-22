import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { GUIDE, RULES, WELCOME } from "../wizard/guide.js";
import { STEPS } from "../wizard/model.js";
import { HelpPage } from "./HelpPage.js";

const open = () =>
  render(
    <MemoryRouter>
      <HelpPage />
    </MemoryRouter>,
  );

describe("HelpPage", () => {
  it("opens with what the tool is and the five rules", () => {
    open();
    expect(screen.getByRole("heading", { name: "How it works" })).toBeInTheDocument();
    expect(screen.getByText(WELCOME.lead)).toBeInTheDocument();
    const rules = within(screen.getByRole("list", { name: "The rules" })).getAllByRole("listitem");
    expect(rules.map((item) => item.textContent)).toEqual(RULES);
  });

  it("prints every step with its instructions, in order", () => {
    open();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(STEPS.map((step, index) => `${index + 1}. ${GUIDE[step].title}`));
    expect(screen.getByText(GUIDE.send.todo[4] as string)).toBeInTheDocument();
    expect(screen.getByText(GUIDE.permissions.note as string)).toBeInTheDocument();
    expect(screen.getByText(GUIDE.track.next)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose a wedding" })).toHaveAttribute("href", "/");
  });
});
