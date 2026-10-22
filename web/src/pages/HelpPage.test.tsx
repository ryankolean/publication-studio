import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { HelpPage } from "./HelpPage.js";

describe("HelpPage", () => {
  it("explains the tool in five short points", () => {
    render(
      <MemoryRouter>
        <HelpPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "How it works" })).toBeInTheDocument();
    const points = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(points).toHaveLength(5);
    expect(points[0]).toHaveTextContent("You do the sending yourself.");
    expect(points[1]).toHaveTextContent("one outlet at a time");
    expect(points[2]).toHaveTextContent("the outlet's own rules");
    expect(points[3]).toHaveTextContent("Your gallery links stay private.");
    expect(points[4]).toHaveTextContent("Mark things done as you go");
    expect(screen.getByRole("link", { name: "Start a submission" })).toHaveAttribute("href", "/");
  });
});
