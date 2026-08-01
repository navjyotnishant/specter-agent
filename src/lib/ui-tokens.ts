// Author: Navjyot Nishant
// Created: 2026-08-01
// Last updated: 2026-08-01
// Description: Shared visual tokens for Specter's app chrome.
//
// Why this exists: the pages were styled independently and drifted into three
// different visual languages — the builder used 30px rounded-[6px] buttons with
// 11px labels, the workflows list used inline-styled pill chips, and Skills used
// shadcn's rounded-2xl cards at 14px. Same product, three designs.
//
// Tailwind's `--radius` is 1.25rem globally, so `rounded-md` resolves to 18px
// and `rounded-lg` to 20px — every "rounded" control came out pill-shaped. The
// radii here are explicit pixel values to escape that token.

/** Corner radii. Explicit px — see the --radius note above. */
export const RADIUS = {
  control: "rounded-[6px]",   // buttons, inputs, chips
  card: "rounded-[10px]",     // panels and cards
  node: "rounded-[8px]",      // canvas node cards
  pill: "rounded-full",       // status badges
} as const;

/** Type scale. The app is dense by design; these are the only sizes used. */
export const TEXT = {
  micro: "text-[9.5px] font-extrabold uppercase tracking-[0.08em]", // section labels
  label: "text-[10px] font-semibold",                               // field labels
  body: "text-[11px]",                                              // controls, rows
  title: "text-[13px] font-bold",                                   // card titles
  page: "text-[17px] font-extrabold tracking-[-0.01em]",            // page heading
} as const;

/** Greys. One ramp, so borders and text match across pages. */
export const COLOR = {
  border: "#e8ecf1",
  borderStrong: "#d3dae3",
  text: "#0f172a",
  textMuted: "#64748b",
  textFaint: "#94a3b8",
  surface: "#ffffff",
  surfaceSunken: "#fbfcfd",
  canvas: "#f8fafc",
} as const;

/** Button recipes. Every page uses these rather than hand-rolling a class list. */
export const BTN = {
  base: `h-[30px] ${RADIUS.control} px-3 ${TEXT.body} font-semibold transition-colors disabled:opacity-35`,
  outline: `border border-[${COLOR.borderStrong}] bg-white text-[#334155] hover:bg-[#f8fafc]`,
  primary: "bg-[#0f1117] text-white hover:bg-[#1f2937] border border-[#0f1117]",
  danger: "border border-[#fca5a5] bg-white text-[#dc2626] hover:bg-[#fef2f2]",
} as const;

/** One button class string, composed. */
export function btn(variant: "outline" | "primary" | "danger" = "outline"): string {
  return `${BTN.base} ${BTN[variant]}`;
}

/** Status tones, shared by run badges, health dots and node states. */
export const TONE = {
  ok: { fg: "#166534", bg: "#dcfce7", dot: "#16a34a" },
  fail: { fg: "#991b1b", bg: "#fee2e2", dot: "#dc2626" },
  warn: { fg: "#92400e", bg: "#fef3c7", dot: "#d97706" },
  busy: { fg: "#1e40af", bg: "#dbeafe", dot: "#2563eb" },
  idle: { fg: "#64748b", bg: "#f1f5f9", dot: "#94a3b8" },
} as const;

/** Per-node-type accents. Single source for the canvas, palette and minimap —
 *  these were duplicated in three places and had already drifted. */
export const NODE_ACCENT: Record<string, string> = {
  trigger: "#0891b2",
  supervisorAgent: "#0f1117",
  specialistAgent: "#4f46e5",
  humanApproval: "#d97706",
  conditional: "#6366f1",
  memory: "#0891b2",
  webhook: "#059669",
};

export const nodeAccent = (type?: string) => NODE_ACCENT[String(type)] ?? "#94a3b8";
