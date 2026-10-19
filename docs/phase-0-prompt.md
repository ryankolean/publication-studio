# Implement: Publication Studio — Phase 0 (Foundation)

**Repo:** this repository (see CLAUDE.md bootstrap if no remote exists yet)
**Reference:** `docs/publication-studio-design.md` (v1.0). This brief is self-sufficient for Phase 0; consult the design doc for rationale and later phases.

## Overview
Two-user web app helping a wedding photographer get published: tracks weddings with rights/consent/exclusivity states, encodes per-publication submission specs, and (in later phases) generates prep+queue submission packages a human sends. Stack: React + Vite SPA deployed to GitHub Pages via Actions; Cloudflare Worker API (Hono) + D1 + R2 via Wrangler. Phase 0 delivers the foundation: scaffold, auth, schema, seeded publication database, wedding intake, inventory dashboard.

## Tasks
1. Monorepo scaffold: `/web` (Vite + React 18 + TS + Tailwind), `/api` (Worker + Hono + TS), Wrangler config with D1 + R2 bindings, GitHub Action deploying `/web` to Pages
2. Auth: two seeded users in D1, bcrypt password hashes, short-lived JWT + refresh token, login endpoint, auth middleware on all routes. NO signup endpoint — user creation is seed-migration only
3. D1 migrations for: users, events, vendor_credits, publications, submissions, packages, credit_requests, audit_log (field details below)
4. Publication seed migration: 8 outlets with specs (below)
5. Wedding intake form (10-section form matching the intake checklist below) + wedding inventory dashboard with rights/consent status badges
6. CI: typecheck + unit tests on gate logic + Pages deploy on main

## Schema (key fields; full DDL guidance in design doc §5)
- `events`: couple_names, event_date, venue_name, city, state, gallery_url, style_tags (json), unique_angle, rights_status ENUM(unverified|own_contract|second_shooter|blocked), consent_status ENUM(unverified|granted|granted_limited|declined), consent_notes, prior_exposure (json: own_blog, ig_posted, prior_pubs), created/updated timestamps
- `vendor_credits`: event_id, role, business_name, website, instagram
- `publications`: name, tier(primary|secondary|dream), method(portal|web_form|email|aggregator), submission_url, contact_email, spec_json, exclusivity_policy ENUM(exclusive_required|exclusive_preferred|non_exclusive|unknown), counts_own_blog_as_published (bool|null), typical_response_days, earned_or_paid, taste_notes, last_verified, active
- `submissions`: event_id, publication_id, status ENUM(draft|ready|queued|sent|accepted|published|declined|expired|withdraw_pending|withdrawn|cancelled), package_id, queued_at, sent_at, sent_by, response_due_at, outcome_at, outcome_notes, published_url
- `packages`: event_id, publication_id, image_keys (json), description_md, credits_block_md, checklist_json, version
- `credit_requests`: feature_url, publication_name, lead_photographer, lead_contact, status ENUM(draft|sent|granted|declined|no_response), message_md, sent_at, outcome_at
- `audit_log`: user_id, entity, entity_id, action, detail_json, at

## Publication seed data (set last_verified to the date you run the migration)
1. Carats & Cake — primary, portal. Spec: web-size only, no watermarks, tag all vendors, no strict image count (more is better), video folder boosts social consideration. typical_response_days=56. exclusivity_policy=unknown. earned.
2. Over The Moon — primary, web_form (blog.overthemoon.com/submissions). Taste: aspirational-but-authentic, fashion-forward, couple story central. earned.
3. The Anti-Bride — primary, web_form. Taste: nontraditional, modern, fashion-focused, worldwide. earned.
4. The Lane — primary, web_form. Taste: luxury international editorial. earned.
5. Brides — primary, method TBD. earned_or_paid=mixed (surface paid-placement flag in UI).
6. Wezoree — secondary, portal. Taste: destination stories. earned.
7. Wed Vibes — secondary, web_form. Taste: fashion-forward + destination. earned.
8. Loverly — secondary, web_form (loverly.com/tools/submit-wedding). Spec: 25–40 curated images, editorial lens on details/fashion/design, full vendor credits prioritized, event description required, video via Vimeo/YouTube links. earned.

## Intake form sections (per wedding)
1 gallery link, 2 rights (lead-contracted? contract permits editorial?), 3 couple consent + name display + off-limits notes, 4 couple story, 5 vendor list (role/name/site/IG, repeatable rows), 6 date/venue/city + destination flag, 7 prior exposure (own blog / IG / prior submissions), 8 hero picks + unique angle, 9 video availability, 10 target outlet instinct

## Decisions already made
- Prep + queue only — the app never sends anything; humans click send at the outlet
- Images live only in R2 (private, Worker-issued signed URLs, 15-min TTL) — never in the git repo; Phase 0 needs the bucket binding + signed-URL endpoint stubbed, not the curation UI
- gallery_url values contain Pic-Time invite tokens — treat as secrets: server-side only, never in client-side logs or error messages
- All gate logic (rights, exclusivity) enforced in the API layer; SPA is untrusted
- Rights gate: packaging blocked unless rights_status=own_contract AND consent_status in (granted, granted_limited); second_shooter weddings route to credit_requests only
- Secrets in Wrangler env vars only, nothing client-side
- Single-tenant now, but keep the data model clean for multi-tenant later (no hardcoded user assumptions in queries)
- No emojis anywhere in UI

## Out of scope (later phases — do not build now)
- Curation board, package generator, queue/send flow (Phase 1)
- Exclusivity ledger enforcement, withdrawal workflow, response tracking (Phase 2)
- Claude API features, reporting (Phase 3)
- Multi-tenant, billing, marketing site (Phase 4)

## Definition of done
- [ ] `npm run dev` boots SPA + local Worker (wrangler dev) end to end
- [ ] Both seeded users can log in; all API routes reject unauthenticated requests
- [ ] All 8 tables migrated; publication seed renders in a Publications view with spec details and last_verified
- [ ] A wedding can be created via the intake form and appears on the dashboard with correct rights/consent badges
- [ ] Unit tests pass for the rights-gate check and submission-status transition validator
- [ ] Pages deploy workflow green; `wrangler deploy` succeeds
- [ ] Zero images, tokens, or data files committed to the repo
