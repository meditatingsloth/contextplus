// Ollama-powered semantic search over file headers and symbol names
// Uses vector embeddings with cosine similarity for concept matching

import { walkDirectory } from "../core/walker.js";
import { analyzeFile, flattenSymbols, isSupportedFile } from "../core/parser.js";
import {
  buildEmbeddingText,
  fetchEmbedding,
  getEmbeddingBatchSize,
  loadEmbeddingCache,
  saveEmbeddingCache,
  SearchIndex,
  type SearchDocument,
  type SearchQueryOptions,
} from "../core/embeddings.js";
import { readFile } from "fs/promises";
import { extname, resolve } from "path";
import { extractMarkdownHeadings, chunkBySections, stripMarkdownNoise, buildMarkdownHeader } from "../core/markdown.js";

export interface SemanticSearchOptions {
  rootDir: string;
  query: string;
  topK?: number;
  semanticWeight?: number;
  keywordWeight?: number;
  minSemanticScore?: number;
  minKeywordScore?: number;
  minCombinedScore?: number;
  requireKeywordMatch?: boolean;
  requireSemanticMatch?: boolean;
}

let cachedIndex: SearchIndex | null = null;
let cachedRootDir: string | null = null;
let lastIndexTime = 0;

const INDEX_TTL_MS = 60000;
const SEARCH_CACHE_FILE = "embeddings-cache.json";
const TEXT_INDEX_EXTENSIONS = new Set([".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".lock", ".env"]);
const MAX_TEXT_DOC_CHARS = 4000;

function isTextIndexCandidate(filePath: string): boolean {
  return TEXT_INDEX_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function extractPlainTextHeader(content: string): string {
  const lines = content.split("\n");
  const headerLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    headerLines.push(trimmed.slice(0, 120));
    if (headerLines.length >= 2) break;
  }
  return headerLines.join(" | ");
}

function hashContent(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function buildSearchDocumentForFile(rootDir: string, relativePath: string): Promise<SearchDocument[]> {
  const normalized = normalizeRelativePath(relativePath);
  const fullPath = resolve(rootDir, normalized);
  const ext = extname(fullPath).toLowerCase();

  if (ext === ".md") {
    return buildMarkdownSearchDocuments(rootDir, normalized, fullPath);
  }

  if (isSupportedFile(fullPath)) {
    try {
      const analysis = await analyzeFile(fullPath);
      const flatSymbols = flattenSymbols(analysis.symbols);
      return [{
        path: normalized,
        header: analysis.header,
        symbols: flatSymbols.map((s) => s.name),
        symbolEntries: flatSymbols.map((s) => ({
          name: s.name,
          kind: s.kind,
          line: s.line,
          endLine: s.endLine,
          signature: s.signature,
        })),
        content: flatSymbols.map((s) => s.signature).join(" "),
      }];
    } catch {
      return [];
    }
  }

  if (!isTextIndexCandidate(fullPath)) return [];

  try {
    const raw = await readFile(fullPath, "utf-8");
    const content = raw.slice(0, MAX_TEXT_DOC_CHARS);
    return [{
      path: normalized,
      header: extractPlainTextHeader(content),
      symbols: [],
      content,
    }];
  } catch {
    return [];
  }
}

async function buildMarkdownSearchDocuments(rootDir: string, normalized: string, fullPath: string): Promise<SearchDocument[]> {
  try {
    const raw = await readFile(fullPath, "utf-8");
    const lines = raw.split("\n");
    const headings = extractMarkdownHeadings(lines);
    const fileHeader = buildMarkdownHeader(headings);
    const title = headings.find((h) => h.level === 1)?.text ?? "";

    const sections = chunkBySections(lines, headings);

    // Small files or files with ≤1 section: single doc
    if (sections.length <= 1) {
      const content = stripMarkdownNoise(raw).slice(0, MAX_TEXT_DOC_CHARS);
      return [{
        path: normalized,
        header: fileHeader,
        symbols: headings.map((h) => h.text),
        content,
      }];
    }

    // Multiple sections: one doc per section
    return sections.map((section) => {
      const sectionPath = section.anchor
        ? `${normalized}#${section.anchor}`
        : normalized;
      const sectionHeader = title && section.heading !== title
        ? `${title} | ${section.heading}`
        : section.heading || fileHeader;
      const symbols = [section.heading, ...section.subHeadings].filter(Boolean);

      return {
        path: sectionPath,
        header: sectionHeader,
        symbols,
        content: section.content.slice(0, MAX_TEXT_DOC_CHARS),
      };
    });
  } catch {
    return [];
  }
}

async function buildIndex(rootDir: string): Promise<SearchIndex> {
  if (cachedIndex && cachedRootDir === rootDir && Date.now() - lastIndexTime < INDEX_TTL_MS) {
    return cachedIndex;
  }

  const entries = await walkDirectory({ rootDir, depthLimit: 0 });
  const files = entries.filter((e) => !e.isDirectory);

  const docs: SearchDocument[] = [];
  for (const file of files) {
    const fileDocs = await buildSearchDocumentForFile(rootDir, file.relativePath);
    docs.push(...fileDocs);
  }

  const index = new SearchIndex();
  await index.index(docs, rootDir);
  cachedIndex = index;
  cachedRootDir = rootDir;
  lastIndexTime = Date.now();

  return index;
}

export async function semanticCodeSearch(options: SemanticSearchOptions): Promise<string> {
  const index = await buildIndex(options.rootDir);
  const searchOptions: SearchQueryOptions = {
    topK: options.topK,
    semanticWeight: options.semanticWeight,
    keywordWeight: options.keywordWeight,
    minSemanticScore: options.minSemanticScore,
    minKeywordScore: options.minKeywordScore,
    minCombinedScore: options.minCombinedScore,
    requireKeywordMatch: options.requireKeywordMatch,
    requireSemanticMatch: options.requireSemanticMatch,
  };
  const results = await index.search(options.query, searchOptions);

  if (results.length === 0) return "No matching files found for the given query.";

  const lines: string[] = [`Top ${results.length} hybrid matches for: "${options.query}"\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.path} (${r.score}% total)`);
    lines.push(`   Semantic: ${r.semanticScore}% | Keyword: ${r.keywordScore}%`);
    if (r.header) lines.push(`   Header: ${r.header}`);
    if (r.matchedSymbols.length > 0) lines.push(`   Matched symbols: ${r.matchedSymbols.join(", ")}`);
    if (r.matchedSymbolLocations.length > 0) lines.push(`   Definition lines: ${r.matchedSymbolLocations.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function invalidateSearchCache(): void {
  cachedIndex = null;
  cachedRootDir = null;
  lastIndexTime = 0;
}

export async function refreshFileSearchEmbeddings(options: { rootDir: string; relativePaths: string[] }): Promise<number> {
  const uniquePaths = Array.from(new Set(options.relativePaths.map(normalizeRelativePath).filter(Boolean)));
  if (uniquePaths.length === 0) return 0;

  const cache = await loadEmbeddingCache(options.rootDir, SEARCH_CACHE_FILE);
  const pending: { path: string; hash: string; text: string }[] = [];

  for (const relativePath of uniquePaths) {
    // Delete all cache entries matching path or path#* (handles section changes)
    delete cache[relativePath];
    for (const key of Object.keys(cache)) {
      if (key.startsWith(relativePath + "#")) {
        delete cache[key];
      }
    }

    const docs = await buildSearchDocumentForFile(options.rootDir, relativePath);
    for (const doc of docs) {
      const text = buildEmbeddingText(doc);
      const hash = hashContent(text);
      if (cache[doc.path]?.hash === hash) continue;
      pending.push({ path: doc.path, hash, text });
    }
  }

  if (pending.length > 0) {
    const batchSize = getEmbeddingBatchSize();
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vectors = await fetchEmbedding(batch.map((entry) => entry.text));
      for (let j = 0; j < batch.length; j++) {
        cache[batch[j].path] = { hash: batch[j].hash, vector: vectors[j] };
      }
    }
  }

  await saveEmbeddingCache(options.rootDir, cache, SEARCH_CACHE_FILE);
  invalidateSearchCache();
  return pending.length;
}
