# Publication Studio — Product Design & Development Roadmap
**Working name:** Publication Studio (alternatives: Pressroom, Featured, The Ledger)
**Authors:** Summit Software Solutions, with a wedding photographer as design partner
**Status:** Hardened design — ready for Phase 0 development
**Version:** 1.0 — August 16, 2026

---

## 1. Problem Statement

Wedding photographers win bookings and pricing power through editorial features, but getting published is an operations problem disguised as a creative one. Every publication has different specs (image counts, sizes, forms, exclusivity rules), submissions take hours each, response windows stretch 4–8+ weeks, and one exclusivity mistake can burn a wedding for every better outlet. Human publicists (Published + Pretty, Tea with Jainé) solve this for $150–$400+ per wedding by supplying judgment and process. Aggregators (Two Bright Lights, $170/yr) solve distribution but not strategy, curation, or tracking.

Our design partner is an experienced wedding photographer with publication-grade work — including images already published under lead photographers' names from second-shooter jobs — but no system for handling submissions. Her inventory of own-contract, feature-worthy weddings is small, and her target outlet list is well defined.

The design partner supplies domain expertise and is design-partner-zero; Summit supplies the build. Both get full logins and tooling.

## 2. Goals and Non-Goals

**Goals (v1):**
- G1. Track every submission-eligible wedding with rights, consent, and exclusivity status — zero ambiguity about what can be sent where.
- G2. Encode per-publication specs for the partner's 8 target outlets so packaging is checklist-driven, not memory-driven.
- G3. Generate a complete, copy-paste-ready submission package per (wedding, publication) pair.
- G4. Prep + queue only: a human reviews and clicks send. The system logs sends and tracks responses.
- G5. Manage the credit-request workflow for the photographer's second-shooter published work.
- G6. Architecture that generalizes to photographer N+1 without rewrite (multi-tenant-ready data model, single-tenant v1).

**Non-Goals (v1):**
- No automated sending of any kind (no email automation, no portal bots). Revisit in v2 for email-only outlets.
- No public marketing site, billing, or self-serve signup.
- No full gallery re-hosting — we reference her gallery platform and store only curated selections as web-size derivatives.
- No styled-shoot planning features (v2 candidate — styled shoots are the standard fix for thin inventory).
- No AI auto-matching in Phase 0–1 (rule-based first; Claude API assist in Phase 3).

## 3. Background & Market

**Human publicists (the comp for value):** Published + Pretty (Kristen Green) — full-service submission handling, 900+ features, sells $25 templates and $150–250 guides including a maintained publication-guidelines library ("The Pink Pages"). Tea with Jainé — per-wedding curation service, 7–10 business day turnaround, limited monthly slots. Both prove the market pays for judgment + process. Their weakness: human throughput, per-wedding pricing, no client-side tooling.

**Aggregators (the comp for distribution):** Two Bright Lights ($170/yr, owned by The Knot) — submit to many publications, integrates with Dropbox/ShootProof/Zenfolio/SmugMug. Known complaint: publishers sit on submissions and don't release them. Matchology — similar space. Their weakness: no strategy, no per-wedding sequencing, no exclusivity intelligence, no credit management.

**Our position:** the publicist's judgment as software — strategy, curation support, exclusivity discipline, and credit recovery — with the human kept in the send loop.

**Design partner's target publications (seed database):**

| Publication | Tier | Method | Known specs (as of Aug 2026) |
|---|---|---|---|
| Carats & Cake | Primary | Portal (account) | Web-size images only, no watermarks, tag all vendors, upload 3–5 at a time, complete form in one session; 4–8 wk review; non-features become profile Albums (≤20 img); all submissions feed "Cherry" discovery |
| Over The Moon | Primary | Web form | Aspirational-but-authentic, fashion-forward; couple's love story central; form + guidelines on site |
| The Anti-Bride | Primary | Web form / email | Nontraditional, modern, fashion-focused; worldwide submissions |
| The Lane | Primary | Web form / email | Luxury/editorial international aesthetic |
| Brides | Primary* | Varies | *Design partner flagged paid-placement dynamics — tag as paid/earned per opportunity |
| Wezoree | Secondary | Portal | Destination-story friendly |
| Wed Vibes | Secondary | Web form | Newer, fashion-forward + destination energy |
| Loverly | Secondary | Web form | 25–40 curated images, editorial lens on details/fashion/design, full vendor credits prioritized, event description required, video via Vimeo/YouTube links; $59/mo Plus = priority review (do not buy for v1) |
| People / Vogue | Dream | Pitch/PR | Out of v1 scope; requires news hook or celebrity angle; revisit opportunistically |

