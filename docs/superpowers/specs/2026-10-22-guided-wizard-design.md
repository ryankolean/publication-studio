# Guided wizard: one path, every screen tells her what to do

Date: 2026-10-22. Status: draft for review.

## Intent

A photographer signs in for the first time, with nobody beside her, and is
walked from choosing a wedding to recording the outlet's reply. Every screen
says why it matters, exactly what to do, what the button does, and what comes
next. There is no second path to wander into.

The design partner's first run (2026-10-21) found the opposite: the wedding
names on the home page led to the older event detail and package editor
pages, and the guided wizard sat behind one small button. Once inside, each
wizard screen carried a single terse line.

## Goals

1. One path. Home is the wedding chooser. Every click on a wedding opens the
   wizard at its current step. The queue's links do the same.
2. Every wizard screen carries a "What to do here" block: why, numbered
   actions naming the exact controls on that screen, and a "Next up" line.
3. A first-visit welcome on the home page, and "How it works" grows into the
   complete written guide, generated from the same copy the screens use.
4. Warm second-person voice everywhere she reads: screens, button reasons,
   empty states, errors, chips.
5. The older pages are deleted, not hidden.

## Non-goals

- No new steps or rules. The rights gate, one outlet at a time, and "the
  tool never sends" stay exactly as they are. The API changes only in the
  three places named under "API changes" below.
- No visual redesign. Same Tailwind palette, same Frame layout, same rail.
- No role-based navigation. Admin and photographer see the same app.
- No per-browser storage for the welcome; it is derived from server state.

## Anti-goals (a failure even if it works)

- Walls of text. The guide block is at most five short numbered lines.
- Cutesy or apologetic copy, emojis, em dashes, exclamation marks.
- Jargon in anything she reads: no "package", "attestation", "intake",
  "inventory", "event", "derived", "pool", "grant". She sees "wedding",
  "submission", "outlet", "photos", "write-up", "credits", "checks".
- Naming the design partner, her business, her gallery vendor, or any email
  address anywhere in the repo.
- A guide line that names a button or field that is not on that screen.

## Constraints

- Public repo. Copy must read well for any photographer.
- `web` stack as is: React 18, Vite 5, Tailwind v4, HashRouter, Vitest with
  Testing Library. API untouched except where noted below.
- Conventional commits, committed with `git commit -F` and the usual
  co-author trailer.
- Deploy order after merge: `wrangler deploy` from a detached worktree (the
  API changes), then `git push origin <hash>:main` for Pages. No migration.

## The parts

### 1. One source of copy: `web/src/wizard/guide.ts`

```ts
export interface StepGuide {
  title: string;      // the screen heading
  lead: string;       // one or two warm sentences: why this step matters
  todo: string[];     // numbered actions, each naming its control by exact label
  next: string;       // "Next up: ..." shown under the footer
  note?: string;      // one reassurance or edge case, shown under the list
}
export const GUIDE: Record<StepId, StepGuide>;
export const WELCOME: { title: string; lead: string; journey: string[] };
export const RULES: string[];   // the five rules, from the current help page
```

Screens pass `guide={GUIDE[step]}` to `Frame` instead of `title` and `lead`.
The help page renders `RULES` then every `GUIDE` entry in step order. One
edit changes both.

