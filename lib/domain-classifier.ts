export type Domain = "eDiscovery" | "Legal" | "Tech" | "general";

const KEYWORDS: Record<Exclude<Domain, "general">, string[]> = {
  eDiscovery: [
    "ediscovery", "e-discovery", "custodian", "hold", "legal hold", "collection", "review", "production",
    "processing", "preservation", "matter", "case", "litigation", "deposition", "interrogatory", "relativity",
    "nuix", "concordance", "load file", "bates", "privilege", "redact", "metadata", "defensible", "spoliation",
    "esi",
  ],
  Legal: [
    "legal", "law", "statute", "regulation", "compliance", "contract", "agreement", "liability", "jurisdiction",
    "court", "attorney", "counsel", "plaintiff", "defendant", "verdict", "judgment", "arbitration", "mediation",
    "clause", "provision", "breach",
  ],
  Tech: [
    "software", "api", "endpoint", "server", "database", "cloud", "deploy", "configuration", "settings",
    "authentication", "login", "upload", "dashboard", "analytics", "export", "import", "integration", "webhook",
  ],
};

export function classifyDomain(text: string): { domain: Domain; confidence: number; hits: Record<string, number> } {
  const lower = text.toLowerCase();
  const hits: Record<Exclude<Domain, "general">, number> = { eDiscovery: 0, Legal: 0, Tech: 0 };

  for (const [domain, keywords] of Object.entries(KEYWORDS) as Array<[Exclude<Domain, "general">, string[]]>) {
    for (const kw of keywords) {
      const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "g");
      const matches = lower.match(re);
      if (matches) hits[domain] += matches.length;
    }
  }

  const sorted = (Object.entries(hits) as Array<[Exclude<Domain, "general">, number]>).sort((a, b) => b[1] - a[1]);
  const [topDomain, topCount] = sorted[0]!;
  const [, secondCount] = sorted[1]!;

  if (topCount === 0) return { domain: "general", confidence: 0, hits };

  // Confidence: ratio of top to total + margin over second
  const total = sorted.reduce((s, [, c]) => s + c, 0);
  const margin = (topCount - secondCount) / Math.max(total, 1);
  const confidence = Math.min(1, topCount / total + margin * 0.2);

  return { domain: topDomain, confidence, hits };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
