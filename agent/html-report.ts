import fs from "node:fs/promises";
import path from "node:path";
import type { HtmlLocaleResult, HtmlReportGroup, ReportStats } from "./tools-core.js";

const STYLE = `
:root {
  --bg: #f4f6fb;
  --panel: #ffffff;
  --ink: #1f2937;
  --muted: #6b7280;
  --line: #e5e7eb;
  --blue: #2563eb;
  --green-bg: #dcfce7;
  --green-ink: #166534;
  --blue-bg: #dbeafe;
  --blue-ink: #1d4ed8;
  --yellow-bg: #fef9c3;
  --yellow-ink: #854d0e;
  --red-bg: #fee2e2;
  --red-ink: #991b1b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  color: var(--ink);
  background: radial-gradient(circle at top right, #dff4ff, transparent 42%), var(--bg);
}
main { max-width: 1150px; margin: 0 auto; }
h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -0.02em; }
.subtitle { margin: 0 0 24px; color: var(--muted); }
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.metric {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px;
}
.metric strong { display: block; font-size: 22px; }
.metric span { color: var(--muted); font-size: 13px; }
.group-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  margin: 0 0 14px;
  overflow: hidden;
}
.group-card > summary {
  list-style: none;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  background: linear-gradient(90deg, #f8fafc, #ffffff 40%);
}
.group-card > summary::-webkit-details-marker { display: none; }
.group-meta { color: var(--muted); font-size: 12px; }
.locales { padding: 14px 16px 16px; border-top: 1px solid var(--line); }
.locale-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fbfdff;
  margin-bottom: 10px;
}
.locale-card > summary {
  list-style: none;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
}
.locale-card > summary::-webkit-details-marker { display: none; }
.locale-body {
  border-top: 1px solid var(--line);
  padding: 12px;
  display: grid;
  gap: 10px;
}
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
}
.badge.auto { background: var(--green-bg); color: var(--green-ink); }
.badge.optional { background: var(--blue-bg); color: var(--blue-ink); }
.badge.escalate { background: var(--yellow-bg); color: var(--yellow-ink); }
.badge.mandatory { background: var(--red-bg); color: var(--red-ink); }
.badge.unknown { background: #eef2ff; color: #3730a3; }
.badge.review {
  background: var(--red-bg);
  color: var(--red-ink);
  margin-left: 6px;
}
.kv { font-size: 13px; color: var(--muted); }
.kv strong { color: var(--ink); }
.translation {
  font-size: 15px;
  padding: 10px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.box {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px;
  background: #fff;
  font-size: 12px;
}
.box strong { display: block; font-size: 16px; }
ul { margin: 6px 0 0; padding-left: 18px; }
li { margin: 2px 0; }
.small { font-size: 12px; color: var(--muted); }
code { background: #f1f5f9; padding: 2px 5px; border-radius: 5px; }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
.warn {
  border: 1px solid #f59e0b;
  background: #fffbeb;
  color: #92400e;
  border-radius: 8px;
  padding: 8px;
  font-size: 12px;
}
@media (max-width: 780px) {
  body { padding: 16px; }
  .grid { grid-template-columns: 1fr; }
}
`;

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function toAction(locale: HtmlLocaleResult): { key: string; label: string } {
  const tier = locale.confidence?.tier;
  if (tier === "auto") return { key: "auto", label: "Auto-Accept" };
  if (tier === "optional") return { key: "optional", label: "Optional Review" };
  if (tier === "escalate") return { key: "escalate", label: "Escalate" };
  if (tier === "mandatory") return { key: "mandatory", label: "Mandatory Review" };
  return { key: "unknown", label: "Not Scored" };
}

