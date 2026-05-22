import type { HtmlWebSearchEvent } from "./tools-core.js";

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

export async function runBatchWebSearch(
  queries: BatchQuery[],
  webSearchByTaskId: Map<string, HtmlWebSearchEvent[]>,
): Promise<BatchResult[]> {
  // Initialise the client once. If it fails, every query still gets a stored
  // event (with an unavailability summary) so buildWebValidation sees evidence
  // rather than the "WebSearch was not called" warning.
  let openai: any = null;
  let initError: string | null = null;
  try {
    const { default: OpenAI } = await import("openai");
    openai = new OpenAI();
  } catch (e) {
    initError = (e as Error).message ?? String(e);
    process.stderr.write(`[WebSearchBatch] OpenAI client init failed: ${initError}\n`);
  }

  return Promise.all(
    queries.map(async (q): Promise<BatchResult> => {
      // Build the event upfront — always stored, even on failure, so the
      // query appears in the HTML report regardless of whether the search succeeded.
      const event: HtmlWebSearchEvent = {
        query: q.query,
        targetLocale: q.targetLocale,
        summary: "",
        sources: [],
      };

      if (initError !== null) {
        event.summary = "(web search unavailable — OpenAI client could not be initialised)";
      } else {
        try {
          const response = await (openai.chat.completions as any).create({
            model: "gpt-4o-search-preview",
            web_search_options: {},
            messages: [{ role: "user", content: q.query }],
          });

          const choice = response.choices?.[0];
          const text: string =
            typeof choice?.message?.content === "string" ? choice.message.content : "";
          event.summary = text.trim().slice(0, 1000);

          const annotations: any[] = Array.isArray(choice?.message?.annotations)
            ? choice.message.annotations
            : [];
          for (const ann of annotations) {
            if (ann.type !== "url_citation") continue;
            const url: string = ann.url_citation?.url ?? ann.url ?? "";
            const title: string | undefined = ann.url_citation?.title ?? ann.title;
            if (url && !event.sources.some((s) => s.url === url)) {
              event.sources.push({ url, title: typeof title === "string" ? title : undefined });
            }
          }

          if (event.sources.length === 0) {
            const urlMatches = text.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [];
            for (const raw of urlMatches) {
              const url = raw.replace(/[.,;:]+$/, "");
              if (url && !event.sources.some((s) => s.url === url)) event.sources.push({ url });
            }
          }
        } catch (e) {
          event.summary = "(web search failed)";
          process.stderr.write(
            `[WebSearchBatch/${q.targetLocale}] ${(e as Error).message ?? String(e)}\n`,
          );
        }
      }

      const existing = webSearchByTaskId.get(q.taskId) ?? [];
      existing.push(event);
      webSearchByTaskId.set(q.taskId, existing);

      return {
        targetLocale: q.targetLocale,
        summary: event.summary,
        sourceCount: event.sources.length,
      };
    }),
  );
}

export function formatBatchResults(results: BatchResult[]): string {
  return results
    .map((r) => `[${r.targetLocale}]\n${r.summary.slice(0, 400)}\nSources: ${r.sourceCount}`)
    .join("\n\n---\n\n");
}
