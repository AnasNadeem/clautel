function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function claudeToTelegram(markdown: string): string {
  let result = "";

  // Split by fenced code blocks, preserving the delimiters
  const parts = markdown.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```")) {
      const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      if (match) {
        const [, lang, code] = match;
        const escaped = escapeHtml(code.trimEnd());
        if (lang) {
          result += `<pre><code class="language-${lang}">${escaped}</code></pre>`;
        } else {
          result += `<pre>${escaped}</pre>`;
        }
      } else {
        result += escapeHtml(part);
      }
    } else {
      // --- Line-level block patterns (headings, blockquotes) ---
      // Extract first with placeholders so inline processing doesn't touch them
      const blockHtml: string[] = [];
      let text = part
        .replace(/^#{1,6}\s+(.+)$/gm, (_, content) => {
          blockHtml.push(`<b>${escapeHtml(content)}</b>`);
          return `\x00BL${blockHtml.length - 1}\x00`;
        })
        .replace(/^>\s?(.+)$/gm, (_, content) => {
          blockHtml.push(`<blockquote>${escapeHtml(content)}</blockquote>`);
          return `\x00BL${blockHtml.length - 1}\x00`;
        });

      // --- Inline code extraction ---
      const inlineCodes: string[] = [];
      text = text.replace(/`([^`]+)`/g, (_, code) => {
        inlineCodes.push(escapeHtml(code));
        return `\x00IC${inlineCodes.length - 1}\x00`;
      });

      // Escape HTML in remaining text
      text = escapeHtml(text);

      // Bold: **text**
      text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

      // Strikethrough: ~~text~~
      text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

      // Italic: *text* or _text_
      text = text.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");
      text = text.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

      // Links: [text](url)
      text = text.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2">$1</a>'
      );

      // Restore inline code
      text = text.replace(
        /\x00IC(\d+)\x00/g,
        (_, i) => `<code>${inlineCodes[Number(i)]}</code>`
      );

      // Restore block HTML (headings, blockquotes)
      text = text.replace(/\x00BL(\d+)\x00/g, (_, i) => blockHtml[Number(i)]);

      result += text;
    }
  }

  return result;
}

// Telegram-supported HTML tags that we need to track across splits
const PAIRED_TAGS = ["b", "i", "s", "u", "code", "pre", "blockquote"];

function getOpenTags(html: string): string[] {
  const stack: string[] = [];
  const tagRe = /<\/?([a-z]+)(?:\s[^>]*)?>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const full = m[0];
    const tagName = m[1].toLowerCase();
    if (!PAIRED_TAGS.includes(tagName)) continue;
    if (full.startsWith("</")) {
      // closing tag — pop the most recent matching open tag
      const idx = stack.lastIndexOf(tagName);
      if (idx !== -1) stack.splice(idx, 1);
    } else {
      stack.push(tagName);
    }
  }
  return stack;
}

// Max extra bytes closing tags can add (e.g. </blockquote></pre></code></b></i></s></u>)
const TAG_RESERVE = 80;

export function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];

  const messages: string[] = [];
  let remaining = text;
  const effectiveLimit = limit - TAG_RESERVE;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      messages.push(remaining);
      break;
    }

    // Find a good split point near the limit, leaving room for closing tags
    let splitIdx = remaining.lastIndexOf("\n", effectiveLimit);
    if (splitIdx < effectiveLimit * 0.3) {
      splitIdx = remaining.lastIndexOf(" ", effectiveLimit);
    }
    if (splitIdx < effectiveLimit * 0.3) {
      splitIdx = effectiveLimit;
    }

    // Don't split inside an HTML tag — back up to before the last unclosed '<'
    const slice = remaining.slice(0, splitIdx);
    const lastLt = slice.lastIndexOf("<");
    const lastGt = slice.lastIndexOf(">");
    if (lastLt > lastGt && lastLt > 0) {
      splitIdx = lastLt;
    }

    let chunk = remaining.slice(0, splitIdx);

    // Close any tags that are still open in this chunk
    const openTags = getOpenTags(chunk);
    if (openTags.length > 0) {
      chunk += openTags.slice().reverse().map((t) => `</${t}>`).join("");
    }

    messages.push(chunk);
    remaining = remaining.slice(splitIdx).trimStart();

    // Re-open tags at the start of the next chunk
    if (openTags.length > 0 && remaining.length > 0) {
      remaining = openTags.map((t) => `<${t}>`).join("") + remaining;
    }
  }

  return messages;
}

export function formatToolCall(
  toolName: string,
  input: Record<string, unknown>
): string {
  const inp = input as Record<string, string>;

  switch (toolName) {
    case "Bash":
      return (
        `<b>Bash Command</b>\n` +
        `<pre>${escapeHtml(inp.command || "")}</pre>`
      );

    case "Edit":
      return (
        `<b>Edit File</b>: <code>${escapeHtml(inp.file_path || "")}</code>\n` +
        `Old:\n<pre>${escapeHtml((inp.old_string || "").slice(0, 300))}</pre>\n` +
        `New:\n<pre>${escapeHtml((inp.new_string || "").slice(0, 300))}</pre>`
      );

    case "Write":
      return (
        `<b>Write File</b>: <code>${escapeHtml(inp.file_path || "")}</code>\n` +
        `<pre>${escapeHtml((inp.content || "").slice(0, 500))}</pre>`
      );

    case "NotebookEdit":
      return (
        `<b>Notebook Edit</b>: <code>${escapeHtml(inp.notebook_path || "")}</code>\n` +
        `<pre>${escapeHtml((inp.new_source || "").slice(0, 500))}</pre>`
      );

    default:
      return (
        `<b>${escapeHtml(toolName)}</b>\n` +
        `<pre>${escapeHtml(JSON.stringify(input, null, 2).slice(0, 500))}</pre>`
      );
  }
}
