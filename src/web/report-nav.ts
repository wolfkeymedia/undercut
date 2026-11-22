import { esc } from "./http.js";

/** The bar across the top of a client's report pages: brand, the report views and the CSV download. */
export const reportNav = {
  css: `<style>
.uc-nav { background: var(--surface); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5; }
.uc-nav .in { max-width: 1040px; margin: 0 auto; padding: 10px 16px; display: flex; gap: 8px 20px; align-items: center; flex-wrap: wrap; }
.uc-nav .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--fg); margin-right: auto; }
.uc-nav .logo i { width: 24px; height: 24px; border-radius: 7px; background: linear-gradient(135deg,#c9cdfb,#f7c9d6 60%,#cdeedd); display: grid; place-items: center; font-style: normal; font-size: 12px; color: #3c3f8f; }
.uc-nav .logo span { color: var(--muted); font-weight: 500; }
.uc-nav nav { display: flex; gap: 4px; flex-wrap: wrap; }
.uc-nav nav a { padding: 6px 12px; border-radius: 8px; color: var(--muted); font-weight: 500; font-size: 0.9rem; text-decoration: none; }
.uc-nav nav a:hover { background: var(--muted-bg); color: var(--fg); }
.uc-nav nav a.on { background: var(--accent-bg); color: var(--accent); }
@media print { .uc-nav { display: none; } }
</style>`,
  html({ base, current, hasStore, clientName }: { base: string; current: "summary" | "details" | "market" | "health"; hasStore: boolean; clientName: string }): string {
    const link = (href: string, label: string, on: boolean) => `<a href="${href}"${on ? ' class="on"' : ""}>${label}</a>`;
    return `<div class="uc-nav"><div class="in"><span class="logo"><i>◆</i>Undercut <span>· ${esc(clientName)}</span></span><nav>${
      (hasStore ? link(base, "This week", current === "summary") + link(`${base}/details`, "Full details", current === "details") : "") +
      link(`${base}/market`, "Market view", current === "market") +
      (hasStore ? link(`${base}/health`, "Site health", current === "health") : "") +
      (hasStore ? link(`${base}/prices.csv`, "Price changes (CSV)", false) : "")
    }</nav></div></div>`;
  },
};
