-- SUMMIT-300: research pass over every outlet's live guidelines, dated
-- 2026-10-19. Generated from docs/research/publications-2026-10-19.json,
-- which records a source url and quote for every non-null fact. Unknown
-- stays NULL; 'we could not find the rule' and 'there is no rule' are
-- different facts.
--
-- Adds the stated response-window wording, two dream-tier outlets with no
-- public submission route, and the shared tag vocabulary that event tagging
-- (SUMMIT-302) and matching (SUMMIT-303) will use.
--
-- contact_email stays NULL on purpose: the repo carries no email addresses
-- (CLAUDE.md constraint 4). An outlet's public submissions inbox is entered
-- in-app by the operator.

ALTER TABLE publications ADD COLUMN response_window_note TEXT;

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL CHECK (category IN ('region', 'landscape_venue', 'architecture', 'aesthetic', 'dress_style', 'season')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS publication_tags (
  publication_id TEXT NOT NULL REFERENCES publications (id) ON DELETE CASCADE,
  tag_id         TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (publication_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_publication_tags_tag ON publication_tags (tag_id);

UPDATE publications SET
  name = 'Carats & Cake',
  tier = 'primary',
  method = 'portal',
  submission_url = 'https://caratsandcake.com/submit-a-wedding',
  contact_email = NULL,
  spec_json = '{"size": "web", "watermarks_allowed": false, "video_accepted": true, "video_notes": "Form asks for a video gallery link if available; no format or length rules published.", "requirements": ["account_required", "full_vendor_credits", "vendor_emails_for_new_vendors", "no_watermarks", "web_size_images_only", "photographer_full_gallery_link", "venue_and_location", "guest_count", "budget_tier"], "notes": "Submission requires a free account (login wall), so the form itself was not viewed. No image minimum or maximum is published; non-featured weddings become an album of up to 20 curated images on the vendor profile. Gallery must be the photographer''s complete gallery, not a folder of selects, with passwords or download PINs; gallery problems are the stated top cause of delays. Reviewed anonymously in arrival order. Pro Plus members get priority review (timing only, no editorial advantage). Styled shoots go through the same form as ''Editorial Submission'' and are published less often. Contact [address withheld] is for general inquiries and credit corrections, not a submissions inbox, so contact_email is null."}',
  exclusivity_policy = 'unknown',
  counts_own_blog_as_published = NULL,
  typical_response_days = NULL,
  response_window_note = NULL,
  earned_or_paid = 'earned',
  taste_notes = 'States there is no single aesthetic or budget target. Wants immersive storytelling and a fresh angle, and explicitly favors expanding the range of locations, cultures and budgets. Venue directory is organized around resorts, estates, vineyards, gardens and waterfront.',
  last_verified = '2026-10-19',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 'pub-carats-and-cake';

UPDATE publications SET
  name = 'Over The Moon',
  tier = 'primary',
  method = 'web_form',
  submission_url = 'https://overthemoon.com/pages/wedding-submissions',
  contact_email = NULL,
  spec_json = '{"img_max": 150, "size": "web", "watermarks_allowed": false, "requirements": ["no_watermarks", "non_expiring_dropbox_style_link", "no_wetransfer", "images_chronological_order", "image_file_size_1_to_3mb", "submitter_role_declared", "couple_instagram_handles", "couple_professions", "couple_love_story", "registry_question_answered"], "notes": "Form is embedded from formbuilder.hulkapps.com. Submitter must be photographer, couple or planner. Asks whether an Over The Moon registry was made. ''1-3MB each'' is a file-size range, treated as web size. Directory members (paid vendor directory) submit through a separate form with priority review. No exclusivity rule found on the page or form."}',
  exclusivity_policy = 'unknown',
  counts_own_blog_as_published = NULL,
  typical_response_days = 60,
  response_window_note = 'it may take us up to 60 days for us to respond',
  earned_or_paid = 'earned',
  taste_notes = 'Modern, fashionable, fun real weddings that feel aspirational but relatable, the kind couples follow on Instagram. Retail and registry business, so fashion, dress codes (garden, ranch, black tie) and personalized details matter.',
  last_verified = '2026-10-19',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 'pub-over-the-moon';

UPDATE publications SET
  name = 'The Anti-Bride',
  tier = 'primary',
  method = 'web_form',
  submission_url = 'https://www.antibride.com.au/photography-submissions',
  contact_email = NULL,
  spec_json = '{"img_min": 100, "img_max": 120, "size": "unknown", "requirements": ["submitter_must_be_photographer_or_planner", "not_accepted_from_couples", "unpublished_only", "recent_within_12_months", "non_traditional_wedding_only", "gallery_via_pixieset_not_dropbox", "hi_res_and_web_size_images_both", "anti_bride_partner_required_if_accepted"], "notes": "This is the Australian magazine at antibride.com.au, not theantibride.com (a Jacksonville florist and planner) and not the TikTok trend. Worldwide submissions. Real weddings: around 100-120 images. Styled shoots (editorials): around 50-70 images, must credit all vendors, no couple or engagement shoots. Gallery must provide both hi-res and web-size downloads. Condition: the photographer or planner on any accepted submission must be an Anti-Bride brand partner; the partnership fee is not published. The form asks whether the work has been published in a magazine or blog. General contact is [address withheld] (shop and general inquiries); no submissions address is posted, so contact_email is null."}',
  exclusivity_policy = 'exclusive_required',
  counts_own_blog_as_published = NULL,
  typical_response_days = 21,
  response_window_note = 'have not heard back within 2-3 weeks',
  earned_or_paid = 'mixed',
  taste_notes = 'Authentic, non-traditional, fashion-led weddings: elopements, relaxed micro-weddings, backyard weddings, couples in bold colour or prints, or trend-setting larger weddings. Inclusive of all cultures and same-sex couples.',
  last_verified = '2026-10-19',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 'pub-the-anti-bride';

UPDATE publications SET
  name = 'The Lane',
  tier = 'primary',
  method = 'email',
  submission_url = 'https://thelane.com/submissions/',
  contact_email = NULL,
  spec_json = '{"img_min": 30, "size": "unknown", "requirements": ["dropbox_link_to_images", "variety_of_details_pre_reception_to_reception", "email_subject_real_wedding_plus_couple_names", "styled_shoot_concept_description", "styled_shoot_key_vendors"], "notes": "Real weddings: email with ''Real Wedding'' plus couple names in the subject and a Dropbox link to at least 30 images. Lifestyle styled shoots (table styling, decor, stationery, floristry, food and beverage) are accepted with a few sentences on concept, inspiration and key vendors, same 30-image minimum. Bridal fashion and beauty editorials are currently not accepted. Replies only to successful submissions; the window is 10 business days, stored as 14 calendar days. No exclusivity, watermark or size rules found. Site hygiene note: the raw HTML served to non-browser fetchers contained hidden casino spam keywords; the rendered page in a browser did not."}',
  exclusivity_policy = 'unknown',
  counts_own_blog_as_published = NULL,
  typical_response_days = 14,
  response_window_note = 'we will be in touch within 10 business days to confirm successful submissions only',
  earned_or_paid = 'earned',
  taste_notes = 'Fashion, art, interiors and travel lens. Recent real weddings are luxe European and destination affairs: sculptural florals, vintage silver, ancient stone, Tuscan and Florentine estates, a train journey through Scotland.',
  last_verified = '2026-10-19',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 'pub-the-lane';

UPDATE publications SET
  name = 'Brides',
  tier = 'primary',
  method = 'web_form',
  submission_url = 'https://www.brides.com/real-wedding-submission-guidelines-5222891',
  contact_email = NULL,
  spec_json = '{"img_min": 100, "img_max": 200, "size": "unknown", "video_notes": "Form asks for videographer name and whether social video exists; no stated video acceptance rules.", "requirements": ["professional_photos_only", "dropbox_folder_only", "full_vendor_credits", "photographer_name", "venue_and_location", "exclusive_30_days_after_publication", "unpublished_only", "no_styled_shoots"], "notes": "Placements may be paid: flagged per task brief. The submission route itself is a free Airtable form and Brides'' editorial policy says editorial is not influenced by advertisers and sponsored content is labeled, but no page was found either selling or ruling out paid real-wedding placement, so earned_or_paid is mixed. Parent is People Inc. Accepts couples, planners, photographers, vendors and PR reps, on a rolling basis. Only Dropbox galleries are reviewed (Pixieset, Pic-Time and similar rejected since 2024-04-17). Also takes bridal showers, welcome parties, rehearsal dinners and similar events, alone or bundled. No reply if passed. Contact [address withheld] is general, so contact_email is null."}',
  exclusivity_policy = 'exclusive_required',
  counts_own_blog_as_published = 1,
  typical_response_days = 60,
  response_window_note = 'not heard back from our team within two months',
  earned_or_paid = 'mixed',
  taste_notes = 'Stunning decor, unique stories and show-stopping fashion; real weddings run from elopements to formal affairs, destination and cultural celebrations, with a visible tilt toward influencer and celebrity exclusives. Personalized details are a recurring angle.',
  last_verified = '2026-10-19',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 'pub-brides';

UPDATE publications SET
  name = 'Wezoree',
  tier = 'secondary',
  method = 'web_form',
  submission_url = 'https://wezoree.com/profile/services/submit-real-wedding.php',
  contact_email = NULL,
  spec_json = '{"size": "unknown", "requirements": ["processing_fee_if_selected", "detailed_form_after_selection", "full_vendor_credits", "couple_love_story", "professional_photo_gallery"], "notes": "Pay-to-publish: if selected, a processing fee is charged to the person or company that submitted the wedding; the amount is not published. The fee covers writing, design, publication and some promotion. Five steps: short form, selection, reply within 15 days if selected, detailed form, article produced and published. Requirement names come from what the page says each feature contains (couple''s story, professional gallery by a certified photographer, vendor credits), not from a published submission checklist. Image counts, watermark and exclusivity rules not found. Whether the short form needs an account was not tested. Wezoree also runs a print-ready magazine and sells advertising. [address withheld] is support, not submissions, so contact_email is null."}',
  exclusivity_policy = 'unknown',
  counts_own_blog_as_published = NULL,
  typical_response_days = 15,
  response_window_note = 'will contact you within 15 days if the wedding has been selected',
  earned_or_paid = 'paid',
  taste_notes = 'Global mix skewed to European and destination weddings (Ireland, France, Italy, Kenya, Mexico) with some US cities; a Detroit wedding at Cambridge Mill ran in September 2026. Long, story-led features with full vendor credits.',
  last_verified = '2026-10-19',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 'pub-wezoree';

UPDATE publications SET
  name = 'Wed Vibes',
  tier = 'secondary',
  method = 'web_form',
  submission_url = 'https://wedvibes.media/submissions/',
  contact_email = NULL,
  spec_json = '{"img_min": 100, "img_max": 150, "size": "web", "video_accepted": true, "video_notes": "Vimeo and YouTube links accepted.", "requirements": ["authorization_to_submit_images", "instagram_handle", "event_description", "grants_publication_rights", "image_max_2mb", "image_width_1500_to_2400px", "embargo_other_features_2_months_after_publication"], "notes": "The live site is wedvibes.media; wedvibes.com is a parked GoDaddy for-sale domain. Gallery via Dropbox, WeTransfer, Google Drive, Pic-Time or Pixieset. Replies only to successful submissions; window is 21 business days, stored as 29 calendar days. Published roughly 45-60 days after acceptance. After Wed Vibes publishes, the outlet asks that no other feature go live for 2 months. A declined submission can be resent. Contact form is general (inquiries, submissions, advertising); no email address posted. A directory and a marketing school exist; no pricing found, so earned is unverified."}',
  exclusivity_policy = 'exclusive_preferred',
  counts_own_blog_as_published = NULL,
  typical_response_days = 29,
  response_window_note = 'we will be in touch within 21 business days to confirm successful submissions',
  earned_or_paid = 'earned',
  taste_notes = 'Destination and design-led weekends: Mexico City, Cabo, Lake Como, Mallorca, Lisbon, Oaxaca, Okanagan vineyards, with playful details like mirrored disco balls and ice sculptures. Mix of cultural traditions and celebrity stylist weddings.',
  last_verified = '2026-10-19',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 'pub-wed-vibes';

UPDATE publications SET
  name = 'Loverly',
  tier = 'secondary',
  method = 'portal',
  submission_url = 'https://loverly.com/tools/submit-wedding',
  contact_email = NULL,
  spec_json = '{"img_min": 30, "img_max": 40, "size": "web", "video_accepted": true, "video_notes": "Vimeo links or YouTube embed links.", "requirements": ["vendor_account_dashboard", "full_vendor_credits", "venue_and_photographer_required", "event_description", "color_palette_and_style", "couple_love_story", "permission_from_couple_and_photographer", "mix_of_portrait_and_landscape"], "notes": "Image guidance conflicts across Loverly pages: the submit page says curate the top 25-40 and a complete submission has at least 30-40 images; the vendor FAQ recommends 20-30. Stored 30 to 40 (the stricter, newer submit page). Uploads should be 720 to 1920 px wide. Approval takes about two weeks, then about two weeks to publish; status is tracked in the vendor dashboard. Missing details trigger an email to fix and resubmit, which is not a decline. Multiple submissions allowed. Loverly Preferred ($79/month) includes priority review for submissions; unpaid vendors still reviewed. Couples can also submit per the submit page. [address withheld] and [address withheld] are posted but are vendor support and billing, not a submissions inbox."}',
  exclusivity_policy = 'non_exclusive',
  counts_own_blog_as_published = NULL,
  typical_response_days = 14,
  response_window_note = 'Approval typically takes about two weeks.',
  earned_or_paid = 'earned',
  taste_notes = 'Editorial lens on details, fashion and design. Browses by style (classic, romantic, whimsical, modern, boho, glamorous, alternative) and setting (garden, vineyard, barn, ranch, museum, desert, and more); US-heavy with some Michigan albums.',
  last_verified = '2026-10-19',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE id = 'pub-loverly';

INSERT INTO publications (id, name, tier, method, submission_url, contact_email, spec_json, exclusivity_policy, counts_own_blog_as_published, typical_response_days, response_window_note, earned_or_paid, taste_notes, last_verified, active)
VALUES ('pub-people-weddings', 'People (Weddings)', 'dream', NULL, NULL, NULL, '{"size": "unknown", "requirements": [], "notes": "No public route for submitting a real wedding was found. people.com/weddings is celebrity wedding news and the About page lists only [address withheld], described as for ideas or leads, which is a general news-tips address and not a wedding submissions inbox, so contact_email is null. Reaching People likely means a publicist or a story pitch, not a form. Sister brand Brides (same parent, People Inc.) does run a real-wedding form."}', 'unknown', NULL, NULL, NULL, 'earned', 'Celebrity and public-figure weddings, engagements and wedding-adjacent news, often as exclusives. Not a fit for standard vendor submissions.', '2026-10-19', 1);

INSERT INTO publications (id, name, tier, method, submission_url, contact_email, spec_json, exclusivity_policy, counts_own_blog_as_published, typical_response_days, response_window_note, earned_or_paid, taste_notes, last_verified, active)
VALUES ('pub-vogue-weddings', 'Vogue Weddings', 'dream', NULL, NULL, NULL, '{"size": "unknown", "requirements": [], "notes": "No public submission route found. vogue.com/contact covers subscription support only and the FAQ is subscription-only; no weddings submission page or address on contact, about or FAQ pages. Third-party photographer guides claim pitches go through editor relationships; that is unverified and not used as a fact."}', 'unknown', NULL, NULL, NULL, 'earned', 'Fashion-led: couture and vintage gowns, multiple wedding-day looks, wedding suits, cultural traditions and celebrity exclusives. Headlines emphasize the clothes and the people more than venue logistics.', '2026-10-19', 1);

INSERT INTO tags (id, category, sort_order) VALUES
  ('michigan', 'region', 0),
  ('midwest_us', 'region', 1),
  ('northeast_us', 'region', 2),
  ('mid_atlantic_us', 'region', 3),
  ('southeast_us', 'region', 4),
  ('south_central_us', 'region', 5),
  ('southwest_us', 'region', 6),
  ('mountain_west_us', 'region', 7),
  ('pacific_northwest_us', 'region', 8),
  ('california', 'region', 9),
  ('mexico_caribbean', 'region', 10),
  ('british_isles', 'region', 11),
  ('mediterranean_europe', 'region', 12),
  ('international_other', 'region', 13),
  ('garden_botanical', 'landscape_venue', 0),
  ('vineyard_winery', 'landscape_venue', 1),
  ('beach_coastal', 'landscape_venue', 2),
  ('lakefront', 'landscape_venue', 3),
  ('mountain_alpine', 'landscape_venue', 4),
  ('forest_woodland', 'landscape_venue', 5),
  ('farm_ranch_countryside', 'landscape_venue', 6),
  ('desert', 'landscape_venue', 7),
  ('urban_rooftop', 'landscape_venue', 8),
  ('island_tropical', 'landscape_venue', 9),
  ('backyard_private_home', 'landscape_venue', 10),
  ('hotel_resort', 'landscape_venue', 11),
  ('restaurant_private_dining', 'landscape_venue', 12),
  ('museum_gallery', 'landscape_venue', 13),
  ('country_club', 'landscape_venue', 14),
  ('castle_chateau', 'architecture', 0),
  ('italian_villa', 'architecture', 1),
  ('historic_manor_estate', 'architecture', 2),
  ('industrial_loft_warehouse', 'architecture', 3),
  ('modern_contemporary', 'architecture', 4),
  ('art_deco', 'architecture', 5),
  ('rustic_barn_timber', 'architecture', 6),
  ('greenhouse_conservatory', 'architecture', 7),
  ('church_cathedral', 'architecture', 8),
  ('ballroom_grand_hall', 'architecture', 9),
  ('adobe_hacienda', 'architecture', 10),
  ('mid_century_modern', 'architecture', 11),
  ('brick_historic_urban', 'architecture', 12),
  ('classic_timeless', 'aesthetic', 0),
  ('romantic', 'aesthetic', 1),
  ('whimsical', 'aesthetic', 2),
  ('modern_minimal', 'aesthetic', 3),
  ('bohemian', 'aesthetic', 4),
  ('glamorous_luxe', 'aesthetic', 5),
  ('alternative_nontraditional', 'aesthetic', 6),
  ('fashion_forward_editorial', 'aesthetic', 7),
  ('bold_color_maximalist', 'aesthetic', 8),
  ('moody_dramatic', 'aesthetic', 9),
  ('vintage_heritage', 'aesthetic', 10),
  ('organic_textural', 'aesthetic', 11),
  ('culturally_rooted', 'aesthetic', 12),
  ('intimate_micro', 'aesthetic', 13),
  ('playful_party', 'aesthetic', 14),
  ('ball_gown', 'dress_style', 0),
  ('a_line_classic', 'dress_style', 1),
  ('sheath_column', 'dress_style', 2),
  ('slip_minimalist', 'dress_style', 3),
  ('lace_romantic', 'dress_style', 4),
  ('couture_designer', 'dress_style', 5),
  ('vintage_heirloom', 'dress_style', 6),
  ('short_mini_courthouse', 'dress_style', 7),
  ('wedding_suit_pantsuit', 'dress_style', 8),
  ('colored_printed', 'dress_style', 9),
  ('multiple_looks', 'dress_style', 10),
  ('cultural_attire', 'dress_style', 11),
  ('spring', 'season', 0),
  ('early_summer', 'season', 1),
  ('high_summer', 'season', 2),
  ('late_summer', 'season', 3),
  ('early_fall', 'season', 4),
  ('late_fall', 'season', 5),
  ('winter', 'season', 6),
  ('holiday_season', 'season', 7),
  ('year_round_climate', 'season', 8);

INSERT INTO publication_tags (publication_id, tag_id) VALUES
  ('pub-carats-and-cake', 'garden_botanical'),
  ('pub-carats-and-cake', 'vineyard_winery'),
  ('pub-carats-and-cake', 'beach_coastal'),
  ('pub-carats-and-cake', 'hotel_resort'),
  ('pub-carats-and-cake', 'culturally_rooted'),
  ('pub-over-the-moon', 'fashion_forward_editorial'),
  ('pub-over-the-moon', 'playful_party'),
  ('pub-over-the-moon', 'garden_botanical'),
  ('pub-over-the-moon', 'farm_ranch_countryside'),
  ('pub-over-the-moon', 'glamorous_luxe'),
  ('pub-the-anti-bride', 'alternative_nontraditional'),
  ('pub-the-anti-bride', 'fashion_forward_editorial'),
  ('pub-the-anti-bride', 'bold_color_maximalist'),
  ('pub-the-anti-bride', 'intimate_micro'),
  ('pub-the-anti-bride', 'backyard_private_home'),
  ('pub-the-anti-bride', 'colored_printed'),
  ('pub-the-lane', 'fashion_forward_editorial'),
  ('pub-the-lane', 'glamorous_luxe'),
  ('pub-the-lane', 'italian_villa'),
  ('pub-the-lane', 'historic_manor_estate'),
  ('pub-the-lane', 'mediterranean_europe'),
  ('pub-the-lane', 'british_isles'),
  ('pub-brides', 'classic_timeless'),
  ('pub-brides', 'glamorous_luxe'),
  ('pub-brides', 'culturally_rooted'),
  ('pub-brides', 'intimate_micro'),
  ('pub-brides', 'museum_gallery'),
  ('pub-brides', 'mediterranean_europe'),
  ('pub-brides', 'mexico_caribbean'),
  ('pub-brides', 'desert'),
  ('pub-brides', 'california'),
  ('pub-wezoree', 'mediterranean_europe'),
  ('pub-wezoree', 'british_isles'),
  ('pub-wezoree', 'mexico_caribbean'),
  ('pub-wezoree', 'international_other'),
  ('pub-wezoree', 'northeast_us'),
  ('pub-wezoree', 'michigan'),
  ('pub-wezoree', 'culturally_rooted'),
  ('pub-wezoree', 'castle_chateau'),
  ('pub-wezoree', 'italian_villa'),
  ('pub-wed-vibes', 'mediterranean_europe'),
  ('pub-wed-vibes', 'mexico_caribbean'),
  ('pub-wed-vibes', 'international_other'),
  ('pub-wed-vibes', 'culturally_rooted'),
  ('pub-wed-vibes', 'vineyard_winery'),
  ('pub-wed-vibes', 'beach_coastal'),
  ('pub-wed-vibes', 'lakefront'),
  ('pub-wed-vibes', 'fashion_forward_editorial'),
  ('pub-wed-vibes', 'playful_party'),
  ('pub-loverly', 'classic_timeless'),
  ('pub-loverly', 'romantic'),
  ('pub-loverly', 'whimsical'),
  ('pub-loverly', 'modern_minimal'),
  ('pub-loverly', 'bohemian'),
  ('pub-loverly', 'glamorous_luxe'),
  ('pub-loverly', 'alternative_nontraditional'),
  ('pub-loverly', 'garden_botanical'),
  ('pub-loverly', 'vineyard_winery'),
  ('pub-loverly', 'beach_coastal'),
  ('pub-loverly', 'mountain_alpine'),
  ('pub-loverly', 'farm_ranch_countryside'),
  ('pub-loverly', 'urban_rooftop'),
  ('pub-loverly', 'lakefront'),
  ('pub-loverly', 'forest_woodland'),
  ('pub-loverly', 'museum_gallery'),
  ('pub-loverly', 'desert'),
  ('pub-loverly', 'hotel_resort'),
  ('pub-vogue-weddings', 'fashion_forward_editorial'),
  ('pub-vogue-weddings', 'couture_designer'),
  ('pub-vogue-weddings', 'vintage_heirloom'),
  ('pub-vogue-weddings', 'multiple_looks'),
  ('pub-vogue-weddings', 'wedding_suit_pantsuit'),
  ('pub-vogue-weddings', 'culturally_rooted');
