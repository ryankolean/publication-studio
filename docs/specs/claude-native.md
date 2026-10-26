# Submission Studio: Claude-Native Integration Spec

**Claude Code: this ticket is the full spec. First commit it verbatim to** `docs/specs/claude-native.md` in repo `ryankolean/submission-studio`. Phase tickets are under epic SUMMIT-297 with label `claude-native`.

## 1. Goal

Let the design partner run Submission Studio from her own Claude account by talking to it in plain language. Her Claude session logs in once, then does the work: building packages, organizing galleries, ranking publications, drafting stories, and running client and vendor communication. The design partner stays in control of anything that leaves the studio.

## 2. Hard constraints

* **Zero extra cost to the design partner.** Must work fully on the Claude Free plan.
* **No API keys.** The design partner never handles keys, tokens, or config files.
* **One connector.** Free plan allows exactly one custom connector, so the studio is exposed as a single remote MCP endpoint. Never split into multiple connectors.
* **Works on web and desktop.** No local MCP servers, no Claude Desktop config files.
* **Low hosting cost.** Free or near-free tiers.
* **Design partner only for now.** Single tenant.

## 3. Architecture

* Remote MCP server built into the existing app backend at `https://<studio-domain>/mcp`, Streamable HTTP transport.
* Official MCP TypeScript SDK (or Python SDK if the backend is Python; match the repo).
* MCP layer is a thin wrapper over existing service functions; web UI and Claude share code paths.
* Auth: OAuth 2.1 with PKCE and dynamic client registration (required by Claude custom connectors). The design partner clicks Connect, logs in, approves.
* Short-lived access tokens, rotated refresh tokens, revocable from a Connected Apps page.
* Every tool call written to an audit log (tool, input summary, result, timestamp).

## 4. Free-plan design rules

* Coarse-grained tools: one tool per whole step.
* Compact responses: summaries and IDs; `detail` flag for more.
* Server does the heavy lifting: photo analysis, tagging, fit scoring, validation.
* Resumable work: long jobs return a job ID and status.
* Small tool count (about 19 max) with clear names and descriptions.

## 5. Tool catalog (v1)

### Read and plan (no confirmation)

* `studio_overview`: active weddings, queue status, pending actions, deadlines.
* `list_weddings` / `get_wedding`
* `find_publications`: filter by region, style, content type, freshness window.
* `get_publication`: summary by default, full record with `detail=true`.
* `rank_publications_for_wedding`: hard filters + soft scores, with reasons.
* `get_action_items`: everything waiting on the design partner, couples, or vendors.
* `get_metrics`: submission, response, acceptance rates, time to response.

### Build and draft (no confirmation, reversible)

* `create_wedding`: name, date, location (dropdown values), vendors.
* `import_gallery`: from Pic-Time, Pixieset, ShootProof, Dropbox, Google Drive links; server fetches and analyzes.
* `get_upload_link`: one-time direct upload URL; large images never go through chat.
* `suggest_tags` / `set_tags`
* `build_package_draft`: assembles and validates against outlet requirements, lists gaps.
* `draft_story` / `draft_message`
* `set_queue`: one-at-a-time publication queue from the design partner's ranking.

### Outbound (always require the design partner's explicit approval)

* `send_for_approval`: couple/vendor questionnaire or approval links.
* `submit_package`: submit or prepare guided route (Two Bright Lights, Matchology, email).
* `push_to_gallery`: publish selected images to the design partner's client gallery.

## 6. Confirmation model

* Outbound tools use two steps: first call returns a preview and confirmation token; second call with token executes, only after the design partner says yes.
* Tokens single-use, expire in 15 minutes.
* Tool annotations mark read-only vs destructive.
* Later: a studio setting lets the design partner loosen this per action.

## 6a. Guided planning mode (plan first, act second)

Default for every multi-step request.

### Flow

