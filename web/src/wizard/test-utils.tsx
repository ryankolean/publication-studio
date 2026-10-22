import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";

import { ApiError, type ApiClient } from "../api/client.js";
import { createSession, type StorageLike } from "../auth/session.js";
import { SessionProvider } from "../session-context.js";
import { STEPS, type StepId, type Walkthrough, type WizardState } from "./model.js";
import { WizardNewWedding, WizardResume, WizardStep } from "./WizardRoutes.js";

function fakeStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, v) => void entries.set(k, v),
    removeItem: (k) => void entries.delete(k),
  };
}

type Mock = ReturnType<typeof vi.fn>;
export interface FakeApi {
  get: Mock;
  post: Mock;
  patch: Mock;
  delete: Mock;
  putBytes: Mock;
}

export const fakeApi = (): FakeApi => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  putBytes: vi.fn(),
});

/**
 * Answers GET by exact path. A function answer is called each time, so a
 * test can change what the server says between reads; an Error is thrown.
 */
export function serve(api: FakeApi, answers: Record<string, unknown>) {
  api.get.mockImplementation(async (path: string) => {
    if (!(path in answers)) throw new ApiError(404, "NOT_FOUND", `unexpected ${path}`);
    const answer = answers[path];
    const value = typeof answer === "function" ? (answer as () => unknown)() : answer;
    if (value instanceof Error) throw value;
    return value;
  });
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

/** The wizard's routes as App mounts them, plus stubs for where they lead. */
export function renderWizard(api: FakeApi, entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SessionProvider session={createSession(fakeStorage())} api={api as unknown as ApiClient}>
        <Routes>
          <Route path="/" element={<p>Home stub</p>} />
          <Route path="/wizard/new/wedding" element={<WizardNewWedding />} />
          <Route path="/wizard/:eventId" element={<WizardResume />} />
          <Route path="/wizard/:eventId/:step" element={<WizardStep />} />
        </Routes>
        <LocationProbe />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** A wizard state with every step up to (not including) `step` done. */
export function wizardAt(step: StepId, overrides: Partial<WizardState> = {}): WizardState {
  const index = STEPS.indexOf(step);
  return {
    step,
    finished: false,
    packageId: index > STEPS.indexOf("outlet") ? "pk1" : null,
    steps: STEPS.map((id, i) => ({ id, done: i < index })),
    blocked: null,
    outlet:
      index > STEPS.indexOf("outlet")
        ? {
            id: "pub-a",
            name: "Outlet A",
            method: "web_form",
            submissionUrl: "https://a.example.com/submit",
            typicalResponseDays: 28,
            warnings: [],
          }
        : null,
    submission: null,
    reply: null,
    ...overrides,
  };
}

export const OUTLET_A = {
  id: "pub-a",
  name: "Outlet A",
  tier: "primary",
  method: "web_form",
  imgMin: 30,
  imgMax: 40,
  typicalResponseDays: 28,
  tasteNotes: "Loves winter light and real moments. Avoids anything staged.",
  warnings: [] as Array<{ code: string; text: string }>,
};

export const OUTLET_B = {
  id: "pub-b",
  name: "Outlet B",
  tier: "dream",
  method: null,
  imgMin: null,
  imgMax: null,
  typicalResponseDays: null,
  tasteNotes: null,
  warnings: [
    { code: "no_public_route", text: "No public submission route: reaching this outlet is a pitch to an editor, not a form." },
  ],
};

export function walkthrough(wizard: WizardState, overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    event: { id: "w1", coupleNames: "Sarah and James" },
    packages: [],
    outlets: [OUTLET_A, OUTLET_B],
    wizard,
    ...overrides,
  };
}

/** GET /events/:id for a wedding whose record is complete. */
export const storedEvent = (overrides: Record<string, unknown> = {}) => ({
  id: "w1",
  coupleNames: "Sarah and James",
  eventDate: "2026-06-14",
  venueName: "The Barn",
  city: "Detroit",
  state: "MI",
  country: null,
  styleTags: ["editorial"],
  uniqueAngle: "A ceremony on a frozen lake.",
  rightsStatus: "own_contract",
  consentStatus: "granted",
  consentNotes: null,
  nameDisplay: null,
  coupleStory: null,
  isDestination: false,
  heroPicks: "The veil shot",
  videoUrl: null,
  targetOutletNotes: null,
  priorExposure: { ownBlog: true, igPosted: false, priorPubs: [] },
  hasGalleryUrl: true,
  vendorCredits: [{ role: "Florist", businessName: "Stems", website: null, instagram: "stems" }],
  ...overrides,
});

/** GET /packages/:id. */
export const packageView = (overrides: Record<string, unknown> = {}) => ({
  id: "pk1",
  eventId: "w1",
  publicationId: "pub-a",
  publication: {
    id: "pub-a",
    name: "Outlet A",
    method: "web_form",
    submissionUrl: "https://a.example.com/submit",
    spec: { imgMin: 2, imgMax: 3 },
  },
  imageKeys: [] as string[],
  descriptionMd: "Sarah and James married on the ice.",
  creditsBlockMd: "Florist: Stems",
  consent: { nameDisplay: null, consentNotes: null },
  checklist: [] as unknown[],
  complete: false,
  missing: [] as string[],
  submission: null as unknown,
  ...overrides,
});

export const location = (screen: { getByTestId: (id: string) => HTMLElement }) =>
  screen.getByTestId("location").textContent;
