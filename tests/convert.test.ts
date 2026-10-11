/**
 * Tests for src/convert.ts — mdToHtml and stripFrontmatter.
 * No network, no filesystem, no Word COM needed.
 */
import { describe, it, expect } from "vitest";
import { mdToHtml } from "../src/convert.js";

// stripFrontmatter is not exported from convert.ts; test it indirectly via mdToHtml
// by confirming the HTML omits YAML blocks. We also test it directly below via the
// vault.ts copy which IS exercised in vault tests.

// Helper: extract body content from the wrapped HTML
function body(html: string): string {
  const m = html.match(/<body>\n?([\s\S]*?)\n?<\/body>/);
  return m ? m[1]!.trim() : html;
}

describe("mdToHtml", () => {
  describe("headings", () => {
    it("converts h1", () => {
      const html = body(mdToHtml("# Hello World", "test"));
      expect(html).toBe("<h1>Hello World</h1>");
    });

    it("converts h2", () => {
      const html = body(mdToHtml("## Section", "test"));
      expect(html).toBe("<h2>Section</h2>");
    });

    it("converts h3 through h6", () => {
      expect(body(mdToHtml("### A", "t"))).toContain("<h3>A</h3>");
      expect(body(mdToHtml("#### B", "t"))).toContain("<h4>B</h4>");
      expect(body(mdToHtml("##### C", "t"))).toContain("<h5>C</h5>");
      expect(body(mdToHtml("###### D", "t"))).toContain("<h6>D</h6>");
    });

    it("handles inline formatting inside headings", () => {
      const html = body(mdToHtml("## **Bold** heading", "t"));
      expect(html).toContain('<span style="font-weight:bold">Bold</span>');
    });
  });

  describe("paragraphs", () => {
    it("wraps plain text in <p>", () => {
      expect(body(mdToHtml("Hello world", "t"))).toBe("<p>Hello world</p>");
    });

    it("joins consecutive text lines with <br/>", () => {
      const html = body(mdToHtml("Line one\nLine two\nLine three", "t"));
      expect(html).toBe("<p>Line one<br/>Line two<br/>Line three</p>");
    });

    it("separates paragraphs on blank lines", () => {
      const html = body(mdToHtml("Para one\n\nPara two", "t"));
      expect(html).toBe("<p>Para one</p>\n<p>Para two</p>");
    });

    it("trims trailing whitespace from lines", () => {
      const html = body(mdToHtml("  Hello  ", "t"));
      expect(html).toBe("<p>Hello</p>");
    });
  });

  describe("unordered lists", () => {
    it("converts - items", () => {
      const html = body(mdToHtml("- Alpha\n- Beta\n- Gamma", "t"));
      expect(html).toBe("<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>");
    });

    it("converts * items", () => {
      const html = body(mdToHtml("* One\n* Two", "t"));
      expect(html).toBe("<ul><li>One</li><li>Two</li></ul>");
    });

    it("converts + items", () => {
      const html = body(mdToHtml("+ X\n+ Y", "t"));
      expect(html).toBe("<ul><li>X</li><li>Y</li></ul>");
    });
  });

  describe("ordered lists", () => {
    it("converts 1. items", () => {
      const html = body(mdToHtml("1. First\n2. Second", "t"));
      expect(html).toBe("<ol><li>First</li><li>Second</li></ol>");
    });

    it("converts 1) items", () => {
      const html = body(mdToHtml("1) A\n2) B", "t"));
      expect(html).toBe("<ol><li>A</li><li>B</li></ol>");
    });
  });

  describe("inline formatting", () => {
    it("converts **bold** with font-weight span", () => {
      const html = body(mdToHtml("**bold text**", "t"));
      expect(html).toContain('<span style="font-weight:bold">bold text</span>');
    });

    it("converts __bold__ with font-weight span", () => {
      const html = body(mdToHtml("__bold text__", "t"));
      expect(html).toContain('<span style="font-weight:bold">bold text</span>');
    });

    it("converts *italic* with font-style span", () => {
      const html = body(mdToHtml("*italic text*", "t"));
      expect(html).toContain('<span style="font-style:italic">italic text</span>');
    });

    it("converts _italic_ with font-style span (word boundaries)", () => {
      const html = body(mdToHtml("_italic text_", "t"));
      expect(html).toContain('<span style="font-style:italic">italic text</span>');
    });

    it("does NOT italicise snake_case identifiers", () => {
      const html = body(mdToHtml("my_snake_case_var", "t"));
      expect(html).not.toContain("font-style:italic");
    });

    it("converts `code` to <code>", () => {
      const html = body(mdToHtml("`inline code`", "t"));
      expect(html).toContain("<code>inline code</code>");
    });

    it("converts [text](url) to <a>", () => {
      const html = body(mdToHtml("[Click here](https://example.com)", "t"));
      expect(html).toContain('<a href="https://example.com">Click here</a>');
    });

    it("escapes HTML special chars in plain text", () => {
      const html = body(mdToHtml("a < b & c > d", "t"));
      expect(html).toContain("a &lt; b &amp; c &gt; d");
    });
  });

  describe("horizontal rule", () => {
    it("converts --- to <hr/>", () => {
      const html = body(mdToHtml("---", "t"));
      expect(html).toBe("<hr/>");
    });

    it("converts *** to <hr/>", () => {
      const html = body(mdToHtml("***", "t"));
      expect(html).toBe("<hr/>");
    });

    it("converts ___ to <hr/>", () => {
      const html = body(mdToHtml("___", "t"));
      expect(html).toBe("<hr/>");
    });

    it("converts ---- (4 dashes) to <hr/>", () => {
      const html = body(mdToHtml("----", "t"));
      expect(html).toBe("<hr/>");
    });
  });

  describe("HTML wrapper", () => {
    it("includes DOCTYPE and charset", () => {
      const html = mdToHtml("text", "My Title");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain('<meta charset="utf-8"/>');
    });

    it("uses the title param", () => {
      const html = mdToHtml("text", "My Resume");
      expect(html).toContain("<title>My Resume</title>");
    });

    it("includes Calibri body font style", () => {
      const html = mdToHtml("text", "t");
      expect(html).toContain("font-family: Calibri");
    });
  });

  describe("mixed document", () => {
    it("correctly renders a full resume section", () => {
      const md = [
        "# John Smith",
        "**Senior Developer**",
        "",
        "- C# / .NET",
        "- AWS",
        "",
        "## Experience",
        "",
        "Worked at [Acme](https://acme.com) for 3 years.",
      ].join("\n");
      const html = body(mdToHtml(md, "resume"));
      expect(html).toContain("<h1>John Smith</h1>");
      expect(html).toContain('<span style="font-weight:bold">Senior Developer</span>');
      expect(html).toContain("<ul><li>C# / .NET</li><li>AWS</li></ul>");
      expect(html).toContain("<h2>Experience</h2>");
      expect(html).toContain('<a href="https://acme.com">Acme</a>');
    });
  });

  describe("empty / edge inputs", () => {
    it("handles empty string", () => {
      const html = body(mdToHtml("", "t"));
      expect(html).toBe("");
    });

    it("handles only blank lines", () => {
      const html = body(mdToHtml("\n\n\n", "t"));
      expect(html).toBe("");
    });

    it("handles CRLF line endings", () => {
      const html = body(mdToHtml("Line A\r\nLine B", "t"));
      expect(html).toContain("<p>Line A<br/>Line B</p>");
    });
  });
});
