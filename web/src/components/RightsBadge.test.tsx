import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GateReasons, RightsBadge, type Gate } from "./RightsBadge.js";

const blocked = (route: string, reasons: Array<{ code: string; remedy: string }>): Gate => ({
  allowed: false,
  code: "RIGHTS_BLOCKED",
  route,
  reasons: reasons.map((r) => ({ ...r, field: "rights_status" })),
});

describe("RightsBadge", () => {
  it("says a green event is ready", () => {
    render(<RightsBadge gate={{ allowed: true }} />);
    expect(screen.getByText("Ready to package")).toBeInTheDocument();
  });

  it("says blocked when the event can still be fixed", () => {
    render(<RightsBadge gate={blocked("submission", [{ code: "X", remedy: "Do the thing." }])} />);
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("distinguishes a second-shooter event from a merely blocked one", () => {
    render(
      <RightsBadge gate={blocked("credit_recovery", [{ code: "X", remedy: "Log a credit request." }])} />,
    );
    expect(screen.getByText("Credit recovery only")).toBeInTheDocument();
  });

  it("falls back to blocked for an unrecognised route", () => {
    render(<RightsBadge gate={blocked("something_new", [{ code: "X", remedy: "y" }])} />);
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });
});

describe("GateReasons", () => {
  it("renders nothing for a green event", () => {
    const { container } = render(<GateReasons gate={{ allowed: true }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every remedy the server supplied", () => {
    render(
      <GateReasons
        gate={blocked("submission", [
          { code: "RIGHTS_UNVERIFIED", remedy: "Confirm she was the contracted lead." },
          { code: "CONSENT_DECLINED", remedy: "The couple declined." },
        ])}
      />,
    );
    expect(screen.getByText("Confirm she was the contracted lead.")).toBeInTheDocument();
    expect(screen.getByText("The couple declined.")).toBeInTheDocument();
  });
});