Every spec row carries `last_verified` and gets re-verified before first use and quarterly thereafter (see §10 Risks).

## 4. High-Level Architecture

```
[Browser SPA]  ← GitHub Pages (static, public repo, code only — never images/data)
      │ HTTPS (JWT)
[Cloudflare Worker API]  ← all auth, business logic, signed URL issuance
      │
 ┌────┴─────────┬───────────────┐
[D1 (SQLite)]  [R2 (images)]  [Claude API (Phase 3)]
```

- **Frontend:** React + Vite SPA, deployed to GitHub Pages via Actions. Contains zero secrets and zero data. Served from the project path on github.io for now; a custom domain is deferred to the end of the roadmap (see §12, Phase 4).
- **API:** Single Cloudflare Worker (Hono router). All reads/writes gated by auth middleware. CORS locked to the Pages origin.
- **Auth:** Two seeded users. Email + password (bcrypt in D1) issuing short-lived JWT + refresh token. No signup endpoint exists in v1 (attack surface removed). Passwords set via seeded invite links.
- **Images:** R2 bucket, private. Uploads and reads go **through the Worker**, authorised by a short-lived capability token (15-min TTL) bound to one object and one purpose. R2's Worker binding cannot presign; presigning would need S3-API access keys, a second long-lived credential to store and rotate. Proxying keeps the bucket private with no keys outside Wrangler, at the cost of Worker CPU per image. Reversible: real presigned URLs would change how the URL is produced, not how the app consumes it. Only curated, web-size derivatives are stored (matches publication requirements and keeps costs ~zero). Originals stay in the photographer's gallery platform; we store the reference link.
- **Secrets:** Workers environment variables / Wrangler secrets only. Nothing client-side. (House rule.)

**Why this stack holds:** static hosting is free and zero-maintenance; Workers+D1+R2 free tiers cover two users indefinitely; the Worker boundary means going multi-tenant later is a data-model change, not an architecture change.

## 5. Data Model (D1)

```sql
users(id, email, name, role, pw_hash, created_at)

events(
  id, slug, couple_names, event_date, venue_name, city, state, country,
  gallery_url,                -- source of truth for originals (Pixieset/Pic-Time/etc.)
  style_tags,                 -- json: ["editorial","destination","documentary",...]
  unique_angle,               -- text: the story hook (attacks the "lack of unique" rejection)
  rights_status,              -- ENUM: unverified | own_contract | second_shooter | blocked
  consent_status,             -- ENUM: unverified | granted | granted_limited | declined
  consent_notes,              -- e.g., "no last names", "no family photos"
  prior_exposure,             -- json: {own_blog: bool, ig_posted: bool, prior_pubs: [...]}
  exclusivity_state,          -- derived, see state machine
  created_at, updated_at
)

vendor_credits(id, event_id, role, business_name, website, instagram)

publications(
  id, name, tier,             -- primary | secondary | dream
  method,                     -- portal | web_form | email | aggregator
  submission_url, contact_email,
  spec_json,                  -- {img_min, img_max, size, watermarks, video, fields[...]}
  exclusivity_policy,         -- ENUM: exclusive_required | exclusive_preferred | non_exclusive | unknown
  counts_own_blog_as_published, -- bool | unknown
  typical_response_days,      -- e.g., C&C 28–56
  earned_or_paid,             -- earned | paid | mixed
  taste_notes,                -- editorial fit guidance
  last_verified, active
)

submissions(
  id, event_id, publication_id,
  status,                     -- see lifecycle state machine
  package_id, queued_at, sent_at, sent_by,
  response_due_at,            -- sent_at + typical_response_days
  outcome_at, outcome_notes,
  published_url
)

packages(
  id, event_id, publication_id,
  image_keys,                 -- ordered R2 keys of curated selection
  description_md,             -- couple story / event description draft
  credits_block_md,           -- formatted vendor credit list
  checklist_json,             -- per-pub requirements with checked state
  version, created_at
)

credit_requests(              -- second-shooter credit recovery
  id, feature_url, publication_name, lead_photographer, lead_contact,
  status,                     -- draft | sent | granted | declined | no_response
  message_md, sent_at, outcome_at
)

audit_log(id, user_id, entity, entity_id, action, detail_json, at)
```

