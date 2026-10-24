import type { StepId } from "./model.js";

/**
 * Everything a wizard screen says about itself, and the help page prints:
 * why the step matters, what to do here (each line naming its control by the
 * exact label on the screen), and what comes next. One edit changes both.
 */
export interface StepGuide {
  /** The screen heading. A screen may put the outlet's name in it instead. */
  title: string;
  /** One or two warm sentences on why this step matters. */
  lead: string;
  /** Numbered actions, at most five. A quoted label must render on the screen. */
  todo: string[];
  /** Shown under the footer while the step is not finished. Starts "Next up:". */
  next: string;
  /** One reassurance or edge case, under the list. */
  note?: string;
}

/** Words she never reads, plus em dashes, exclamation marks and emoji. */
export const BANNED = /\b(package|attestation|intake|inventory|event|derived|pool|grant)s?\b|[\u2014!]|\p{Extended_Pictographic}/iu;

export const GUIDE: Record<StepId, StepGuide> = {
  wedding: {
    title: "The wedding",
    lead: "A few details to start. Outlets print these exactly as you type them, so use the names the couple would want to see.",
    todo: [
      "Type the couple's names as they should appear in print.",
      "Pick the wedding date.",
      "Add the venue and the city, state and country.",
      'Under "Where it was, for matching outlets", pick the state, or the area if it is listed, or the country. Then pick what kind of wedding it was.',
      'Press "Continue".',
    ],
    next: "Next up: your gallery and the couple's permission.",
  },
  permissions: {
    title: "Your gallery and permissions",
    lead: "Two things every outlet asks before anything else. Honest answers keep you safe: the wedding waits here until both are in place.",
    todo: [
      "Paste the gallery link. It stays private and is never shown again.",
      'Answer "Were you the lead photographer under your own contract?"',
      'Answer "Has the couple agreed to a submission?" If they set limits, such as first names only, write them in. They follow the wedding onto every checklist.',
      'Under "Has any of it been shared yet?", tick every place, including the couple\'s and the vendors\' own posts.',
      'Press "Continue".',
    ],
    note: "If you were the second shooter, that is fine. The wedding stays on hold here and nothing more is needed from you for now.",
    next: "Next up: the story and the vendors.",
  },
  story: {
    title: "The story and the vendors",
    lead: "What made this wedding its own, and who made it happen. One real detail says more than five adjectives, and outlets will not publish without full vendor credits.",
    todo: [
      "Write a few lines on what stood out: a moment, a detail, a tradition.",
      "Add every vendor: their role, business name, and website or Instagram if you have it.",
      'Press "Continue".',
    ],
    next: "Next up: the look of the wedding.",
  },
  look: {
    title: "The look",
    lead: "Tag the setting, the style and what the couple wore. Your tags add up to your style profile, which helps find the outlets that publish your kind of wedding.",
    todo: [
      'Read each suggestion and its reason, then press "Keep" or "Not this".',
      'Pick anything missing under "Add a tag".',
      'Press "Continue".',
    ],
    note: "Suggestions come from the wedding date, where it was, and any tags suggested from your photos. This step never holds a wedding back, so you can skip it and come back from Your work.",
    next: "Next up: choosing an outlet.",
  },
  outlet: {
    title: "Choose an outlet",
    lead: "One outlet considers a wedding at a time, which is what most of them expect. The outlets that suit this wedding come first, with the reasons.",
    todo: [
      'Start with "Best fits". Each card says how well it matches, why, and any warnings, such as exclusivity or a fee.',
      'Outlets under "Check first" have a question their published rules do not answer. Check it before you choose one.',
      "Tap the one you want.",
      'Press "Continue".',
    ],
    note: "Outlets that cannot take this wedding are listed at the bottom with the reason. If the wedding is on hold, this screen says why and where to fix it.",
    next: "Next up: picking the photos.",
  },
  photos: {
    title: "Pick the photos",
    lead: "The photos the outlet will see, in the order you want them seen.",
    todo: [
      "In your gallery, select your favourites and download them at web size (around 1600 pixels on the long edge), not full size.",
      'Press "Add photos" and choose the files you downloaded.',
      'Tap each photo in the order you want it to appear, or press "Choose all".',
      'Press "Up" or "Down" beside a photo to change its place, or "Remove" to take it out.',
      'Press "Continue" once the count fits the outlet\'s range, shown beside the button.',
    ],
    next: "Next up: the write-up and credits.",
  },
  writeup: {
    title: "Write-up and credits",
    lead: "Both are drafted from what you already entered. Make them sound like you.",
    todo: [
      "Read the write-up and change anything you like. Say what happened; the outlet's editor rewrites it anyway.",
      "Check the credits: every vendor, spelled the way they spell it.",
      'Press "Continue".',
    ],
    next: "Next up: the outlet's final checks.",
  },
  confirm: {
    title: "Final checks",
    lead: "These are the outlet's own rules, written as things to confirm. Each tick saves on its own, so you can leave and come back.",
    todo: [
      "Read each line.",
      "Tick the ones you can confirm.",
      'If a line says "Not done", press "Fix this". It takes you to the right screen and brings you back.',
      'Press "Continue" once every line is ticked.',
    ],
    next: "Next up: a last look before it goes in your queue.",
  },
  review: {
    title: "Review",
    lead: "One last look before it goes in your queue. Nothing is sent from here.",
    todo: [
      "Read it top to bottom.",
      "To change something, press that step in the progress bar at the top.",
      'Press "Add to the queue".',
    ],
    next: "Next up: sending it, your way.",
  },
  send: {
    title: "Send it",
    lead: "You send it, the way you always have. The tool just gets everything ready for you.",
    todo: [
      'Press "Download the photos". You get a zip, numbered in your order.',
      'Press "Copy the write-up", then "Copy the credits", and paste each where the outlet asks.',
      "Open the outlet's page: press the button under step 3 if there is one. If the outlet has no page, the screen says how it takes submissions.",
      "Fill in their form or email, attach the photos, paste the text, and send it from there.",
      'Come back here and press "I sent it".',
    ],
    note: "Nothing on this screen sends anything. It only records that you did.",
    next: "Next up: tracking the reply.",
  },
  track: {
    title: "Track the reply",
    lead: "Now the waiting. The tool knows the outlet's usual window and will say when a reply is overdue.",
    todo: [
      "Nothing to do until you hear back.",
      'When you do, press "Accepted" or "Declined" and add a note if you like.',
      'Once the feature is live, paste the link into "Live link" and press "Record it".',
    ],
    note: "Some outlets never reply. This screen says what silence means for this one.",
    next: "Next up: the outlet's answer. After that, this wedding is done, or free for another outlet.",
  },
};

/** The home page's first-visit welcome. */
export const WELCOME = {
  title: "Welcome",
  lead: "This tool gets a wedding ready for a publication and keeps track of what happens next. It never sends anything itself; you stay in charge of that.",
  journey: [
    "Tell us about the wedding",
    "Choose an outlet",
    "Pick the photos and shape the write-up",
    "Send it your way",
    "Track the reply",
  ],
  closing: "Each screen tells you exactly what to do. Choose a wedding below to begin.",
};

/** The five rules, on the help page. */
export const RULES = [
  "The tool gets each submission ready and tracks the reply. You do the sending yourself.",
  "Each wedding goes to one outlet at a time. Start with the one you want most.",
  "The final checks are the outlet's own rules, taken from its published guidelines.",
  "Your gallery links stay private. Once saved, they are never shown again.",
  "Mark things done as you go, and the tool shows you what comes next.",
];
