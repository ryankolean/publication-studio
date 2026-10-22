# Guided Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-time photographer signs in and is walked from choosing a wedding to recording the outlet's reply, with every screen saying what to do and no other path to wander into.

**Architecture:** One copy module (`web/src/wizard/guide.ts`) feeds both the wizard `Frame` and the help page. The home page becomes the wedding chooser with one button per card that opens the wizard at the server-chosen step. The older event detail, package editor, intake and submit pages are deleted. The API gains two list fields and four kinder messages, nothing else.

**Tech Stack:** React 18, Vite 5, Tailwind v4, HashRouter, Vitest + Testing Library (web); Hono 4 on Cloudflare Workers with D1, Vitest with real migrations via node:sqlite (api).

**Spec:** `docs/superpowers/specs/2026-10-22-guided-wizard-design.md`

## Global Constraints

- Public repo: no partner name, business, gallery vendor, or email address in any file this plan adds or edits. The photos copy says "your gallery", never a vendor.
- Her-facing copy never contains: package, attestation, intake, inventory, event, derived, pool, grant, emojis, em dashes, exclamation marks. She reads: wedding, submission, outlet, photos, write-up, credits, checks.
- Warm second person. Disabled reason pattern: "Add the write-up to continue." Error pattern: what happened, then what to do, no codes.
- A guide line may quote only a control that renders on that screen in the state the line describes.
- The tool never sends. The rights gate and one-outlet-at-a-time rules are untouched.
- TypeScript strict. Conventional commits via `git commit -F <file>` with the usual co-author trailer. No `--no-verify`.
- Run tests from the repo root with `npm test --workspace @publication-studio/web` and `npm test --workspace @publication-studio/api`; a single file with `npx vitest run <path>` inside the workspace.

## Review Focus

1. A wedding whose only submission was declined: chip `ready`, `hasPackage` true. The welcome must stay collapsed and the card button must read "Start this one" and open `/wizard/:id`. Test in Task 6.
2. A published wedding: the card must open `/wizard/:id?package=<id>` so the server resumes on the track screen, not the outlet chooser. Tests in Tasks 1 and 6.
3. An outlet with no submission page (`method: null`): the send guide must not tell her to press a link that is not there. Test in Task 5.
4. A photographer with no weddings at all: the home page shows the welcome and "Add a wedding" and nothing else breaks. Test in Task 6.
5. A long couple name on a phone: cards and the guide block wrap, no horizontal scroll at 375. Checked in Task 10 (browser), with the Frame test in Task 4 asserting `break-words` on the guide list.

---

### Task 1: List fields `hasPackage` and `chip.packageId`

**Files:**
- Modify: `api/src/domain/wizard.ts:139-146` (ChipPackage), `:148-216` (weddingChip)
- Modify: `api/src/routes/events.ts:247-293` (list route)
- Test: `api/test/wizard.test.ts`, `api/test/api-events.test.ts`

**Interfaces:**
- Produces: `interface ChipPackage { id: string; publicationName: string | null; submission: { status: SubmissionStatus } | null }`
- Produces: `weddingChip(event, vendorCreditCount, packages): { kind: ChipKind; label: string; packageId: string | null }` where `packageId` is the id of the package the label names (queued, live, accepted, published) and null otherwise.
- Produces: each item of `GET /events` gains `hasPackage: boolean` (true when the event has at least one package row).

- [ ] **Step 1: Write the failing domain tests** in `api/test/wizard.test.ts`, beside the existing chip tests:

```ts
it("names the package the chip describes", () => {
  const sent = { id: "pk2", publicationName: "Outlet A", submission: { status: "sent" as const } };
  const old = { id: "pk1", publicationName: "Outlet B", submission: { status: "declined" as const } };
  expect(weddingChip(complete, 1, [sent, old]).packageId).toBe("pk2");
  expect(weddingChip(complete, 1, [old]).packageId).toBeNull();
  const published = { id: "pk3", publicationName: "Outlet A", submission: { status: "published" as const } };
  expect(weddingChip(complete, 1, [published])).toMatchObject({ kind: "published", packageId: "pk3" });
});
```