## 6. State Machines (the resilience core)

**6.1 Rights gate (per wedding)** — packaging is BLOCKED unless `rights_status = own_contract` AND `consent_status IN (granted, granted_limited)`. `second_shooter` weddings are permanently routed to the credit-request workflow, never the submission workflow. The UI shows blocked weddings with exactly what's missing. This is enforced in the API layer, not just the UI.

**6.2 Submission lifecycle**

```
draft → ready → queued → sent → accepted → published
                          │        └→ declined → (wedding released)
                          │        └→ expired (response_due passed)
                          │              └→ withdraw_pending → withdrawn → (released)
                          └→ cancelled
```

- `ready` requires: package checklist 100% complete + rights gate green + exclusivity check green.
- `sent` is recorded by a human with one tap ("I sent this") capturing timestamp + who.
- `expired` fires a task: send the outlet a polite withdrawal note (template provided) before submitting elsewhere — protects editor relationships and mirrors the known TBL "publisher sits on it" failure mode.

**6.3 Exclusivity ledger (per wedding)**
- A wedding with a live submission (`sent`, pre-outcome) at a publication whose `exclusivity_policy = exclusive_required` is HARD-LOCKED: no other package for that wedding can move past `ready`.
- `exclusive_preferred` outlets produce a soft warning requiring explicit override with a logged reason.
- `prior_exposure` interacts with `counts_own_blog_as_published`: if an outlet counts her own blog/IG as published and the wedding was posted, the matcher excludes that pairing and says why.
- Every state change writes to `audit_log`. Exclusivity disputes are reputation-fatal; the ledger is the product's spine.

## 7. Core Workflows

**7.1 Wedding intake — what we ask the photographer for (per wedding):**
1. Gallery link + access (platform TBD — Pixieset/Pic-Time/Cloudspot determines import path)
2. Rights: was she the contracted lead? Does her client contract permit editorial submission?
3. Couple consent: written OK to submit; name display preference; any off-limits images/people
4. Couple's story: how they met, proposal, design inspiration, personal touches (or forward our 6-question form to the couple)
5. Full vendor list: role, business name, website, Instagram (publications prioritize complete credits)
6. Date, venue, city — and whether it reads as a "destination" story
7. Prior exposure: on her blog? posted to IG? submitted anywhere ever?
8. Her 10–15 hero image picks + what she thinks made this wedding unique
9. Video content available? (Carats & Cake social loves it; Loverly accepts Vimeo/YouTube links)
10. Her instinct: dream outlet for this wedding + acceptable alternates

Items 1–7 are required for the rights/exclusivity gates; 8–10 feed matching and curation.

**7.2 Curate → Package:** curation board shows the gallery (embedded link v1; imported thumbs v2); Users select and order images per the target pub's `spec_json` (e.g., Loverly 25–40 editorial-lens; C&C "as many as possible," web-size, variety). Package generator assembles: ordered image set (validated against min/max, size, watermark rules), description draft, credits block, per-pub checklist. Nothing reaches `ready` until every checklist item is checked.

**7.3 Match & sequence:** v1 is rules + judgment: the tool filters eligible (rights-green, exclusivity-green) pairings, sorts by tier and fit tags, and shows the photographer's own strategy tiers. The human picks. Sequencing guidance: lead with the strongest wedding at its best-fit primary outlet; never burn a Carats & Cake-caliber wedding on a secondary while a primary slot is open.

