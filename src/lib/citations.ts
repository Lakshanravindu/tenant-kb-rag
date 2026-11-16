import type { SearchResult } from './hybridSearch';

export interface Citation {
  filename: string;
  page: number;
}

export interface CitationCheck {
  cited: Citation[];
  /** Citations that don't match any retrieved chunk — likely hallucinated. */
  unknown: Citation[];
}

// (Doc: some file.pdf, p.12)  — filename may contain spaces but not commas/parens.
const CITATION_RE = /\(Doc:\s*([^,()]+?)\s*,\s*p\.\s*(\d+)\s*\)/g;

export function extractCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const filename = m[1]!;
    const page = Number(m[2]);
    const key = `${filename}#${page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filename, page });
  }
  return out;
}

/** Cross-checks the model's citations against what retrieval actually returned. */
export function checkCitations(text: string, sources: SearchResult[]): CitationCheck {
  const valid = new Set(sources.map((s) => `${s.filename}#${s.pageNumber}`));
  const cited = extractCitations(text);
  return {
    cited,
    unknown: cited.filter((c) => !valid.has(`${c.filename}#${c.page}`)),
  };
}
