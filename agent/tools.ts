// Re-export shim. Provider-specific builders live in tools-openai.ts / tools-anthropic.ts.
export { buildOpenAITools as buildMcpServer } from "./tools-openai.js";
export type { ServerDeps, ReportStats } from "./tools-core.js";
