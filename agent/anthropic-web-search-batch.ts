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

export async function runAnthropicBatchWebSearch(
  queries: BatchQuery[],
  webSearchByTaskId: Map<string, HtmlWebSearchEvent[]>,
): Promise<BatchResult[]> {
  let anthropic: any = null;
  let initError: string | null = null;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic();
  } catch (e) {
    initError = (e as Error).message ?? String(e);
    process.stderr.write(`[AnthropicWebSearchBatch] Anthropic client init failed: ${initError}\n`);
  }

  return Promise.all(
    queries.map(async (q): Promise<BatchResult> => {
      const event: HtmlWebSearchEvent = {
        query: q.query,
        targetLocale: q.targetLocale,
        summary: "",
        sources: [],
      };

      if (initError !== null) {
        event.summary = "(web search unavailable — Anthropic client could not be initialised)";
      } else {
        try {
          const response = await anthropic.messages.create(
            {
              model: "claude-haiku-4-5-20251001",
              max_tokens: 1024,
              tools: [{ type: "web_search_20250305", name: "web_search" }],
              messages: [{ role: "user", content: q.query }],
            },
            { headers: { "anthropic-beta": "web-search-2025-03-05" } },
          );

          for (const block of response.content ?? []) {
            if (block.type === "text") {
              event.summary = (event.summary + "\n" + block.text).trim().slice(0, 1000);
            } else if (block.type === "web_search_tool_result") {
              const results: any[] = Array.isArray(block.content) ? block.content : [];
              for (const result of results) {
                if (result.type === "web_search_result") {
                  const url: string = result.url ?? "";
                  const title: string | undefined = result.title;
                  if (url && !event.sources.some((s) => s.url === url)) {
                    event.sources.push({ url, title: typeof title === "string" ? title : undefined });
                  }
                }
              }
            }
          }
        } catch (e) {
          event.summary = "(web search failed)";
          process.stderr.write(
            `[AnthropicWebSearchBatch/${q.targetLocale}] ${(e as Error).message ?? String(e)}\n`,
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
