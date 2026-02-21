import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeToTelegram, splitMessage, formatToolCall } from "../src/formatter.js";

describe("claudeToTelegram", () => {
  it("converts bold text", () => {
    assert.equal(claudeToTelegram("**hello**"), "<b>hello</b>");
  });

  it("converts italic with asterisks", () => {
    assert.equal(claudeToTelegram("*hello*"), "<i>hello</i>");
  });

  it("converts italic with underscores", () => {
    assert.equal(claudeToTelegram("_hello_"), "<i>hello</i>");
  });

  it("converts strikethrough", () => {
    assert.equal(claudeToTelegram("~~hello~~"), "<s>hello</s>");
  });

  it("converts inline code", () => {
    assert.equal(claudeToTelegram("`code`"), "<code>code</code>");
  });

  it("converts fenced code blocks with language", () => {
    const input = "```js\nconsole.log('hi');\n```";
    const expected = `<pre><code class="language-js">console.log('hi');</code></pre>`;
    assert.equal(claudeToTelegram(input), expected);
  });

  it("converts fenced code blocks without language", () => {
    const input = "```\nhello\n```";
    assert.equal(claudeToTelegram(input), "<pre>hello</pre>");
  });

  it("converts headings to bold", () => {
    assert.equal(claudeToTelegram("# Title"), "<b>Title</b>");
    assert.equal(claudeToTelegram("## Subtitle"), "<b>Subtitle</b>");
  });

  it("converts blockquotes", () => {
    assert.equal(claudeToTelegram("> quoted"), "<blockquote>quoted</blockquote>");
  });

  it("converts links", () => {
    assert.equal(
      claudeToTelegram("[click](https://example.com)"),
      '<a href="https://example.com">click</a>'
    );
  });

  it("escapes HTML in regular text", () => {
    assert.equal(claudeToTelegram("<div>test</div>"), "&lt;div&gt;test&lt;/div&gt;");
  });

  it("escapes HTML inside code blocks", () => {
    const input = "```\n<script>alert('xss')</script>\n```";
    assert.ok(claudeToTelegram(input).includes("&lt;script&gt;"));
  });

  it("preserves inline code from bold/italic processing", () => {
    const input = "`**not bold**`";
    assert.equal(claudeToTelegram(input), "<code>**not bold**</code>");
  });

  it("handles mixed inline formatting", () => {
    const result = claudeToTelegram("**bold** and *italic*");
    assert.equal(result, "<b>bold</b> and <i>italic</i>");
  });
});

describe("splitMessage", () => {
  it("returns single message when under limit", () => {
    const result = splitMessage("short message", 100);
    assert.deepEqual(result, ["short message"]);
  });

  it("splits long messages", () => {
    const text = "a".repeat(100);
    const parts = splitMessage(text, 40);
    assert.ok(parts.length > 1);
    // Every part should be under the limit (plus possible closing tags)
    for (const part of parts) {
      assert.ok(part.length <= 60, `Part too long: ${part.length}`);
    }
  });

  it("prefers splitting at newlines", () => {
    const text = "line one\nline two\nline three";
    const parts = splitMessage(text, 15);
    assert.equal(parts[0], "line one");
  });

  it("closes and reopens tags across splits", () => {
    const text = "<pre>" + "x".repeat(100) + "</pre>";
    const parts = splitMessage(text, 50);
    assert.ok(parts.length >= 2);
    // First part should close the <pre>
    assert.ok(parts[0].endsWith("</pre>"), `First part should close pre: ${parts[0]}`);
    // Second part should reopen <pre>
    assert.ok(parts[1].startsWith("<pre>"), `Second part should open pre: ${parts[1]}`);
  });

  it("handles nested tags across splits", () => {
    const text = "<b><i>" + "x".repeat(100) + "</i></b>";
    const parts = splitMessage(text, 50);
    assert.ok(parts.length >= 2);
    // First part should close both tags in reverse order
    assert.ok(parts[0].includes("</i></b>"));
    // Second part should reopen both
    assert.ok(parts[1].startsWith("<b><i>"));
  });
});

describe("formatToolCall", () => {
  it("formats Bash commands", () => {
    const result = formatToolCall("Bash", { command: "ls -la" });
    assert.ok(result.includes("<b>Bash Command</b>"));
    assert.ok(result.includes("ls -la"));
  });

  it("formats Edit with file path", () => {
    const result = formatToolCall("Edit", {
      file_path: "/tmp/test.ts",
      old_string: "old",
      new_string: "new",
    });
    assert.ok(result.includes("/tmp/test.ts"));
    assert.ok(result.includes("old"));
    assert.ok(result.includes("new"));
  });

  it("formats Write with file path", () => {
    const result = formatToolCall("Write", {
      file_path: "/tmp/file.ts",
      content: "hello world",
    });
    assert.ok(result.includes("/tmp/file.ts"));
    assert.ok(result.includes("hello world"));
  });

  it("formats unknown tools with JSON", () => {
    const result = formatToolCall("CustomTool", { foo: "bar" });
    assert.ok(result.includes("CustomTool"));
    assert.ok(result.includes("bar"));
  });

  it("escapes HTML in tool inputs", () => {
    const result = formatToolCall("Bash", { command: "echo '<script>'" });
    assert.ok(result.includes("&lt;script&gt;"));
    assert.ok(!result.includes("<script>"));
  });

  it("truncates long Edit strings", () => {
    const longStr = "x".repeat(500);
    const result = formatToolCall("Edit", {
      file_path: "/tmp/test.ts",
      old_string: longStr,
      new_string: "short",
    });
    // old_string should be truncated to 300
    assert.ok(!result.includes("x".repeat(400)));
  });
});
