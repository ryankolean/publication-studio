import { Link } from "react-router-dom";

import { PRIMARY } from "../wizard/Frame.js";
import { GUIDE, RULES, WELCOME } from "../wizard/guide.js";
import { STEPS } from "../wizard/model.js";

/** /help: what the tool is, the five rules, and every step's instructions, from the same copy the screens use. */
export function HelpPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-3">
        <h2 className="text-xl font-semibold text-slate-900">How it works</h2>
        <p className="text-sm text-slate-700">{WELCOME.lead}</p>
        <ul aria-label="The rules" className="list-disc space-y-2 pl-5 text-sm text-slate-800">
          {RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </header>

      <section aria-label="The steps" className="space-y-6">
        {STEPS.map((step, index) => {
          const guide = GUIDE[step];
          const headingId = `step-${step}`;
          return (
            <section key={step} aria-labelledby={headingId} className="rounded-lg border border-slate-200 p-4">
              <h3 id={headingId} className="font-semibold text-slate-900">{`${index + 1}. ${guide.title}`}</h3>
              <p className="mt-1 text-sm break-words text-slate-600">{guide.lead}</p>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm break-words text-slate-800">
                {guide.todo.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              {guide.note !== undefined && <p className="mt-2 text-xs break-words text-slate-600">{guide.note}</p>}
              <p className="mt-2 text-sm break-words text-slate-500">{guide.next}</p>
            </section>
          );
        })}
      </section>

      <Link to="/" className={PRIMARY}>
        Choose a wedding
      </Link>
    </div>
  );
}