`GUIDE` is static. Where a screen's controls depend on state (the send
screen's outlet link, the track screen's Accepted and Declined buttons and
its live-link field), the copy is written as a sequence ("When you hear
back, press...") so it reads true in every state, and the label test for
that step renders the state the line describes. A screen that names the
outlet in its heading today (send, confirm) keeps doing so: `Frame` accepts
an optional `title` override; `GUIDE` holds the plain heading the help page
prints.

### 2. Frame

`Frame` takes `guide: StepGuide` (replacing `title` and `lead`). It renders:

1. the rail, with a visible "Step N of 10: Name" line above it;
2. the heading and lead;
3. a bordered "What to do here" block: an ordered list of `todo`, then
   `note` in smaller text when present;
4. the task (children);
5. the footer with Back and Continue, Continue's disabled reason beside it;
6. "Next up: ..." in small text under the footer, only while Continue is
   disabled or the step is not finished.

`NeedsEarlier` (shown when a later step is opened without an outlet) keeps
the same shape with its own two-line guide.

### 3. Home page `/`

`DashboardPage` is replaced by a new `HomePage` built from the current
`StartScreen`:

- **Welcome block**, shown while no wedding has ever had a package (the
  list's new `hasPackage` flag is false on every wedding). Title "Welcome",
  the lead from `WELCOME`, the five-line journey, and "Each screen tells you
  exactly what to do. Choose a wedding below to begin." Once any wedding has
  a package, it collapses to one line with a link to "How it works". The
  welcome never depends on browser storage.
- **Queue line**, only when there is something to say: "2 ready to send, 1
  waiting on a reply, earliest due June 3." with "Open the queue". Replaces
  the "Action needed" strip.
- **Your weddings**: one card per wedding. Couple names, friendly date, the
  status chip, one sentence on what comes next, and one button that opens
  `/wizard/:id` (the server picks the step). Button label by chip kind:
  - ready: "Start this one"
  - needs_details: "Finish the details"
  - blocked: "See what is holding it"
  - queued: "Send it"
  - live: "Record the reply"
  - accepted: "Add the live link"
  - published: "See how it went"
- "Add a wedding" opens `/wizard/new/wedding`.

For `queued`, `live`, `accepted` and `published` the button opens
`/wizard/:id?package=<chip.packageId>`, so a published wedding lands on its
track screen rather than the outlet chooser (the server follows only open
packages when none is named). For the other kinds it opens `/wizard/:id`.

No radio buttons and no separate Continue; the card button is the action.
`/wizard` redirects to `/`. The nav's first item reads "Weddings".

### 4. Per-step copy

The builder places this copy verbatim, then verifies each named control
exists on that screen (a test asserts every bold label below appears in the
screen's render). Button and field labels are in quotes.

**wedding** "The wedding"
Lead: "A few details to start. Outlets print these exactly as you type them,
so use the names the couple would want to see."
1. Type the couple's names as they should appear in print.
2. Pick the wedding date.
3. Add the venue and the city, state and country.
4. Press "Continue".
Next up: your gallery and the couple's permission.

**permissions** "Your gallery and permissions"
Lead: "Two things every outlet asks before anything else. Honest answers
keep you safe: the wedding waits here until both are in place."
1. Paste the gallery link. It stays private and is never shown again.
2. Answer "Were you the lead photographer under your own contract?"
3. Answer "Has the couple agreed to a submission?" If they set limits, such
   as first names only, write them in. They follow the wedding onto every
   checklist.
4. Press "Continue".
Note: "If you were the second shooter, that is fine. The wedding stays on
hold here and nothing more is needed from you for now."
Next up: the story and the vendors.

**story** "The story and the vendors"
Lead: "What made this wedding its own, and who made it happen. One real
detail says more than five adjectives, and outlets will not publish without
full vendor credits."
1. Write a few lines on what stood out: a moment, a detail, a tradition.
2. Add every vendor: their role, business name, and website or Instagram if
   you have it.
3. Press "Continue".
Next up: choosing an outlet.

**outlet** "Choose an outlet"
Lead: "One outlet considers a wedding at a time, which is what most of them
expect. Start with the one you would love most."
1. Read the cards. Each shows what the outlet asks for and any warnings,
   such as exclusivity or a fee.
2. Tap the one you want.
3. Press "Continue".
Note: "If the wedding is on hold, this screen says why and where to fix it."
Next up: picking the photos.

**photos** "Pick the photos"
Lead: "The photos the outlet will see, in the order you want them seen."
1. In your gallery, select your favourites and download them at web size
   (around 1600 pixels on the long edge), not full size.
2. Press "Add photos" and choose the files you downloaded.
3. Tap each photo in the order you want it to appear, or press "Choose all".
4. Use the arrows to reorder.
5. Press "Continue" once the count fits the outlet's range, shown beside the
   button.
Next up: the write-up and credits.

**writeup** "Write-up and credits"
Lead: "Both are drafted from what you already entered. Make them sound like
you."
1. Read the write-up and change anything you like. Say what happened; the
   outlet's editor rewrites it anyway.
2. Check the credits: every vendor, spelled the way they spell it.
3. Press "Continue".
Next up: the outlet's final checks.

**confirm** "Final checks"
Lead: "These are the outlet's own rules, written as things to confirm. Each
tick saves on its own, so you can leave and come back."
1. Read each line.
2. Tick the ones you can confirm.
3. If a line says "Not done", press "Fix this". It takes you to the right
   screen and brings you back.
4. Press "Continue" once every line is ticked.
Next up: a last look before it goes in your queue.

**review** "Review"
Lead: "One last look before it goes in your queue. Nothing is sent from
here."
1. Read it top to bottom.
2. To change something, press that step in the progress bar at the top.
3. Press "Add to the queue".
Next up: sending it, your way.

**send** "Send it"
Lead: "You send it, the way you always have. The tool just gets everything
ready for you."
1. Press "Download the photos". You get a zip, numbered in your order.
2. Press "Copy the write-up", then "Copy the credits", and paste each where
   the outlet asks.
3. Open the outlet's page: press the button under step 3 if there is one. If
   the outlet has no page, the screen says how it takes submissions.
4. Fill in their form or email, attach the photos, paste the text, and send
   it from there.
5. Come back here and press "I sent it".
Note: "Nothing on this screen sends anything. It only records that you
did."
Next up: tracking the reply.

**track** "Track the reply"
Lead: "Now the waiting. The tool knows the outlet's usual window and will
say when a reply is overdue."
1. Nothing to do until you hear back.
2. When you do, press "Accepted" or "Declined" and add a note if you like.
3. Once the feature is live, paste the link into "Live link" and press
   "Record it".
Note: "Some outlets never reply. This screen says what silence means for
this one."
Next up: nothing. This wedding is done, or free for another outlet.

The builder reads each screen before placing its copy and corrects any
quoted label that differs from what renders (for example the send screen's
outlet link and the track screen's save button). The copy's meaning does not
change; only the quoted label does.

**Welcome**
Title "Welcome". Lead: "This tool gets a wedding ready for a publication and
keeps track of what happens next. It never sends anything itself; you stay
in charge of that." Journey: "Tell us about the wedding", "Choose an
outlet", "Pick the photos and shape the write-up", "Send it your way", "Track
the reply".

### 5. Tone sweep

Every string she can read in `web/src` is reviewed against the anti-goals:
disabled reasons, alerts, empty states, chips, badges, the queue and
publications pages, login and set-password. Pattern for a disabled reason:
"Add the write-up to continue." Pattern for an error: what happened and what
to do next, no codes. The builder keeps a list of changed strings in the PR
description.

Server messages the screens print verbatim are in scope too. Known ones:
"The package is not complete. Finish its checklist first." (submissions),
"This event cannot be packaged yet." (packages, images), "A package still
uses this image. Remove it from the package first." (images), and the
checklist item `grants_publication_rights`, which gets a plain label on the
confirm screen like the others. API tests that pin those strings change with
them.

### 5a. API changes (the only ones)

1. `GET /events`: each event gains `hasPackage: boolean` and, when the chip
   describes a package, `chip.packageId`.
2. The messages listed in the tone sweep.
3. Nothing else. No migration, no new route, no change to the rules.

### 6. Deletions

- `web/src/pages/DashboardPage.tsx`, `EventDetailPage.tsx`,
  `PackageEditorPage.tsx`, `IntakePage.tsx`, and their tests.
- `SubmitRedirect` and routes `/events/new`, `/events/:id`,
  `/events/:id/edit`, `/events/:id/submit`, `/packages/:id`.
- The queue's "Open the package" link becomes a button that opens
  `/wizard/:eventId` (the queue already has `eventId`).
- Components used only by the deleted pages go with them. `RightsBadge` and
  `SubmissionBadge` stay if the queue or home still use them.
- Shared test helpers in `wizard/test-utils.tsx` that only served the
  deleted pages go too.

The API keeps every route; `/events/:id` and `/packages/:id` still serve the
wizard.

### 7. Verification

Builder's bar before calling it done:

1. `npm test` in `web` and `api` green, plus the runtime smoke.
2. New tests: Frame renders the guide block and "Step N of 10"; home shows
   the welcome only before any package exists and the right button label per
   chip; help page lists every step; every quoted label in `GUIDE[step].todo`
   appears in that step's render; removed routes redirect to `/`.
3. Browser run on the local stack with a fresh local user: sign in, land on
   home with the welcome, press the card button, complete all ten steps to a
   recorded live link, using only what the screens say. Any moment the
   builder has to guess is a defect to fix.
4. Screenshots of home, photos, send and track at 375, 768 and 1280, no
   horizontal scroll at 375, console and server logs clean.
5. A grep of every file this change adds or edits for the partner's name,
   business, gallery vendor, and any email address returns nothing. Files
   the change does not touch (research notes, migrations, CLAUDE.md, test
   fixtures with example addresses) are out of scope.

## Calls the builder may make

- Exact Tailwind classes for the guide block and the step line.
- How the home page derives "what comes next" per chip (a small map beside
  the button labels).
- Whether `NeedsEarlier` shares `Frame`'s guide block or a two-line version.
- Order of the tone-sweep edits.
- Exact kinder wording of the server messages, within the anti-goals.

## Calls made in this design, to check while reading

- The gallery vendor is not named. The photos step says "your gallery" and
  gives a pixel size instead.
- The welcome is derived from server state, not stored in the browser.
- Wedding cards get one button each; no radio list and no second Continue.
- The nav's first item is "Weddings".
- The older pages are deleted outright.
- The API changes in two small ways (list flags, kinder messages) so the
  home page can land every card where its button promises and the welcome
  is derived from server state. Everything else server-side is untouched.
