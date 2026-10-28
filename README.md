# Publication Studio

A Summit Software Solutions product. Working name — final name TBD.

Two-user web app that helps a wedding photographer get published: tracks weddings with rights, consent, and exclusivity states; encodes per-publication submission specs; generates prep-and-queue submission packages that a human reviews and sends. Built with a wedding photographer as design partner zero.

## Status

**Phase:** 1 (Package engine) - built, deployed, awaiting the first real send.

- SPA: https://ryankolean.github.io/publication-studio/
- API: a Cloudflare Worker, auth-gated on every route except `/health`

Built and verified in a browser: sign-in, the guided wizard from choosing a
wedding to recording the outlet's reply (eleven steps, each with a "What to do
here" box naming the exact controls, and a first-visit welcome on the home
page), the ten seeded publications with live-verified specs, response
windows and tags, and the queue. The wizard is the only path: the older
event, package and intake pages were removed on 2026-10-22, and "How it
works" prints the full step-by-step guide from the same copy the screens
use.

Phase 1 is done by definition when one real submission goes out using only
the tool. That needs the photographer's first event and gallery.

Next: Phase 2, exclusivity ledger, response tracking, withdrawal workflow,
credit recovery.

Claude connector, step 1 of 4 (SUMMIT-343): sign-in, the MCP endpoint, the
audit log and three read tools, built and tested on workerd; not deployed
yet. See "Claude connector" below.

## Documents

- `docs/publication-studio-design.md` — full product design v1.0: architecture, data model, state machines, workflows, risks, roadmap. Read this first.
- `docs/phase-0-prompt.md` — the executable Phase 0 implementation brief for Claude Code.
- `research/README.md`: the publication research files, one per outlet, and the rules every fact follows.
- `docs/specs/claude-native.md`: the Claude connector spec, copied from Jira SUMMIT-342 (the source of truth).
- `CLAUDE.md` — conventions and directional guidance for Claude Code sessions in this repo.

## Structure

```
/web   — React + Vite + TS + Tailwind SPA → GitHub Pages
/api   — Cloudflare Worker (Hono) + D1 + R2 → wrangler
/docs  — design + implementation briefs
/research  outlet research files (source of truth) and the tag and location vocabularies
```

## Working on it

```
npm install
npm test          # 479 tests across both workspaces
npm run typecheck
npm run build     # includes a check that no secret reached the SPA bundle
npm run dev:api   # local Worker on :8787, against local D1
npm run dev:web   # SPA on :5173
```

Migrations run with `npm run migrate:local --workspace @publication-studio/api`.

Outlet research lives in `research/` (see `research/README.md`). Load it into
the app with `npm run research:import --workspace @publication-studio/api --
--local` (or `--remote`), then approve the updates in the app.

Each wedding is tagged on the wizard's Look step, and "Your work" shows the
photographer's style profile and past features (SUMMIT-337). The tool calls
no AI service and holds no AI key. Suggested tags worked out from a wedding's
photos are prepared outside it, kept in the private folder, and loaded by the
operator with `npm run style:suggest --workspace @publication-studio/api --
--remote --file ../publication-studio-private/style/<wedding>.yaml` (format in
`api/scripts/suggest-tags.ts`); the photographer keeps or turns down each one.

The Outlet step ranks every outlet for the wedding (SUMMIT-336): outlets a
known fact rules out (where they cover, content type, earlier sharing, an
earlier answer, freshness, frequency) are listed apart with the reason; an
unknown fact becomes a question under "Check first", never a no; the rest are
scored out of 100 on style, her history with the outlet, reach, fees, local
focus and season. `npm run match:report --workspace @publication-studio/api --
--date YYYY-MM-DD --location <geo code>` ranks the research files for a
wedding without the app.

## Claude connector

The photographer can run the studio from her own Claude account, on the free
plan, with no API key anywhere (`docs/specs/claude-native.md`). The Worker is
an OAuth 2.1 server and a remote MCP server at `<api origin>/mcp`: she adds
that URL in Claude as a custom connector, signs in with her studio email and
password, and allows. Only Claude can register or be approved; anything else
is refused.