Use whatever the file already calls its complete event fixture in place of `complete`. Existing chip assertions that use `toEqual({ kind, label })` change to `toMatchObject`.

- [ ] **Step 2: Run** `npx vitest run test/wizard.test.ts` in `api`. Expected: FAIL, `id` missing from ChipPackage and `packageId` undefined.

- [ ] **Step 3: Implement.** Add `id` to `ChipPackage`; return `packageId: open.id` / `published.id` / `null` from each branch of `weddingChip`. In `events.ts` the `packagesOf` rows already carry `id`; pass them through and add `hasPackage: (packagesOf.get(row.id) ?? []).length > 0` beside `inProgress`.

- [ ] **Step 4: Write the failing route test** in `api/test/api-events.test.ts` next to "is in progress while...":

```ts
it("says whether a wedding has ever had a package, and which one the chip names", async () => {
  const id = (await create(complete))["id"] as string;
  expect((await list())[0]).toMatchObject({ hasPackage: false, chip: { packageId: null } });
  await packageFor(id, "pk1", "pub-loverly");
  await submissionFor(id, "pub-loverly", "published");
  expect((await list())[0]).toMatchObject({ hasPackage: true, chip: { kind: "published", packageId: "pk1" } });
  await db.prepare("UPDATE submissions SET status = 'declined'").run();
  expect((await list())[0]).toMatchObject({ hasPackage: true, inProgress: false, chip: { kind: "ready", packageId: null } });
});
```

- [ ] **Step 5: Run** `npx vitest run test/api-events.test.ts test/wizard.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(api): list says which package a chip names and whether a wedding has one`

### Task 2: Kinder server messages

**Files:**
- Modify: `api/src/routes/submissions.ts:131`, `api/src/routes/packages.ts:282`, `api/src/routes/images.ts:106,181`
- Test: whichever files under `api/test` pin those strings (`grep -rn "not complete\|cannot be packaged\|still uses this image" api/test`)

**Interfaces:**
- Produces the exact strings:
  - submissions 422 PACKAGE_INCOMPLETE: "This submission is not ready yet. Finish the final checks first."
  - packages and images 403 RIGHTS_BLOCKED: "This wedding cannot go to an outlet yet."
  - images 409 IMAGE_IN_USE: "This photo is still part of a submission. Take it out of that submission first."

- [ ] **Step 1: Change the pinned strings in the tests first**, run `npm test --workspace @publication-studio/api`. Expected: FAIL on those assertions only.
- [ ] **Step 2: Change the four messages.** Error codes stay as they are.
- [ ] **Step 3: Run the api suite and the runtime smoke** `npm run test:runtime --workspace @publication-studio/api`. Expected: PASS, 22 checks.
- [ ] **Step 4: Commit** `fix(api): say wedding, submission and photo in the messages she reads`

### Task 3: The copy module

**Files:**
- Create: `web/src/wizard/guide.ts`
- Test: `web/src/wizard/guide.test.ts`

**Interfaces:**
- Produces:

```ts
export interface StepGuide { title: string; lead: string; todo: string[]; next: string; note?: string }
export const GUIDE: Record<StepId, StepGuide>;
export const WELCOME: { title: "Welcome"; lead: string; journey: string[]; closing: string };
export const RULES: string[];                 // the five POINTS from HelpPage.tsx, unchanged
export const BANNED: RegExp;                  // /\b(package|attestation|intake|inventory|event|derived|pool|grant)s?\b|[—!]|\p{Extended_Pictographic}/iu
```

