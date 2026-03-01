// Markdown-specific parsing: headings as symbols, section chunking, noise stripping
// Makes markdown a first-class indexed format alongside code files

import { SymbolKind, type CodeSymbol } from "./parser.js";

export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

export interface MarkdownSection {
  heading: string;
  line: number;
  anchor: string;
  content: string;
  subHeadings: string[];
}

/**
 * Parse ATX headings from markdown lines, skipping headings inside code fences.
 */
export function extractMarkdownHeadings(lines: string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) continue;

    const match = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i,
      });
    }
  }

  return headings;
}

/**
 * Convert flat headings into a hierarchical CodeSymbol tree.
 * Lower-level headings nest under higher-level ones.
 * Each heading's endLine extends to the line before the next same-or-higher-level heading.
 */
export function buildHeadingTree(headings: MarkdownHeading[], totalLines: number): CodeSymbol[] {
  if (headings.length === 0) return [];

  const symbols: CodeSymbol[] = [];
  const stack: { symbol: CodeSymbol; level: number }[] = [];

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const nextSameOrHigher = headings.slice(i + 1).find((nh) => nh.level <= h.level);
    const endLine = nextSameOrHigher ? nextSameOrHigher.line : totalLines;

    const symbol: CodeSymbol = {
      name: h.text,
      kind: SymbolKind.Section,
      line: h.line + 1, // 1-indexed
      endLine,
      signature: "#".repeat(h.level) + " " + h.text,
      children: [],
    };

    // Pop stack entries that are same-or-lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }

    if (stack.length > 0) {
      stack[stack.length - 1].symbol.children.push(symbol);
    } else {
      symbols.push(symbol);
    }

    stack.push({ symbol, level: h.level });
  }

  return symbols;
}

/**
 * Build a structured header string from markdown headings.
 * Format: "Title | Section1, Section2, Section3"
 */
export function buildMarkdownHeader(headings: MarkdownHeading[]): string {
  if (headings.length === 0) return "";

  const title = headings.find((h) => h.level === 1);
  const sections = headings.filter((h) => h.level === 2).slice(0, 6);

  const parts: string[] = [];
  if (title) parts.push(title.text);
  if (sections.length > 0) {
    parts.push(sections.map((s) => s.text).join(", "));
  }

  return parts.join(" | ");
}

/**
 * Strip noise from markdown content for better embedding quality.
 * - Replace code fence blocks with [code: lang] hint
 * - Convert links to just their text
 * - Remove images
 * - Strip HTML tags
 * - Remove horizontal rules
 * - Normalize whitespace
 */
export function stripMarkdownNoise(content: string): string {
  let result = content;

  // Replace code fence blocks with hint
  result = result.replace(/^(```|~~~)(\w*)\n[\s\S]*?^\1\s*$/gm, (_, _fence, lang) => {
    return lang ? `[code: ${lang}]` : "[code]";
  });

  // Remove images
  result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, "");

  // Convert links to text
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Strip HTML tags
  result = result.replace(/<[^>]+>/g, "");

  // Remove horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");

  // Normalize whitespace: collapse multiple blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Generate a URL-friendly anchor slug from heading text.
 */
function toAnchorSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Split markdown content at ## boundaries into sections.
 * Content before first ## becomes a preamble section.
 * Each section includes its content (noise-stripped), heading, line number, and sub-headings.
 */
export function chunkBySections(lines: string[], headings: MarkdownHeading[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const h2Indices = headings
    .map((h, i) => ({ ...h, idx: i }))
    .filter((h) => h.level === 2);

  const title = headings.find((h) => h.level === 1)?.text ?? "";

  // Preamble: content before first ## heading
  const firstH2Line = h2Indices.length > 0 ? h2Indices[0].line : lines.length;
  if (firstH2Line > 0) {
    const preambleLines = lines.slice(0, firstH2Line);
    const content = stripMarkdownNoise(preambleLines.join("\n"));
    if (content.length >= 50) {
      const subHeadings = headings
        .filter((h) => h.line < firstH2Line && h.level > 1)
        .map((h) => h.text);
      sections.push({
        heading: title || "Introduction",
        line: 0,
        anchor: "",
        content,
        subHeadings,
      });
    }
  }

  // Each ## section
  for (let i = 0; i < h2Indices.length; i++) {
    const current = h2Indices[i];
    const nextH2Line = i + 1 < h2Indices.length ? h2Indices[i + 1].line : lines.length;
    const sectionLines = lines.slice(current.line, nextH2Line);
    const content = stripMarkdownNoise(sectionLines.join("\n"));

    if (content.length < 50) continue;

    const subHeadings = headings
      .filter((h) => h.line > current.line && h.line < nextH2Line && h.level > 2)
      .map((h) => h.text);

    sections.push({
      heading: current.text,
      line: current.line,
      anchor: toAnchorSlug(current.text),
      content,
      subHeadings,
    });
  }

  return sections;
}