There are three read tools (SUMMIT-343), `studio_overview`, `list_weddings`
and `get_wedding`, and two that write (SUMMIT-344): `save_wedding` creates or
changes a wedding through the web app's own routes, and
`confirm_permissions` records her two permission answers in two steps. The
first call shows exactly what will be recorded and returns a code; only a
second call with that code, from her, within 15 minutes, records it, once.
Every call is written to `audit_log` (entity `mcp_tool`) before anything is
returned.

Photos never go through the chat. `get_upload_link` gives her a link to a page
on the Worker (`/upload`) for one wedding, once her permission answers say
yes. She drags in her web-size exports there, and her browser makes a 256
pixel JPEG preview of each one. The link lasts 24 hours, takes up to 200
photos, ends when she presses "I'm finished", and a new link for the same
wedding replaces it. Its token is in the URL fragment and only its hash is
stored. `review_photos` shows Claude those previews twelve at a time.
Photos stored without a preview (before migration 0012, or added in the web
app) get one from `node api/scripts/backfill-previews.mjs --remote --item
<1password id>`, which uses the local ImageMagick and skips photos that already
have one.

Tags are suggested in the chat, not by the studio. `get_wedding` shows where a
wedding's tags stand (kept, not kept, and the ones its date, place or the
operator suggest), and with `tag_choices` the vocabulary still open to her.
Claude suggests from that list after looking at the photos, and `set_tags`
records only what she keeps or drops, in one batch through
`PUT /style/events/:id/tags`, the same rows the Look screen writes.

The OAuth store is the KV namespace `OAUTH_KV`, already created and bound in
`api/wrangler.jsonc`. `PUBLIC_ORIGIN` there must be the origin Claude
connects to. Every token is bound to it, so moving to a custom domain means
reconnecting.

To connect, in Claude on the web or the desktop app: Customize, Connectors,
Add custom connector, paste
`https://publication-studio-api.ryan-kolean.workers.dev/mcp`, Connect, sign
in, Allow. Ten failed sign-ins within 15 minutes pause connecting for 15
minutes; the web app's own sign-in is unaffected. New client registrations
(10 an hour) and sign-in pages (15 an hour) are capped studio-wide, so nobody
can use up the OAuth store's 1,000 free KV writes a day.

To disconnect: `GET /connections` lists her Claude connections and
`DELETE /connections/:id` ends one at once, with a web app sign-in token.
The settings screen for these comes in a later step.

Locally, `npm run dev:api` serves the connector too, with
`PUBLIC_ORIGIN=http://localhost:8787` in `api/.dev.vars`. Claude cannot reach
localhost, so `npm run test:runtime --workspace @publication-studio/api`
drives the whole connect flow on workerd instead.

Staging is a second Worker with its own database, OAuth store and bucket
(`env.staging` in `api/wrangler.jsonc`), for trying the connector in Claude
without touching the real studio. Its connector URL is
`https://publication-studio-api-staging.ryan-kolean.workers.dev/mcp`. From
`api/`: `npx wrangler d1 migrations apply publication-studio-db-staging --remote
--env staging`, then `npx wrangler deploy --env staging`. Its users and data
are test-only.

## Users

There is no signup. A user row is created only by an operator with database
credentials:

```
npm run seed-user --workspace @publication-studio/api -- \
  --email someone@example.com --name "Their Name" --role photographer --local
```

That prints a single-use invite link, valid for seven days, which lets the
person choose their own password. No email addresses are committed to this
repository.

For a development sign-in, `ensure-test-account.mjs` keeps the credentials in
1Password instead:

```
npm run test-account --workspace @publication-studio/api -- --remote
```

It creates the 1Password item on first run, generating the password there,
then makes the account match: seeds the user if absent, spends a fresh invite
through the real endpoint, revokes any other outstanding invite, and confirms
the credentials sign in. Re-running does nothing if the account already works,
so it is safe as a precondition for a test run. `--reset` forces a new
password. The value is never printed, never passed as an argument, and never
stored outside 1Password.

## Non-negotiables

- Prep + queue only. This app never sends a submission; a human clicks send.
- No client images, gallery URLs, invite tokens, or data files in this repo — ever.
- All gate logic (rights, exclusivity) lives server-side.
- Secrets in Wrangler env vars only.
