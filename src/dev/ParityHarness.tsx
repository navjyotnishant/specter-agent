// Author: Navjyot Nishant
// Created: 2026-08-01
// Last updated: 2026-08-01
// Description: Dev-only route that renders a page against fixture data for design-parity measurement.
//
// WHY THIS EXISTS
// The design-parity gate compares computed styles and element structure against
// an approved mockup. It does not care about real data — content is explicitly
// out of scope. But every page it measures sits behind ProtectedRoute, so
// measuring one used to require a live session, which meant it could not run on
// a build machine at all.
//
// This mounts the page component directly with a pre-seeded query cache: no
// network, no ProtectedRoute. What renders is the real component with the real
// stylesheet, which is exactly and only what the gate measures.
//
// It does place a throwaway token in localStorage, because several components
// gate on "am I signed in" and would otherwise render a sign-in prompt instead
// of the state under test. The token is never sent anywhere — every query
// resolves from the seeded cache.
//
// SECURITY
// This bypasses authentication by construction, so it must never exist in a
// production bundle. Three independent guards:
//   1. `import.meta.env.DEV` — Vite statically replaces this with `false` in a
//      production build, so the whole module is dead code and gets tree-shaken.
//   2. The route is registered behind the same check in App.tsx.
//   3. The component itself refuses to render if it somehow runs outside dev.
// Guard 3 is not redundant: 1 and 2 are build-time, and a misconfigured build
// (or a future bundler change) that defeated them would otherwise silently ship
// an unauthenticated view of every page.
//
// It renders nothing sensitive regardless — the fixtures are invented — but an
// unauthenticated route that mounts admin pages is the kind of thing that stops
// being harmless the moment someone wires a real query into it.

import { useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SEED, FIXTURE_WORKFLOW_ID } from "./parity-fixtures";

import Workflows from "@/pages/Workflows";
import Skills from "@/pages/Skills";
import Models from "@/pages/Models";
import Users from "@/pages/Users";
import Dashboard from "@/pages/Dashboard";
import WorkflowBuilder from "@/pages/WorkflowBuilder";

const PAGES: Record<string, React.ComponentType> = {
  workflows: Workflows,
  skills: Skills,
  models: Models,
  users: Users,
  dashboard: Dashboard,
  builder: WorkflowBuilder,
};

/** The builder reads `:workflowId` via useParams. The harness route carries an
 *  optional second segment so it can be supplied — without one the builder
 *  renders an empty canvas, which measures as a page with no nodes and reports
 *  as dozens of missing elements rather than as the harness's own fault. */
const NEEDS_ID = new Set(["builder"]);

/** A client whose cache is pre-filled and which never refetches, so every
 *  `useQuery` in the mounted page resolves from cache without calling its
 *  queryFn. Retries off so a miss fails fast and visibly rather than hanging
 *  the render behind three backoff rounds — a hung render measures as a page
 *  with no elements, which would read as dozens of structural failures. */
function seededClient() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: Infinity,
        gcTime: Infinity,
      },
      mutations: { retry: false },
    },
  });
  for (const [key, value] of SEED) qc.setQueryData(key, value);
  return qc;
}

// A throwaway token in localStorage, seeded at module scope so it is present
// before any component reads it.
//
// Nothing is ever sent with it — every query resolves from the pre-seeded cache.
// But pages gate their queries on `canUseBackend = Boolean(token)`, so without
// one those queries stay DISABLED and never read the cache at all. On the
// builder that meant React Flow mounted with zero nodes and the page rendered
// "Untitled", which the gate reported as ~40 missing elements — a page that is
// fully built, measured as though it did not exist.
//
// An earlier note here claimed localStorage was unavailable in a headless
// browser. That was wrong: it works. The seeding lives in App.tsx because this
// module is imported lazily by the route, which is after the app has already
// read the token and decided it has no session.
export function ParityHarness() {
  const { page, workflowId } = useParams<{ page: string; workflowId?: string }>();

  if (!import.meta.env.DEV) return null;

  if (page && NEEDS_ID.has(page) && !workflowId) {
    return (
      <div style={{ padding: 24, font: "13px ui-sans-serif, system-ui" }}>
        <p><code>{page}</code> needs a workflow id: <code>/__parity/{page}/{FIXTURE_WORKFLOW_ID}</code></p>
      </div>
    );
  }

  const Page = page ? PAGES[page] : undefined;
  if (!Page) {
    return (
      <div style={{ padding: 24, font: "13px ui-sans-serif, system-ui" }}>
        <p>Unknown parity page: <code>{page}</code></p>
        <p>Available: {Object.keys(PAGES).join(", ")}</p>
      </div>
    );
  }

  return (
    <QueryClientProvider client={seededClient()}>
      <Page />
    </QueryClientProvider>
  );
}