function renderLocale(locale: HtmlLocaleResult): string {
  const action = toAction(locale);
  const breakdown = locale.confidence?.components;
  const issuesHtml =
    locale.localeValidation && locale.localeValidation.issues.length > 0
      ? `<ul>${locale.localeValidation.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
      : `<div class="small">No locale validation issues.</div>`;

  const alternativesHtml =
    locale.alternatives.length > 0
      ? `<ul>${locale.alternatives.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
      : `<div class="small">No alternatives captured in agent mode.</div>`;

  const webQueriesHtml =
    locale.webValidation.webQueries.length > 0
      ? `<ul>${locale.webValidation.webQueries.map((q) => `<li><code>${escapeHtml(q)}</code></li>`).join("")}</ul>`
      : `<div class="small">No web queries were captured for this locale. Web validation is evidence-only and does not affect the confidence score.</div>`;

  const webSourcesHtml =
    locale.webValidation.webSources.length > 0
      ? `<ul>${locale.webValidation.webSources
          .map((s) => {
            const label = s.title && s.title.trim().length > 0 ? s.title : s.url;
            return `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></li>`;
          })
          .join("")}</ul>`
      : `<div class="small">No source links were captured for this locale.</div>`;

  const summariesHtml =
    locale.webValidation.summaries.length > 0
      ? `<ul>${locale.webValidation.summaries.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
      : `<div class="small">No web evidence summaries were captured.</div>`;

  const transcriptHtml =
    locale.webValidation.transcript.length > 0
      ? `<ul>${locale.webValidation.transcript
          .map((t) => {
            const localeTag = t.targetLocale ? ` [${escapeHtml(t.targetLocale)}]` : "";
            return `<li><strong>Query${localeTag}:</strong> <code>${escapeHtml(t.query)}</code><br><span class="small">Sources in call: ${t.sourceCount}</span><br>${escapeHtml(t.summary || "(no summary)")}</li>`;
          })
          .join("")}</ul>`
      : `<div class="small">No raw WebSearch transcript captured.</div>`;

  const warningHtml = locale.webValidation.warning
    ? `<div class="warn">${escapeHtml(locale.webValidation.warning)}</div>`
    : "";

  return `
<details class="locale-card">
  <summary>
    <div>
      <strong>${escapeHtml(locale.locale)}</strong>
      <span class="badge ${action.key}">${action.label}</span>
      ${locale.needsReview ? '<span class="badge review">Needs Review</span>' : ""}
    </div>
    <div class="kv">Confidence: <strong>${toPercent(locale.confidence?.total ?? null)}</strong></div>
  </summary>
  <div class="locale-body">
    <div class="translation">${escapeHtml(locale.translation)}</div>
    <div class="kv"><strong>Failure reason:</strong> ${escapeHtml(locale.failureReason ?? "None")}</div>

    <div>
      <strong>Confidence Breakdown</strong>
      <div class="grid">
        <div class="box">Web<strong>${toPercent(breakdown?.web ?? null)}</strong></div>
        <div class="box">Locale<strong>${toPercent(breakdown?.locale ?? null)}</strong></div>
        <div class="box">Structure<strong>${toPercent(breakdown?.structure ?? null)}</strong></div>
      </div>
    </div>

    <div>
      <strong>Validation Details</strong>
      <div class="small">${escapeHtml(locale.webValidationNote)}</div>
      <div class="kv"><strong>Locale validation score:</strong> ${toPercent(locale.localeValidation?.score ?? null)}</div>
      ${issuesHtml}
    </div>

    <div>
      <strong>Web Validation</strong>
      ${warningHtml}
      <div class="kv"><strong>Evidence status:</strong> ${escapeHtml(locale.webValidation.evidenceStatus)}</div>
      <div class="kv"><strong>Evidence origin:</strong> ${escapeHtml(locale.webValidation.evidenceOrigin)}</div>
      <div class="kv"><strong>Source count:</strong> ${locale.webValidation.sourceCount}</div>
      <div class="kv"><strong>Supported:</strong> ${locale.webValidation.supported === null ? "n/a" : locale.webValidation.supported ? "yes" : "no"}</div>
      <div class="small"><strong>Search queries</strong></div>
      ${webQueriesHtml}
      <div class="small"><strong>Sources searched / reference links</strong></div>
      ${webSourcesHtml}
      <div class="small"><strong>Evidence summaries</strong></div>
      ${summariesHtml}
      <div class="small"><strong>Raw WebSearch transcript</strong></div>
      ${transcriptHtml}
    </div>

    <div>
      <strong>Alternatives</strong>
      ${alternativesHtml}
    </div>
  </div>
</details>`;
}

function renderGroup(group: HtmlReportGroup): string {
  const reviewCount = group.locales.filter((l) => l.needsReview).length;
  return `
<details class="group-card">
  <summary>
    <div>
      <strong>${escapeHtml(group.keyPath)}</strong>
      <div class="group-meta">
        bundle=${escapeHtml(group.bundleId)} | status=${escapeHtml(group.status)} | placement=${escapeHtml(group.placement)}
      </div>
      <div class="small">${escapeHtml(group.sourceLocale)} source: ${escapeHtml(group.sourceText)}</div>
    </div>
    <div class="kv">
      <strong>${group.locales.length}</strong> locale(s)<br>
      <span>${reviewCount} need review</span>
    </div>
  </summary>
  <div class="locales">
    ${group.locales.map((locale) => renderLocale(locale)).join("")}
  </div>
</details>`;
}

function timestampForFilename(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

export function buildHtmlReport(report: ReportStats): string {
  const groups = report.htmlReport?.groups ?? [];
  const generatedAt = report.htmlReport?.generatedAt ?? new Date().toISOString();

  const body = groups.length > 0
    ? groups.map((group) => renderGroup(group)).join("\n")
    : `<div class="group-card" style="padding:16px;">No translation groups were captured for this run.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>translations-agent report</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>Translation Report</h1>
    <p class="subtitle">Generated ${escapeHtml(generatedAt)} | Source locale: ${escapeHtml(report.sourceLocale)} | Targets: ${escapeHtml(report.targetLocales.join(", "))}</p>

    <section class="summary">
      <div class="metric"><strong>${report.detectedBundles}</strong><span>Detected bundles</span></div>
      <div class="metric"><strong>${report.changedKeys}</strong><span>Changed keys</span></div>
      <div class="metric"><strong>${report.translatedAuto}</strong><span>Auto translated</span></div>
      <div class="metric"><strong>${report.flaggedForReview}</strong><span>Flagged for review</span></div>
    </section>

    ${body}
  </main>
</body>
</html>`;
}

export async function writeHtmlReport(root: string, report: ReportStats): Promise<string> {
  const reportsDir = path.resolve(root, "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const filename = `translation-report-${timestampForFilename(new Date())}.html`;
  const outPath = path.join(reportsDir, filename);
  const html = buildHtmlReport(report);
  await fs.writeFile(outPath, html, "utf8");
  return outPath;
}
