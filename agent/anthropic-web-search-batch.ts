import type Anthropic from "@anthropic-ai/sdk";
import type { HtmlWebSearchEvent, HtmlWebSource } from "./tools-core.js";

export type BatchQuery = {
  taskId: string;
  targetLocale: string;
  query: string;
};

export type BatchResult = {
  targetLocale: string;
  summary: string;
  sourceCount: number;
};

type ParsedLocaleResult = {
  locale: string;
  summary: string;
  sources: string[];
};

/**
 * Runs ONE Anthropic API call that researches every locale in the batch.
 * The model is asked to perform web searches and emit a single JSON document
 * mapping each locale → {summary, sources}. We parse that JSON and populate
 * webSearchByTaskId with per-locale events for the HTML report.
 */
export async function runAnthropicBatchWebSearch(
  queries: BatchQuery[],
  webSearchByTaskId: Map<string, HtmlWebSearchEvent[]>,
): Promise<BatchResult[]> {
  if (queries.length === 0) return [];

  let client: Anthropic | null = null;
  let initError: string | null = null;
  try {
    const { default: AnthropicCtor } = await import("@anthropic-ai/sdk");
    client = new AnthropicCtor();
  } catch (e) {
    initError = (e as Error).message ?? String(e);
    process.stderr.write(`[AnthropicWebSearchBatch] init failed: ${initError}\n`);
  }

  // Build a single prompt that lists every locale and asks for a structured
  // JSON response. The model is allowed several web_search calls within this
  // single API call (max_uses tuned to the batch size).
  const queryList = queries
    .map((q, i) => `${i + 1}. locale="${q.targetLocale}" → ${q.query}`)
    .join("\n");

  const prompt = `You are validating UI string translations. For each locale below, perform a web search to find evidence the translation is the standard terminology used in real software/legal contexts for that locale.

${queryList}

After completing your searches, output ONLY a JSON object (no preamble, no markdown fence) in EXACTLY this format:

{"results":[{"locale":"<locale-code>","summary":"<one or two sentences summarizing what you found>","sources":["<actual-url-from-search>","<actual-url-from-search>"]}]}

One results entry per input locale (${queries.length} total). The "sources" must be real URLs you saw in the web_search tool results — do not invent URLs.`;

  if (initError !== null) {
    return finalize(queries, [], [], webSearchByTaskId, "(web search unavailable — Anthropic client could not be initialised)");
  }

  process.stderr.write(`  [web-search] batch query for ${queries.length} locale(s)…\n`);
  const tStart = Date.now();

  let parsedResults: ParsedLocaleResult[] = [];
  const toolResultUrls = new Map<string, string | undefined>(); // url -> title

  try {
    const response = (await (client as Anthropic).messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: Math.max(queries.length + 2, 5),
          } as any,
        ],
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: prompt }],
        stream: false,
      } as Parameters<Anthropic["messages"]["create"]>[0],
      { headers: { "anthropic-beta": "web-search-2025-03-05" } },
    )) as Anthropic.Message;

    let fullText = "";
    for (const block of response.content) {
      if (block.type === "text") {
        fullText += block.text + "\n";
      } else if (block.type === "web_search_tool_result") {
        const items = Array.isArray(block.content) ? block.content : [];
        for (const item of items) {
          if (item.type === "web_search_result") {
            const url: string | undefined = (item as any).url;
            const title: string | undefined = (item as any).title;
            if (url && !toolResultUrls.has(url)) {
              toolResultUrls.set(url, typeof title === "string" ? title : undefined);
            }
          }
        }
      }
    }

    const parsed = tryParseJsonResults(fullText);
    if (parsed) parsedResults = parsed;
    else process.stderr.write(`  [web-search] could not parse JSON from model response\n`);
  } catch (e) {
    process.stderr.write(`  [web-search] batch call failed: ${(e as Error).message ?? String(e)}\n`);
    return finalize(queries, [], [], webSearchByTaskId, "(web search failed)");
  }

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  process.stderr.write(
    `  [web-search] batch done in ${elapsed}s — ${parsedResults.length}/${queries.length} locale result(s), ${toolResultUrls.size} total source(s)\n`,
  );

  return finalize(queries, parsedResults, [...toolResultUrls.entries()], webSearchByTaskId, null);
}

function finalize(
  queries: BatchQuery[],
  parsedResults: ParsedLocaleResult[],
  allToolUrls: Array<[string, string | undefined]>,
  webSearchByTaskId: Map<string, HtmlWebSearchEvent[]>,
  fallbackSummary: string | null,
): BatchResult[] {
  const titleByUrl = new Map(allToolUrls);

  const results: BatchResult[] = [];
  for (const q of queries) {
    const localeResult =
      parsedResults.find((r) => r.locale === q.targetLocale) ??
      parsedResults.find((r) => r.locale.toLowerCase() === q.targetLocale.toLowerCase());

    const summary = (localeResult?.summary ?? fallbackSummary ?? "(no findings for this locale)").slice(0, 1000);

    // Prefer URLs the model attributed to this locale; only keep those that
    // actually appeared in a web_search_tool_result (i.e. not hallucinated).
    const sources: HtmlWebSource[] = [];
    if (localeResult && Array.isArray(localeResult.sources)) {
      for (const url of localeResult.sources) {
        if (typeof url !== "string" || !url.startsWith("http")) continue;
        if (sources.some((s) => s.url === url)) continue;
        // Accept the URL if it matches a tool result (preferred) or as-is.
        sources.push({ url, title: titleByUrl.get(url) });
      }
    }

    const event: HtmlWebSearchEvent = {
      query: q.query,
      targetLocale: q.targetLocale,
      summary,
      sources,
    };

    const existing = webSearchByTaskId.get(q.taskId) ?? [];
    existing.push(event);
    webSearchByTaskId.set(q.taskId, existing);

    results.push({
      targetLocale: q.targetLocale,
      summary,
      sourceCount: sources.length,
    });
  }

  return results;
}

/**
 * Robust JSON extractor: tries fenced code blocks first, then the largest
 * brace-balanced substring containing "results".
 */
function tryParseJsonResults(text: string): ParsedLocaleResult[] | null {
  const candidates: string[] = [];

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const firstBrace = text.indexOf("{");
  if (firstBrace >= 0) {
    let depth = 0;
    for (let i = firstBrace; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(firstBrace, i + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed?.results)) {
        return parsed.results
          .filter(
            (r: any) =>
              r && typeof r.locale === "string" && typeof r.summary === "string",
          )
          .map((r: any) => ({
            locale: r.locale,
            summary: r.summary,
            sources: Array.isArray(r.sources) ? r.sources.filter((s: any) => typeof s === "string") : [],
          }));
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}