**7.4 Send & track:** queue view groups `ready` packages. Human opens the pub's form/portal in a new tab, uses the package as copy-paste source, taps "Sent." Dashboard shows: live submissions with days-remaining, expired ones needing withdrawal, released weddings needing a next target.

**7.5 Credit recovery (second-shooter):** log each feature URL where the photographer's images ran under another name; generate a warm, no-pressure request to the lead photographer asking to add a "Second photographer" credit; track outcomes. Fastest path to growing her press page — zero new submissions required.

## 8. API Surface (v1)

```
POST /auth/login | /auth/refresh
GET/POST/PATCH /events, /events/:id
POST /events/:id/images            → signed R2 upload URLs
GET/POST/PATCH /publications
POST /packages (event_id, publication_id) → validates gates, builds checklist
PATCH /packages/:id                → curation edits, checklist state
POST /submissions                  → only from ready packages; runs exclusivity check server-side
PATCH /submissions/:id             → mark sent / outcome / withdraw
GET /dashboard                     → live submissions, due dates, blocked weddings, next actions
GET/POST/PATCH /credit-requests
```

All mutations audit-logged. All gate logic server-side; the SPA is untrusted.

## 9. Error Handling, Security, Observability, Testing

- **Errors:** Worker returns typed error codes (`RIGHTS_BLOCKED`, `EXCLUSIVITY_LOCKED`, `SPEC_UNVERIFIED`, `VALIDATION`); SPA renders the reason and the unblock path. D1 writes are transactional per request; no partial packages.
- **Security:** two users, no signup; bcrypt + short-lived JWT; CORS pinned; R2 private with 15-min signed URLs; images never in git; secrets in Wrangler env; couple PII limited to what submissions require; consent notes honored in packaging (e.g., first-names-only rendering).
- **Backups:** nightly D1 export to R2 (7 daily / 4 weekly retained). R2 image loss is non-fatal (originals live in the gallery platform).
- **Observability:** Workers logs + a `/health` endpoint; weekly digest task (submissions aging, specs older than 90 days). Proportionate to a two-user system.
- **Testing:** unit tests on the two state machines and the package validator (the load-bearing logic); one Playwright smoke: login → create wedding → build package → queue. CI on the repo.

