import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractMarkdownHeadings,
  buildHeadingTree,
  buildMarkdownHeader,
  stripMarkdownNoise,
  chunkBySections,
} from "../../build/core/markdown.js";

describe("extractMarkdownHeadings", () => {
  it("extracts ATX headings at all levels", () => {
    const lines = [
      "# Title",
      "Some text",
      "## Section",
      "### Subsection",
      "#### Deep",
      "##### Deeper",
      "###### Deepest",
    ];
    const headings = extractMarkdownHeadings(lines);
    assert.equal(headings.length, 6);
    assert.equal(headings[0].level, 1);
    assert.equal(headings[0].text, "Title");
    assert.equal(headings[0].line, 0);
    assert.equal(headings[1].level, 2);
    assert.equal(headings[1].text, "Section");
    assert.equal(headings[5].level, 6);
    assert.equal(headings[5].text, "Deepest");
  });

  it("skips headings inside code fences", () => {
    const lines = [
      "# Real Title",
      "```",
      "# Not a heading",
      "## Also not",
      "```",
      "## Real Section",
    ];
    const headings = extractMarkdownHeadings(lines);
    assert.equal(headings.length, 2);
    assert.equal(headings[0].text, "Real Title");
    assert.equal(headings[1].text, "Real Section");
  });

  it("skips headings inside tilde code fences", () => {
    const lines = [
      "# Title",
      "~~~",
      "# Fake",
      "~~~",
      "## Real",
    ];
    const headings = extractMarkdownHeadings(lines);
    assert.equal(headings.length, 2);
    assert.equal(headings[0].text, "Title");
    assert.equal(headings[1].text, "Real");
  });

  it("strips trailing # characters from headings", () => {
    const lines = ["## Section ##", "### Another ###"];
    const headings = extractMarkdownHeadings(lines);
    assert.equal(headings.length, 2);
    assert.equal(headings[0].text, "Section");
    assert.equal(headings[1].text, "Another");
  });

  it("returns empty array for no headings", () => {
    const lines = ["Just text", "More text", "```code```"];
    const headings = extractMarkdownHeadings(lines);
    assert.equal(headings.length, 0);
  });
});

describe("buildHeadingTree", () => {
  it("nests ## under # and ### under ##", () => {
    const headings = [
      { level: 1, text: "Title", line: 0 },
      { level: 2, text: "Section A", line: 5 },
      { level: 3, text: "Subsection A1", line: 10 },
      { level: 2, text: "Section B", line: 15 },
    ];
    const tree = buildHeadingTree(headings, 20);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, "Title");
    assert.equal(tree[0].children.length, 2);
    assert.equal(tree[0].children[0].name, "Section A");
    assert.equal(tree[0].children[0].children.length, 1);
    assert.equal(tree[0].children[0].children[0].name, "Subsection A1");
    assert.equal(tree[0].children[1].name, "Section B");
  });

  it("calculates endLine correctly", () => {
    const headings = [
      { level: 1, text: "Title", line: 0 },
      { level: 2, text: "First", line: 5 },
      { level: 2, text: "Second", line: 10 },
    ];
    const tree = buildHeadingTree(headings, 20);
    assert.equal(tree[0].endLine, 20); // Title extends to end
    assert.equal(tree[0].children[0].endLine, 10); // First ends where Second begins
    assert.equal(tree[0].children[1].endLine, 20); // Second extends to end
  });

  it("uses 1-indexed line numbers", () => {
    const headings = [{ level: 1, text: "Title", line: 0 }];
    const tree = buildHeadingTree(headings, 10);
    assert.equal(tree[0].line, 1);
  });

  it("returns empty array for no headings", () => {
    const tree = buildHeadingTree([], 10);
    assert.equal(tree.length, 0);
  });

  it("handles multiple top-level headings", () => {
    const headings = [
      { level: 2, text: "A", line: 0 },
      { level: 2, text: "B", line: 5 },
    ];
    const tree = buildHeadingTree(headings, 10);
    assert.equal(tree.length, 2);
    assert.equal(tree[0].name, "A");
    assert.equal(tree[1].name, "B");
  });
});

describe("buildMarkdownHeader", () => {
  it("formats title + section headings", () => {
    const headings = [
      { level: 1, text: "My Project", line: 0 },
      { level: 2, text: "Install", line: 5 },
      { level: 2, text: "Usage", line: 10 },
      { level: 2, text: "API", line: 15 },
    ];
    const header = buildMarkdownHeader(headings);
    assert.equal(header, "My Project | Install, Usage, API");
  });

  it("uses only title when no ## headings", () => {
    const headings = [{ level: 1, text: "Title", line: 0 }];
    const header = buildMarkdownHeader(headings);
    assert.equal(header, "Title");
  });

  it("uses only sections when no # title", () => {
    const headings = [
      { level: 2, text: "A", line: 0 },
      { level: 2, text: "B", line: 5 },
    ];
    const header = buildMarkdownHeader(headings);
    assert.equal(header, "A, B");
  });

  it("limits to 6 sections", () => {
    const headings = [
      { level: 1, text: "T", line: 0 },
      ...Array.from({ length: 8 }, (_, i) => ({
        level: 2,
        text: `S${i}`,
        line: (i + 1) * 5,
      })),
    ];
    const header = buildMarkdownHeader(headings);
    const sections = header.split(" | ")[1].split(", ");
    assert.equal(sections.length, 6);
  });

  it("returns empty string for no headings", () => {
    assert.equal(buildMarkdownHeader([]), "");
  });
});

