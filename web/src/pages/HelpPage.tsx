import { Link } from "react-router-dom";

const POINTS = [
  "The tool gets each submission ready and tracks the reply. You do the sending yourself.",
  "Each wedding goes to one outlet at a time. Start with the one you want most.",
  "The final checks are the outlet's own rules, taken from its published guidelines.",
  "Your gallery links stay private. Once saved, they are never shown again.",
  "Mark things done as you go, and the tool shows you what comes next.",
];

/** /help: how the tool works, on one screen. */
export function HelpPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h2 className="text-xl font-semibold text-slate-900">How it works</h2>
      <ul className="list-disc space-y-3 pl-5 text-sm text-slate-800">
        {POINTS.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <Link to="/wizard" className="inline-flex rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
        Start a submission
      </Link>
    </div>
  );
}
