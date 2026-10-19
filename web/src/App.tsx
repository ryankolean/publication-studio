import { HashRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { PRODUCT_NAME } from "./config.js";
import { SessionProvider, useSession } from "./session-context.js";
import { LoginPage } from "./pages/LoginPage.js";
import { SetPasswordPage } from "./pages/SetPasswordPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { IntakePage } from "./pages/IntakePage.js";
import { PublicationsPage } from "./pages/PublicationsPage.js";
import { EventDetailPage } from "./pages/EventDetailPage.js";
import { PackageEditorPage } from "./pages/PackageEditorPage.js";

/**
 * DECISION: HashRouter, not BrowserRouter. GitHub Pages serves static files
 * and 404s on a deep link into a client-side route; the usual workaround is a
 * 404.html that re-enters the app and rewrites history. Hash routes need none
 * of that. If the app later moves behind a custom domain with a real rewrite
 * rule, this becomes a one-line change.
 */
function RequireSession({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return user === null ? <Navigate to="/login" replace /> : <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { user, session } = useSession();

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 py-4 sm:px-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="font-semibold tracking-tight">{PRODUCT_NAME}</span>
            <nav className="flex gap-4 text-sm">
              <Link to="/" className="text-slate-600 hover:text-slate-900">
                Events
              </Link>
              <Link to="/publications" className="text-slate-600 hover:text-slate-900">
                Publications
              </Link>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-sm text-slate-500">
            <span>{user?.name}</span>
            <button type="button" onClick={() => session.signOut()} className="text-slate-600 hover:text-slate-900">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

function Routed() {
  const { user } = useSession();

  if (user === null) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/set-password" element={<SetPasswordPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<RequireSession><DashboardPage /></RequireSession>} />
        <Route path="/events/new" element={<RequireSession><IntakePage /></RequireSession>} />
        <Route path="/events/:id" element={<RequireSession><EventDetailPage /></RequireSession>} />
        <Route path="/packages/:id" element={<RequireSession><PackageEditorPage /></RequireSession>} />
        <Route path="/publications" element={<RequireSession><PublicationsPage /></RequireSession>} />
        <Route path="/set-password" element={<SetPasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  return (
    <SessionProvider>
      <HashRouter>
        <Routed />
      </HashRouter>
    </SessionProvider>
  );
}
