# Publication research

One YAML file per outlet in `publications/` is the source of truth for what
Publication Studio knows about it. The files are reviewed here in GitHub, then
loaded into the app database, where nothing new or changed goes live until a
person approves it in the app (SUMMIT-335).

```
research/
  publications/<id>.yaml   one file per outlet, named for its id (pub-brides.yaml)
  vocab/tags.yaml          the shared tag vocabulary for outlets and weddings
  vocab/geo.yaml           location codes for coverage and the wedding location
```

A complete example of every field is
[`api/test/fixtures/research/pub-example-weddings.yaml`](../api/test/fixtures/research/pub-example-weddings.yaml).
It describes a made-up outlet and is validated by the test suite, so it always
matches the schema.

## The rules

Every fact names the pages it came from and is written in one of two shapes.

A fact the research found quotes the page:

```yaml
exclusivity:
  value: { policy: exclusive_required, after_publication_days: 30 }
  cite:
    - source: guidelines
      quote: We require 30 days of exclusivity on all Real Weddings
```

A fact the research could not find is `unknown`, with the pages that were read:

```yaml
freshness_window_months:
  value: unknown
  checked: [guidelines, form]
```

- **Nothing is blank or left out.** Every field below appears in every file.
  "Nobody looked" must never pass for "the outlet has no rule".
- **Unknown is not no.** `false` and `none` are findings and need a quote, the
  same as any other value. If a page simply does not mention a rule, the fact
  is `unknown`.
- **Quotes are short and real:** at most 25 words, copied from the page, never
  paraphrased. A `feature` source (a page showing one of the outlet's weddings)
  may be cited without a quote, because its photos are the evidence.
- **Sources are pages actually opened.** Each lists its `url`, the date it was
  `read`, and its `kind`. A fact's last-verified date is the latest `read` date
  among the sources it cites or checked, so moving a `read` date forward says
  every fact citing that page was checked again. Every source must be cited or
  checked somewhere.
- **No email addresses**, anywhere in the file. Editor and submission inbox
  addresses go in the private contacts overlay outside this repository and are
  merged at import.
- **Nothing about the design partner.** These files describe outlets only.
- **Respect the outlets' sites.** Read only public pages, never get around a
  login wall, and follow each site's terms and rate limits.

Three words are reserved values: `unknown` (not found), `none` (the outlet
states there is none: no fee, no limit) and `any` (any gallery host).

`npm test` checks every file in `publications/` against these rules, and CI
runs it on every pull request.

## Fields

Fields marked *judgment* are the team's own calls and carry no source. Every
other field is a fact in one of the two shapes above, except the `insight`
lists, whose items each carry their own cite. Values in `code` come from fixed
lists in `api/src/domain/research/schema.ts`; tags and locations come from
`vocab/`.

| Field | Value |
|---|---|
| `id` | `pub-` and the outlet's name in kebab-case; the file is named `<id>.yaml` |
| `name`, `url` | The outlet's name and home page |
| `kind` | `national_magazine`, `regional_magazine`, `blog`, `destination_international` |
| `tier` | *judgment*: `primary`, `secondary`, `dream` |
| `recheck_every_days` | *judgment*: how often to re-read the sources |
| `taste_summary`, `notes` | *judgment*, optional: free text |
| `sources.<id>` | `url`, `read` (YYYY-MM-DD), `kind` (`guidelines`, `form`, `about`, `media_kit`, `interview`, `podcast`, `feature`, `other`), optional `title` |
| `identity.parent_company` | Company name, or `none` for an independent outlet |
| `identity.sister_publications` | Names of sister titles |
| `identity.shared_inbox_with` | Ids of outlets that share one submission inbox with this one |
| `coverage.regions` | Location codes from `vocab/geo.yaml` the outlet accepts weddings from |
| `coverage.basis` | Whether coverage means the `wedding_location`, the `couple_home`, or `either` |
| `coverage.destination_accepted` | true or false |
| `content.real_wedding`, `content.elopement`, `content.styled_shoot` | true or false for each |
| `content.style_tags` | Tags from `vocab/tags.yaml`, usually cited to `feature` sources |
| `content.seasonality` | `none` (no seasonal preference), or windows of `wants` (season tags), optional `submit_months` (1 to 12) and `note` |
| `routes` | Ways to submit: `platform` (`two_bright_lights`, `matchology`, `email`, `web_form`, `portal`, `pitch_only`), optional `url`, `account_required` (true, false or unknown), `steps` in order, optional `preferred` and `note` |
| `package.image_min`, `package.image_max` | A count, or `none` |
| `package.resolution` | Any of `min_width_px`, `max_width_px`, `min_long_edge_px`, `max_long_edge_px`, `min_file_mb`, `max_file_mb`, `note` |
| `package.size` | `web`, `print`, `both` |
| `package.orientation_mix` | Free text, such as the mix of vertical and horizontal images asked for |
| `package.watermarks_allowed`, `package.video_accepted` | true or false |
| `package.gallery_hosts` | `any`, or a list of `dropbox`, `google_drive`, `wetransfer`, `pic_time`, `pixieset`, `smugmug`, `shootproof`, `direct_upload` |
| `package.vendor_credits` | `required`, optional `fields` (`role`, `business_name`, `website`, `instagram`, `email`) and `note` |
| `package.story` | `required`, optional `min_words`, `max_words`, `questionnaire`, `note` |
| `package.other_requirements` | Anything else the outlet asks for, one item each |
| `rules.exclusivity` | `policy` (`exclusive_required`, `exclusive_preferred`, `non_exclusive`), optional `during_review` and `after_publication_days` |
| `rules.prior_exposure.publications`, `.blogs`, `.social` | `allowed`, `sneak_peeks_only` or `disqualifies` for a wedding already shown in that channel |
| `rules.freshness_window_months` | How recent the wedding must be, or `none` |
| `rules.photographer_frequency` | `max` features `per_months` for one photographer, or `none` |
| `rules.submitter_roles` | Who may submit: `photographer`, `planner`, `couple`, `vendor`, `publicist` |
| `rights.image_usage`, `rights.credit_format` | Free text |
| `rights.couple_consent_required`, `rights.vendor_consent_required` | true or false |
| `economics.submission_fee`, `economics.publication_fee` | `none`, or `amount` (a number or `undisclosed`), `currency` (a three-letter code such as USD), optional `note` |
| `economics.priority_paid_tier` | `none`, or `name`, optional `price` and `note` |
| `economics.reach` | `metric` (`instagram_followers`, `facebook_followers`, `tiktok_followers`, `pinterest_monthly_views`, `monthly_visitors`, `monthly_pageviews`, `newsletter_subscribers`, `print_circulation`), `value`, `as_of` |
| `timing.response_window` | `days` (calendar days) and `replies` (`all` or `success_only`) |
| `timing.publish_lead_days` | `min` and/or `max` days from acceptance to publication |
| `timing.publishing_cycle` | Free text, such as daily online and quarterly print |
| `people.editors` | `name` and `role` of publicly listed editors; contact details go in the private overlay |
| `insight.secret_sauce` | List of `tip` with its own `cite`: what raises acceptance odds, from guidelines, interviews, podcasts and recent features |
| `insight.recent_features` | List of `source` (a `feature` source), `published`, optional `location`, `content_type`, `tags` |
