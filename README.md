# Publication Studio

A Summit Software Solutions product. Working name — final name TBD.

Two-user web app that helps a wedding photographer get published: tracks weddings with rights, consent, and exclusivity states; encodes per-publication submission specs; generates prep-and-queue submission packages that a human reviews and sends. Built with a wedding photographer as design partner zero.

## Status

**Phase:** 1 (Package engine) - built, deployed, awaiting the first real send.

- SPA: https://ryankolean.github.io/publication-studio/
- API: a Cloudflare Worker, auth-gated on every route except `/health`

Built and verified in a browser: sign-in, the guided wizard from choosing a
wedding to recording the outlet's reply (ten steps, each with a "What to do
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

## Documents

- `docs/publication-studio-design.md` — full product design v1.0: architecture, data model, state machines, workflows, risks, roadmap. Read this first.
- `docs/phase-0-prompt.md` — the executable Phase 0 implementation brief for Claude Code.
- `research/README.md`: the publication research files, one per outlet, and the rules every fact follows.
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