1. The design partner describes what she wants in any words.
2. Claude calls `plan_request` with her words and any identified wedding/publication.
3. Server returns 3 to 7 numbered plain-sentence steps, each marked "I'll do this" or "I need you to", plus open questions.
4. Claude shows the plan as numbered, asks questions, waits.
5. The design partner approves, edits, or skips steps; Claude calls `revise_plan`.
6. Claude calls `run_plan_step` one at a time, one-line result each. Outbound steps still use section 6.
7. `studio_overview` gives a two-line summary at the end.

### Plan format rules

* Numbered steps only, no jargon, no field names, no data dumps.
* Max 7 steps; longer jobs split into stages.
* Plans stored with an ID so the design partner can resume in a new chat ("continue my Macon plan").

### New tools

* `plan_request`, `revise_plan`, `run_plan_step`, `explain` (plain-language explanation of any concept or field).
* Server-side plan templates: new wedding intake, pick publications, build package, submit, follow up, post-acceptance.

### Keeping token cost low

* Publication encyclopedia never goes into Claude's context in full.
* Precomputed 2 to 3 sentence summary and short fact card per outlet.
* Tool responses under about 500 tokens by default, with paging.
* Stable short IDs for weddings, plans, publications.
* Model-agnostic: works on the Free plan's default model, better on stronger models like Opus.

### Starter instructions for the design partner's Claude Project

Ship a ready-to-paste block: always plan first with `plan_request`, numbered plain steps, never run outbound steps without her yes, short replies, one question at a time.

## 7. Client communication pipeline

* Couples and vendors keep using no-account email links.
* Outbound email via free-tier transactional provider (Resend or Postmark), reply-to the design partner's business email.
* Each party sees only their scoped section.
* Optional later: connect the design partner's inbox to detect editor replies, pending her consent.

## 8. Onboarding for the design partner (under five minutes)

1. Create a free Claude account if needed.
2. Customize > Connectors > Add custom connector.
3. Paste the studio URL, click Connect.
4. Log in with her studio account and approve.
5. Try a starter prompt.

In-app one-page guide with screenshots and starter prompts:

* "What needs my attention in Submission Studio today?"
* "Import this gallery for the Macon wedding and suggest tags: <link>"
* "Which publications fit the Macon wedding best, and why?"
* "Build a package for the top publication and tell me what's missing."

## 9. Security and privacy

* HTTPS only; tokens scoped to the design partner's account.
* No bulk return of couple/vendor contact details.
* Rate limit the endpoint; guard against registration abuse.
* Secrets in environment variables, never client side.
* Instant revocation from studio settings.

## 10. Hosting and cost

* Deploy alongside the existing app; prefer free tiers (Vercel, Render, Fly.io, Cloudflare Workers).
* Photo storage on Cloudflare R2 or similar.
* Target near-zero running cost.

## 11. Build phases

* **Phase 1: foundation.** OAuth, MCP endpoint, audit log, `studio_overview`, `list_weddings`, `get_wedding`. Verify connection from a Free account.
* **Phase 2: proof of concept.** Blake and Anne Macon wedding end to end: `import_gallery`, `get_upload_link`, tagging, ranking, `build_package_draft`, `draft_story`, plus guided planning tools.
* **Phase 3: outbound.** Two-step confirmation, `send_for_approval`, `submit_package`, `push_to_gallery`, email provider.
* **Phase 4: polish.** Onboarding guide, starter prompts, Project instructions, `explain`, metrics, Connected Apps page.

## 12. Acceptance criteria

* The design partner connects from a Claude Free account with only a URL and her login.
* No API key anywhere in her setup.
* Macon wedding goes from gallery link to a validated, ready-to-submit package entirely through chat via guided plans.
* No outbound action without her explicit yes.
* Every tool call in the audit log.
* A full package workflow fits within one Free plan session.

## 13. Open questions for the design partner (also in SUMMIT-298)

* Does she have a Claude account, and which plan?
* Which gallery platform does she use for client delivery?
* Which actions would she want automated without asking, once comfortable?
* OK for outbound email from the studio with replies to her inbox?