Copy comes verbatim from spec section 4 and the Welcome block, with these corrections, which win over the spec:
- send todo 3: `Open the outlet's page: press the button under step 3 if there is one. If the outlet has no page, the screen says how it takes submissions.` (No quoted control: the button carries the outlet's name.)
- track todo 3: `Once the feature is live, paste the link into "Live link" and press "Record it".`
- confirm todo 3 keeps `"Not done"` and `"Fix this"` as the screen renders them.
- review todo 2: `To change something, press that step in the progress bar at the top.`

`WELCOME.closing` is "Each screen tells you exactly what to do. Choose a wedding below to begin."

- [ ] **Step 1: Write the failing test** `guide.test.ts`:

```ts
it("has a guide for every step, in the wizard's order", () => {
  expect(Object.keys(GUIDE)).toEqual([...STEPS]);
  for (const step of STEPS) {
    const guide = GUIDE[step];
    expect(guide.todo.length).toBeGreaterThanOrEqual(1);
    expect(guide.todo.length).toBeLessThanOrEqual(5);
    expect(guide.next.startsWith("Next up:")).toBe(true);
  }
});
it("never uses a banned word, an em dash, an exclamation mark or an emoji", () => {
  const lines = [...Object.values(GUIDE).flatMap((g) => [g.title, g.lead, ...g.todo, g.next, g.note ?? ""]), WELCOME.lead, ...WELCOME.journey, WELCOME.closing, ...RULES];
  for (const line of lines) expect(line, line).not.toMatch(BANNED);
});
```

- [ ] **Step 2: Run** `npx vitest run src/wizard/guide.test.ts` in `web`. Expected: FAIL, module missing.
- [ ] **Step 3: Write `guide.ts`.** Every `next` value starts with "Next up:". The track step's next is "Next up: nothing. This wedding is done, or free for another outlet."
- [ ] **Step 4: Run the test.** Expected: PASS. If a line fails the banned check, reword it; do not loosen the regex.
- [ ] **Step 5: Commit** `feat(web): one copy module for the wizard and the guide`

### Task 4: Frame renders the guide

**Files:**
- Modify: `web/src/wizard/Frame.tsx:93-140` (FrameProps, Frame), `:30-70` (Rail)
- Modify: `web/src/wizard/screens/shared.tsx` (NeedsEarlier)
- Test: `web/src/wizard/Frame.test.tsx` (create)

**Interfaces:**
- Produces:

```ts
interface FrameProps {
  guide: StepGuide;
  /** Replaces guide.title on screen when the outlet's name belongs in it. */
  title?: string;
  rail?: RailProps | null; back?: string | null; primary?: PrimaryAction | null;
  after?: ReactNode; children?: ReactNode;
}
```
- Rendering order: step line (`Step N of M: Label`, from `rail.steps` and `rail.current`, omitted when `rail` is null), rail, `h2` title, lead, `<section aria-label="What to do here">` with `h3` "What to do here", `<ol>` of `todo`, `note` as a `p` under it, children, footer, then `<p>` "Next up: ..." under the footer while `primary` is null or its `disabledReason` is not null, else omitted.
- `NeedsEarlier` props become `{ ctx, guide, title?, message, step, linkLabel }`.

- [ ] **Step 1: Write the failing tests** `Frame.test.tsx` (render inside `MemoryRouter`):

```ts
const guide = { title: "Pick the photos", lead: "Why.", todo: ["Press \"Add photos\".", "Tap each photo."], next: "Next up: the write-up.", note: "A note." };
const rail = { eventId: "w1", packageId: null, current: "photos" as const, steps: STEPS.map((id, i) => ({ id, done: i < 4 })) };

it("says which step this is, lists what to do, and what comes next", () => {
  render(<MemoryRouter><Frame guide={guide} rail={rail} primary={{ label: "Continue", onClick: () => {}, disabledReason: "Pick a photo to continue." }} /></MemoryRouter>);
  expect(screen.getByText("Step 5 of 10: Photos")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Pick the photos" })).toBeInTheDocument();
  const box = screen.getByRole("region", { name: "What to do here" });
  expect(within(box).getAllByRole("listitem").map((li) => li.textContent)).toEqual(['Press "Add photos".', "Tap each photo."]);
  expect(within(box).getByText("A note.")).toBeInTheDocument();
  expect(screen.getByText("Next up: the write-up.")).toBeInTheDocument();
  expect(within(box).getByRole("list")).toHaveClass("break-words");
});
it("lets a screen put the outlet's name in the heading", () => {
  render(<MemoryRouter><Frame guide={guide} title="Send it to Outlet A" /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "Send it to Outlet A" })).toBeInTheDocument();
});
it("drops the next-up line once Continue is enabled", () => {
  render(<MemoryRouter><Frame guide={guide} primary={{ label: "Continue", onClick: () => {}, disabledReason: null }} /></MemoryRouter>);
  expect(screen.queryByText("Next up: the write-up.")).toBeNull();
});
```

- [ ] **Step 2: Run** `npx vitest run src/wizard/Frame.test.tsx`. Expected: FAIL (`guide` prop unknown).
- [ ] **Step 3: Implement** the props and rendering order above. The step line is `text-xs font-medium uppercase tracking-wide text-slate-500`. The box is `rounded-lg border border-slate-200 bg-slate-50 p-4`, the list `list-decimal space-y-1 pl-5 text-sm break-words text-slate-800`. Update `NeedsEarlier` to take `guide` and pass it through. Leave the ten screens broken for Task 5; the type checker will list them.
- [ ] **Step 4: Run the Frame test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the wizard frame carries what to do here and what comes next`

### Task 5: Every screen uses its guide, and the labels are proven

**Files:**
- Modify: all ten files in `web/src/wizard/screens/*Screen.tsx` (each `Frame`/`NeedsEarlier` call site), `web/src/wizard/screens/ConfirmScreen.tsx:27-36` (PLAIN_LABEL)
- Modify: existing screen tests that pin old leads (`DetailScreens.test.tsx`, `OutletPhotos.test.tsx`, `WriteupConfirm.test.tsx`, `ReviewSendTrack.test.tsx`, `WizardRoutes.test.tsx`)
- Test: `web/src/wizard/screens/guide-labels.test.tsx` (create)

**Interfaces:**
- Consumes `GUIDE` from Task 3 and `Frame { guide, title? }` from Task 4.
- Send and confirm keep their dynamic headings via `title`: `Send it to ${outlet}` and `Final checks for ${outlet}` (confirm's lead moves into GUIDE; its heading gains the outlet).
- `PLAIN_LABEL` gains `grants_publication_rights: "Confirm you are giving the outlet the right to publish these photos"`.

- [ ] **Step 1: Write the failing label test.** For each step, render the screen in the state its guide describes (reuse `serve`, `walkthrough`, `wizardAt`, `storedEvent`, `packageView` from `test-utils`) and assert every quoted label in `GUIDE[step].todo` is on screen:

```ts
const quoted = (lines: string[]) => lines.flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
// one `it` per step; the fixture per step:
// wedding: /wizard/w1/wedding with storedEvent
// permissions, story: same, with the walkthrough at that step
// outlet: wizardAt("outlet"), gate open, OUTLET_A and OUTLET_B listed
// photos: packageView with two pool images and one selected
// writeup, review: packageView as the existing tests open them
// confirm: a checklist with one attested item unticked and one derived item not done (so "Not done" and "Fix this" render)
// send: packageView with submission { status: "queued" } and OUTLET_A (has a page)
// track: wizardAt("track") with submission { status: "sent" } for "Accepted"/"Declined"; a second render with status "accepted" for "Live link" and "Record it"
it(`${step}: every quoted control is on the screen`, async () => {
  await open(step);
  for (const label of quoted(GUIDE[step].todo)) {
    expect(screen.queryByRole("button", { name: label }) ?? screen.queryByRole("link", { name: label }) ?? screen.queryByLabelText(label) ?? screen.queryByText(label, { exact: false }), label).not.toBeNull();
  }
});
```

Add one more: `send: an outlet with no page` renders with `OUTLET_B` (method null) and asserts the send guide's third line is on screen and no link named "submission page" is.

- [ ] **Step 2: Run it.** Expected: FAIL on every step (screens still pass `title`/`lead`).
- [ ] **Step 3: Migrate each screen** to `guide={GUIDE.<step>}`, removing its `TITLE`/`LEAD` constants and `lead=` literals. Keep every other prop. Fix `NeedsEarlier` call sites.
- [ ] **Step 4: Update the older screen tests** that assert the removed leads (search for each old lead string) to assert the new `GUIDE[step].lead` instead, by importing GUIDE rather than retyping copy. Confirm's heading assertion becomes "Final checks for Outlet A".
- [ ] **Step 5: Run** `npm test --workspace @publication-studio/web` and `npx tsc -p web --noEmit` (or the workspace's typecheck script). Expected: PASS, no type errors.
- [ ] **Step 6: Commit** `feat(web): every wizard screen says what to do here`

### Task 6: Home page

**Files:**
- Create: `web/src/pages/HomePage.tsx` (from `wizard/screens/StartScreen.tsx`), `web/src/pages/HomePage.test.tsx`
- Delete: `web/src/pages/DashboardPage.tsx`, `DashboardPage.test.tsx`, `web/src/wizard/screens/StartScreen.tsx`
- Modify: `web/src/App.tsx` (routes, nav label), `web/src/wizard/test-utils.tsx:62-66` (routes stub)

**Interfaces:**
- Consumes `GET /events` items `{ id, coupleNames, eventDate, chip: { kind, label, packageId }, hasPackage, inProgress }` and `GET /submissions` for the queue line.
- Produces `export function HomePage()`, and in the same file:

```ts
export const CARD_ACTION: Record<ChipKind, { button: string; next: string }> = {
  ready:         { button: "Start this one",          next: "Everything is in place. Choose an outlet when you are ready." },
  needs_details: { button: "Finish the details",      next: "A few details are still missing. The next screen shows which." },
  blocked:       { button: "See what is holding it",  next: "This wedding is on hold until its permissions are in place." },
  queued:        { button: "Send it",                 next: "Your submission is ready. Send it to the outlet, then mark it sent." },
  live:          { button: "Record the reply",        next: "Waiting on the outlet. Record the answer when it comes." },
  accepted:      { button: "Add the live link",       next: "Accepted. Paste the link once the feature is live." },
  published:     { button: "See how it went",         next: "Published. Nothing more to do here." },
};
export function cardHref(card: { id: string; chip: { kind: ChipKind; packageId: string | null } }): string
// `/wizard/${id}?package=${packageId}` when packageId is not null, else `/wizard/${id}`
```
- Welcome: `<section aria-label="Welcome">` with `h2` WELCOME.title, lead, `ol` of `journey`, closing, rendered while `events.every((e) => !e.hasPackage)`; otherwise a single `<p>` "Each screen tells you what to do. " with `<Link to="/help">How it works</Link>`.
- Queue line: `<p>` built from `GET /submissions`: counts of `ready|queued` as "N ready to send", `sent` as "N waiting on a reply", and "earliest due {friendlyDate}" when any `responseDueAt`; joined with ", "; followed by `<Link to="/queue">Open the queue</Link>`. Omitted when both counts are zero.
- Cards: `<ul aria-label="Your weddings">`, each `li` with `h3` couple names, friendly date, the chip (tones from StartScreen), `CARD_ACTION[kind].next`, and `<Link aria-label={`${button}: ${coupleNames}`}>` with the button text, styled `PRIMARY`.
- `/wizard` becomes `<Navigate to="/" replace />`. The nav's first link reads "Weddings". `/` renders `HomePage`.

- [ ] **Step 1: Write the failing tests** `HomePage.test.tsx` (copy the session/fake-api scaffolding from `DashboardPage.test.tsx` before deleting it):

```ts
it("welcomes a first-time photographer and offers her weddings", async () => {
  serve({ events: [card({ chip: { kind: "ready", label: "Ready to send", packageId: null }, hasPackage: false })] });
  renderHome();
  expect(await screen.findByRole("region", { name: "Welcome" })).toHaveTextContent("It never sends anything itself");
  expect(screen.getByRole("link", { name: "Start this one: Sarah and James" })).toHaveAttribute("href", "/wizard/w1");
  expect(screen.getByText("Everything is in place. Choose an outlet when you are ready.")).toBeInTheDocument();
});
it("collapses the welcome once any wedding has had a submission, even a declined one", async () => {
  serve({ events: [card({ chip: { kind: "ready", label: "Ready to send", packageId: null }, hasPackage: true, inProgress: false })] });
  renderHome();
  expect(await screen.findByRole("link", { name: "Start this one: Sarah and James" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Welcome" })).toBeNull();
  expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/help");
});
it("opens a published wedding on its own submission", async () => {
  serve({ events: [card({ chip: { kind: "published", label: "Published at Outlet A", packageId: "pk3" }, hasPackage: true })] });
  renderHome();
  expect(await screen.findByRole("link", { name: "See how it went: Sarah and James" })).toHaveAttribute("href", "/wizard/w1?package=pk3");
});
it("sums the queue in one line and hides it when there is nothing to say", ...);   // 2 ready, 1 sent with responseDueAt "2026-11-03" -> "2 ready to send, 1 waiting on a reply, earliest due November 3, 2026"
it("with no weddings at all shows the welcome and Add a wedding", ...);
```

- [ ] **Step 2: Run** `npx vitest run src/pages/HomePage.test.tsx`. Expected: FAIL, module missing.
- [ ] **Step 3: Build `HomePage.tsx`** from StartScreen's card list and DashboardPage's queue fetch. Delete `DashboardPage.tsx`, its test, and `StartScreen.tsx`. Update `App.tsx` routes and nav, and `test-utils.tsx` (the `/wizard` stub route becomes `<p>Home stub</p>` at `/`; drop the StartScreen import). Fix `WizardRoutes.test.tsx` assertions that expected `/wizard` to render "Choose a wedding".
- [ ] **Step 4: Run the web suite.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): home is the wedding chooser, one button per card`

### Task 7: Help page is the written guide

**Files:**
- Modify: `web/src/pages/HelpPage.tsx`
- Test: `web/src/pages/HelpPage.test.tsx` (create)

**Interfaces:**
- Consumes `GUIDE`, `RULES`, `WELCOME`, `RAIL_LABEL`, `STEPS`.
- Renders: `h2` "How it works", `WELCOME.lead`, `ul` of `RULES`, then one `<section aria-labelledby>` per step with `h3` `${index + 1}. ${guide.title}`, the lead, the `ol` of todo, the note, and the next line. Ends with `<Link to="/">Choose a wedding</Link>`.

- [ ] **Step 1: Write the failing test:**

```ts
it("prints every step with its instructions, in order", () => {
  render(<MemoryRouter><HelpPage /></MemoryRouter>);
  const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
  expect(headings).toEqual(STEPS.map((step, i) => `${i + 1}. ${GUIDE[step].title}`));
  expect(screen.getByText(GUIDE.send.todo[4])).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Choose a wedding" })).toHaveAttribute("href", "/");
});
```

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `POINTS` only as `RULES` in guide.ts; HelpPage imports it.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): How it works is the full step-by-step guide`

### Task 8: Delete the older pages, repoint the queue

**Files:**
- Delete: `web/src/pages/EventDetailPage.tsx`, `PackageEditorPage.tsx`, `IntakePage.tsx`, their `.test.tsx`, `web/src/components/RightsBadge.tsx`, `RightsBadge.test.tsx`
- Modify: `web/src/App.tsx` (drop `/events/*` and `/packages/:id` routes and imports), `web/src/wizard/WizardRoutes.tsx` (drop `SubmitRedirect`), `web/src/wizard/test-utils.tsx` (drop the submit stub route), `web/src/pages/QueuePage.tsx:54-60` (PackageLink), `web/src/pages/QueuePage.test.tsx`
- Modify: `web/src/components/SubmissionBadge.tsx` only if a label there uses a banned word

**Interfaces:**
- Queue rows: `PackageLink` becomes `OpenWedding({ submission })` rendering `<Link to={`/wizard/${submission.eventId}${packageId ? `?package=${packageId}` : ""}`}>Open this wedding</Link>`.

- [ ] **Step 1: Change the queue test** that asserted "Open package" to expect the link "Open this wedding" with href `/wizard/w1?package=pk1`. Run it; expected FAIL.
- [ ] **Step 2: Delete the files and routes listed.** Search `web/src` for any remaining import of the deleted modules and for `"/events/` and `"/packages/` in `.tsx` files; the wizard's API calls (`api.get(\`/events/...\`)`) stay, router links go.
- [ ] **Step 3: Run** the web suite, the typecheck, `npm run build --workspace @publication-studio/web`, and `node web/scripts/check-bundle.mjs` if the build script does not already. Expected: all PASS.
- [ ] **Step 4: Commit** `refactor(web): remove the pre-wizard pages; the queue opens the wizard`

### Task 9: Tone sweep

**Files:**
- Modify: whichever of `web/src/pages/QueuePage.tsx`, `PublicationsPage.tsx`, `LoginPage.tsx`, `SetPasswordPage.tsx`, `web/src/components/SubmissionBadge.tsx`, `web/src/wizard/**/*.tsx`, `web/src/api/client.ts` carry her-facing strings, plus their tests
- Test: existing tests updated; `web/src/tone.test.ts` (create)

**Interfaces:**
- Produces `web/src/tone.test.ts`, which reads every non-test `.ts`/`.tsx` under `web/src` with `fs`, extracts JSX text and string literals longer than 12 characters that contain a space, and asserts none matches `BANNED` from guide.ts, with an allow-list constant for identifiers that legitimately contain a banned word (`aria-label`s of the API path strings are excluded by requiring a space).

- [ ] **Step 1: Write `tone.test.ts`** as described and run it. Expected: FAIL, listing each offending string with its file.
- [ ] **Step 2: Reword each hit** in the warm second person. Known ones: the login and set-password error copy, "Could not load events.", "Window unknown" / "Window passed" in the queue (become "No reply window given" / "The reply window has passed"), `SubmissionBadge` labels, PublicationsPage headings and empty states. Keep server message passthroughs (`errorText`) untouched; Task 2 already fixed the server side.
- [ ] **Step 3: Update tests** that pinned the old strings.
- [ ] **Step 4: Run the web suite.** Expected: PASS, including `tone.test.ts`.
- [ ] **Step 5: Commit** `fix(web): warm plain wording everywhere she reads`

### Task 10: End-to-end run, screenshots, deploy

**Files:**
- Modify: `README.md` (Status), `docs/publication-studio-design.md` changelog (one line)

- [ ] **Step 1: Full suites.** `npm test --workspace @publication-studio/api`, `npm run test:runtime --workspace @publication-studio/api`, `npm test --workspace @publication-studio/web`, web build and bundle check. Expected: all green; record the counts.
- [ ] **Step 2: Local stack.** Start `publication-studio-api` and `publication-studio-web` from `~/.claude/launch.json` via `preview_start`. Reset the local D1 to a fresh user with no packages (`node api/scripts/seed-user.mjs --local ...` or the existing local verification user with its packages deleted).
- [ ] **Step 3: Drive the whole flow in the browser** with the fresh user, reading only what the screens say: sign in, welcome on home, "Start this one", wedding, permissions, story, outlet, photos (upload 3 of the private web-size files from outside the repo), write-up, final checks, review, "Add to the queue", send ("Download the photos", both copies, outlet page, "I sent it"), track ("Accepted", "Live link", "Record it"). Then home again: welcome collapsed, card reads "See how it went" and opens the track screen. Any moment that needs a guess is a defect: fix it, add a test, re-run.
- [ ] **Step 4: Screenshots** of home, photos, send and track at 375, 768 and 1280. At 375 assert `document.documentElement.scrollWidth === document.documentElement.clientWidth`. Console and `preview_logs` at error level empty.
- [ ] **Step 5: Grep** every file in `git diff --name-only <base>..HEAD` for the partner's name, business, gallery vendor and `@`-addresses. Expected: nothing.
- [ ] **Step 6: Update README Status and the design changelog**, commit `docs: guided wizard shipped`.
- [ ] **Step 7: Deploy.** Push `main`; from the detached worktree at the pushed commit run `wrangler deploy` (no migration), then `git push origin <hash>:main` for Pages. Confirm the production bundle contains "What to do here" and `GET /events` on production returns `hasPackage`.
- [ ] **Step 8: Production smoke** with `node api/scripts/show-status.mjs --remote`. Hand the sign-in link back.