describe("stripMarkdownNoise", () => {
  it("replaces code fence blocks with hint", () => {
    const input = "Text before\n```javascript\nconst x = 1;\n```\nText after";
    const result = stripMarkdownNoise(input);
    assert.ok(result.includes("[code: javascript]"));
    assert.ok(!result.includes("const x = 1"));
  });

  it("replaces code fence without language", () => {
    const input = "Before\n```\nsome code\n```\nAfter";
    const result = stripMarkdownNoise(input);
    assert.ok(result.includes("[code]"));
  });

  it("converts links to text", () => {
    const input = "Check [this link](https://example.com) out";
    const result = stripMarkdownNoise(input);
    assert.ok(result.includes("Check this link out"));
    assert.ok(!result.includes("https://example.com"));
  });

  it("removes images", () => {
    const input = "Text ![alt text](image.png) more";
    const result = stripMarkdownNoise(input);
    assert.ok(!result.includes("alt text"));
    assert.ok(!result.includes("image.png"));
  });

  it("strips HTML tags", () => {
    const input = "Text <div class='foo'>content</div> more";
    const result = stripMarkdownNoise(input);
    assert.ok(!result.includes("<div"));
    assert.ok(result.includes("content"));
  });

  it("removes horizontal rules", () => {
    const input = "Above\n---\nBelow\n***\nEnd";
    const result = stripMarkdownNoise(input);
    assert.ok(!result.includes("---"));
    assert.ok(!result.includes("***"));
  });

  it("normalizes excessive blank lines", () => {
    const input = "A\n\n\n\n\nB";
    const result = stripMarkdownNoise(input);
    assert.ok(!result.includes("\n\n\n"));
  });
});

describe("chunkBySections", () => {
  it("splits at ## boundaries", () => {
    const content = [
      "# Title",
      "",
      "Preamble text that is long enough to meet the minimum threshold of fifty characters total content here.",
      "",
      "## Section One",
      "",
      "Content for section one that is long enough to meet the minimum threshold of fifty characters total.",
      "",
      "## Section Two",
      "",
      "Content for section two that is long enough to meet the minimum threshold of fifty characters total.",
    ];
    const headings = extractMarkdownHeadings(content);
    const sections = chunkBySections(content, headings);

    assert.equal(sections.length, 3); // preamble + 2 sections
    assert.equal(sections[0].heading, "Title");
    assert.equal(sections[0].anchor, "");
    assert.equal(sections[1].heading, "Section One");
    assert.equal(sections[1].anchor, "section-one");
    assert.equal(sections[2].heading, "Section Two");
    assert.equal(sections[2].anchor, "section-two");
  });

  it("creates preamble section for content before first ##", () => {
    const content = [
      "# Project Name",
      "",
      "This is a long enough preamble that should create its own section with enough text to pass the minimum.",
      "",
      "## First Section",
      "",
      "First section content that is long enough to meet the minimum threshold of fifty characters total here.",
    ];
    const headings = extractMarkdownHeadings(content);
    const sections = chunkBySections(content, headings);
    assert.ok(sections.length >= 2);
    assert.equal(sections[0].heading, "Project Name");
  });

  it("skips sections shorter than ~50 chars", () => {
    const content = [
      "# Title",
      "",
      "Long enough preamble text that exceeds the fifty character minimum for section content filtering.",
      "",
      "## Short",
      "",
      "Tiny",
      "",
      "## Long Section",
      "",
      "This section has enough content to meet the minimum threshold of fifty characters in its body text.",
    ];
    const headings = extractMarkdownHeadings(content);
    const sections = chunkBySections(content, headings);
    const shortSection = sections.find((s) => s.heading === "Short");
    assert.equal(shortSection, undefined);
  });

  it("includes sub-headings in sections", () => {
    const content = [
      "# Title",
      "",
      "Preamble text that is long enough to meet the minimum threshold of fifty characters total content here.",
      "",
      "## Main Section",
      "",
      "Content for the main section that needs to be long enough for the threshold to pass successfully.",
      "",
      "### Sub One",
      "",
      "Sub content one",
      "",
      "### Sub Two",
      "",
      "Sub content two",
    ];
    const headings = extractMarkdownHeadings(content);
    const sections = chunkBySections(content, headings);
    const mainSection = sections.find((s) => s.heading === "Main Section");
    assert.ok(mainSection);
    assert.deepEqual(mainSection.subHeadings, ["Sub One", "Sub Two"]);
  });

  it("handles file with no ## headings", () => {
    const content = [
      "# Title",
      "",
      "Just a simple document with enough content to pass the fifty character minimum threshold for sections.",
    ];
    const headings = extractMarkdownHeadings(content);
    const sections = chunkBySections(content, headings);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, "Title");
  });

  it("uses 'Introduction' for preamble without title", () => {
    const content = [
      "Some introductory text without any heading that is long enough to pass the minimum threshold of fifty chars.",
      "",
      "## First",
      "",
      "First section content that is long enough to meet the minimum threshold of fifty characters total here.",
    ];
    const headings = extractMarkdownHeadings(content);
    const sections = chunkBySections(content, headings);
    assert.equal(sections[0].heading, "Introduction");
  });
});
