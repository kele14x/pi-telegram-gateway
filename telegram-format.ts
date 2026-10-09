/** Convert agent Markdown to Telegram text + UTF-16 entities before chunking. */
import { Lexer, type Token, type Tokens } from "marked";
import type { MessageEntity } from "telegraf/types";

export interface FormattedText {
  text: string;
  entities: MessageEntity[];
}

/** A UTF-16 boundary that never separates a surrogate pair. */
export function chunkEnd(text: string, limit: number): number {
  let end = Math.min(limit, text.length);
  if (end > 0 && end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return end;
}

function linkUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (["http:", "https:", "mailto:", "tg:"].includes(url.protocol)) return url.href;
  } catch { /* Relative file paths remain readable text. */ }
  return undefined;
}

export function renderMarkdown(source: string): FormattedText {
  let text = "";
  const entities: MessageEntity[] = [];
  const append = (value: string) => { text += value; };
  const span = (entity: MessageEntity, render: () => void) => {
    const offset = text.length;
    render();
    if (text.length > offset) entities.push({ ...entity, offset, length: text.length - offset });
  };
  const trailingLines = (token: Token) => append(token.raw.match(/\n+$/)?.[0] ?? "");

  function render(tokens: Token[], depth = 0): void {
    for (const token of tokens) {
      switch (token.type) {
        case "space":
        case "html":
          // Raw HTML is content, never interpreted as Telegram markup.
          append(token.raw);
          break;
        case "paragraph":
        case "text": {
          const block = token as Tokens.Paragraph | Tokens.Text;
          if (block.tokens) {
            render(block.tokens, depth);
            trailingLines(token);
          } else append(block.text);
          break;
        }
        case "heading":
          span({ type: "bold", offset: 0, length: 0 }, () => render((token as Tokens.Heading).tokens, depth));
          trailingLines(token);
          break;
        case "strong":
        case "em":
        case "del": {
          const type = token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough";
          span({ type, offset: 0, length: 0 }, () => render((token as Tokens.Strong).tokens, depth));
          break;
        }
        case "codespan":
          span({ type: "code", offset: 0, length: 0 }, () => append((token as Tokens.Codespan).text));
          break;
        case "code": {
          const code = token as Tokens.Code;
          const language = code.lang?.split(/\s/)[0];
          span({ type: "pre", offset: 0, length: 0,
            ...(language && /^[\w.+-]+$/.test(language) ? { language } : {}) }, () => append(code.text));
          trailingLines(token);
          break;
        }
        case "link": {
          const link = token as Tokens.Link;
          const url = linkUrl(link.href);
          if (url) span({ type: "text_link", offset: 0, length: 0, url }, () => render(link.tokens, depth));
          else append(link.raw);
          break;
        }
        case "image": {
          const image = token as Tokens.Image;
          // Sending embedded media is a separate gateway feature; retain its URL.
          append(`${image.text || "Image"} (${image.href})`);
          break;
        }
        case "blockquote":
          span({ type: "blockquote", offset: 0, length: 0 }, () => render((token as Tokens.Blockquote).tokens, depth));
          break;
        case "list": {
          const list = token as Tokens.List;
          list.items.forEach((item, index) => {
            if (index > 0 && !text.endsWith("\n")) append("\n");
            append("  ".repeat(depth));
            append(item.task ? (item.checked ? "☑ " : "☐ ") : list.ordered ? `${Number(list.start) + index}. ` : "• ");
            render(item.tokens, depth + 1);
          });
          trailingLines(token);
          break;
        }
        case "table":
          // Telegram has no native tables; monospace retains the source layout.
          span({ type: "pre", offset: 0, length: 0 }, () => append(token.raw));
          break;
        case "hr":
          append("────────");
          trailingLines(token);
          break;
        case "br":
          append("\n");
          break;
        case "escape":
          append((token as Tokens.Escape).text);
          break;
        case "def":
          // Reference definitions are consumed by Marked's link lexer.
          break;
        default:
          append(token.raw);
      }
    }
  }

  try {
    // Parse the whole run so fences and inline spans can cross message boundaries.
    render(Lexer.lex(source, { gfm: true }));
  } catch {
    return { text: source, entities: [] };
  }

  // Telegram disallows code/pre inside other entities, and nesting between
  // links/quotes. Split enclosing spans around those ranges, preserving code.
  const styles = new Set(["bold", "italic", "strikethrough"]);
  const normalized: MessageEntity[] = [];
  for (const entity of entities) {
    let ranges = [{ start: entity.offset, end: entity.offset + entity.length }];
    const blockers = entities.filter(other => other !== entity &&
      (other.type === "code" || other.type === "pre" ||
       (!styles.has(entity.type) && !styles.has(other.type) &&
        (other.length < entity.length || (other.length === entity.length && entities.indexOf(other) < entities.indexOf(entity))))));
    for (const other of blockers) {
      ranges = ranges.flatMap(range => {
        const start = Math.max(range.start, other.offset);
        const end = Math.min(range.end, other.offset + other.length);
        if (start >= end) return [range];
        return [{ start: range.start, end: start }, { start: end, end: range.end }].filter(part => part.start < part.end);
      });
    }
    for (const range of ranges) normalized.push({ ...entity, offset: range.start, length: range.end - range.start });
  }
  const unique = normalized.filter((entity, index) => normalized.findIndex(other =>
    JSON.stringify(other) === JSON.stringify(entity)) === index);
  unique.sort((a, b) => a.offset - b.offset || b.length - a.length);
  // Formatting-only input (e.g. an empty fence) must not create an empty API call.
  return text ? { text, entities: unique } : { text: source, entities: [] };
}

export function splitFormatted(value: FormattedText, limit: number): FormattedText[] {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError("Chunk limit must be at least two UTF-16 units");
  const chunks: FormattedText[] = [];
  for (let start = 0; start < value.text.length;) {
    const end = start + chunkEnd(value.text.slice(start), limit);
    const entities = value.entities.flatMap(entity => {
      const offset = Math.max(start, entity.offset);
      const last = Math.min(end, entity.offset + entity.length);
      return offset < last ? [{ ...entity, offset: offset - start, length: last - offset }] : [];
    });
    chunks.push({ text: value.text.slice(start, end), entities });
    start = end;
  }
  // A trailing newline at exactly the chunk boundary must not become an empty
  // Telegram message. Keep whitespace within content-bearing chunks intact.
  while (chunks.length && !chunks[chunks.length - 1].text.trim()) chunks.pop();
  return chunks;
}