## 10. Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Publication specs drift / forms change | High | Med | `last_verified` on every spec; verify before first use + quarterly; broken-URL check in weekly digest |
| Exclusivity violation | Low (with ledger) | High | Hard locks server-side; audit log; withdrawal-before-resubmit workflow |
| Rights/consent error (submitting what she can't) | Med without gate | High | Rights gate blocks packaging; second-shooter weddings can't enter submission flow |
| Outlet sits on submission indefinitely | High | Med | `response_due_at` + expiry → withdrawal template (known TBL failure mode, designed for) |
| Thin inventory (~5 weddings) | Certain | Med | Sequencing discipline; credit-recovery adds press without inventory; styled shoots as v2 pipeline filler |
| GH Pages public repo | Certain | Low (by design) | Repo contains code only; enforced by review + .gitignore on any data path |

## 11. Alternatives Considered

- **Just buy Two Bright Lights ($170/yr):** covers multi-pub distribution but none of: strategy, curation, exclusivity intelligence, credit recovery, or the partnership product ambition. May still be worth $170 as a *supplementary channel* — the ledger can track TBL-routed submissions as `method: aggregator`.
- **Hire Published + Pretty per wedding:** proves willingness-to-pay; doesn't build an asset; wrong side of the trade for a software partnership.
- **Airtable/Notion no-code MVP:** faster to stand up, but no rights/exclusivity enforcement, no path to product, and the design partner deserves better than a shared spreadsheet. Rejected consciously; the D1 schema is barely more work.
- **Full automation (portal bots):** rejected for v1 — ToS risk, fragility, and prep+queue captures ~90% of the time savings.

## 12. Roadmap

**Phase 0 — Foundation (this week, starts on gallery links):**
- Repo + GH Pages + Worker + D1 + R2 scaffold; auth with two seeded users
- Schema migration v1; seed the 8-publication database with researched specs (`last_verified = seed date`)
- Wedding intake form (the §7.1 checklist as a form) + inventory dashboard with rights/consent badges
- Non-code: rights triage of the partner's existing weddings; collect her second-shooter feature URLs; verify each primary pub's current submission page
- *Done when:* the photographer logs in, her weddings are entered with rights states, and the pub database renders with live spec checklists.

**Phase 1 — Package engine (weeks 2–3):**
- Curation board (gallery embed + selection ordering); R2 upload of curated web-size derivatives
- Package generator with per-pub checklist validation; description + credits-block editor
- Queue view; "mark sent" flow; audit log
- *Done when:* one real submission to a primary outlet goes out using only the tool.

**Phase 2 — Tracking & recovery (weeks 4–5):**
- Exclusivity ledger enforcement + response-window tracking + withdrawal workflow
- Credit-request module end-to-end; first credit asks actually sent
- Nightly backups, weekly digest, Playwright smoke in CI
- *Done when:* dashboard is the single source of truth for "what's live where, what's due, what's next."

**Phase 3 — Intelligence (weeks 6–8):**
- Claude API: curation suggestions (variety/spec coverage), story drafting from couple questionnaire, per-pairing fit rationale
- Reporting: acceptance rate, time-to-response per outlet
- *Done when:* packaging a new wedding takes <30 min of human time.

**Phase 4 — Generalization (when the design partner has ≥1 acceptance):**
- Multi-tenant data model activation; photographer onboarding-from-website flow (the original "start from any portfolio" requirement); pricing design informed by Published + Pretty / Tea with Jainé comps
- Custom domain: move the SPA off the github.io project path and the API off workers.dev, onto a domain on Cloudflare DNS, with `workers_dev = false` and `ALLOWED_ORIGIN` updated to match. Deferred here deliberately — it is presentation, and nothing upstream of it is blocked by the current URLs.
- *Gate:* do not generalize before the tool has produced a real feature for the design partner. Proof first.

## 13. Open Questions (decisions required)

1. ~~Business terms~~ **SETTLED** between the partners; the terms and remaining paperwork are tracked outside this repository.
2. ~~Product name~~ **SETTLED:** Publication Studio. The repository, the Cloudflare resources, and the SPA all carry it.
3. ~~Gallery platform~~ **SETTLED:** Pic-Time on a custom domain, using invite-token links. No public gallery API → Phase 1 uses link-embed for viewing + manual export of curated web-size selections into R2. Invite-token URLs are treated as secrets: stored server-side only, never client-logged.
4. **Couple consent language** — does her client contract already grant editorial submission rights, or do we need a per-couple consent form (template needed either way)?
5. **Brides paid-placement stance** — tool tags earned vs. paid; the *policy* (ever pay?) is the photographer's call.

---

## Appendix A — Changelog (hardening record)

**Phase 2 additions (structural):** Goals/Non-Goals; API surface; full data model; error handling; security; observability; testing; alternatives; risk register.
**Phase 3 fixes (technical):** images moved out of any repo path → R2-only with signed URLs; auth reduced to seeded two-user (signup endpoint removed as attack surface); gallery originals referenced, not re-hosted; web-size derivatives only.
**Phase 4 resolutions (continuity):** "prep + queue" enforced consistently — removed draft's Phase-3 email automation implication; second-shooter weddings routed exclusively to credit-recovery, never submission flow.
**Phase 5 autoheals:** rights gate designed as server-side state machine (was a metadata field); exclusivity ledger with hard/soft locks + own-blog-counts nuance; expiry → withdrawal workflow (TBL failure mode); spec versioning with `last_verified` + quarterly re-verification; sequencing guidance for thin inventory.
**Phase 6 adversarial (survived):** "Why not just Two Bright Lights?" — answered in §11 with TBL kept as optional channel; "ChatGPT commoditizes strategy" — moat placed in operational layer (§7), strategy is the front-end; "5 weddings can't sustain a product" — credit recovery + styled shoots + Phase 4 gate on proof.
**2026-10-19:** table and routes renamed from wedding to event per SUMMIT-312.
**Flagged for authors:** §13 items 1–5.

**Confidence: HIGH** for Phase 0–2 build; **MEDIUM** for Phase 3–4 (depends on partner outcomes and business terms).
