/**
 * Minimal, safe Markdown → HTML for UNTRUSTED GitHub comment bodies.
 *
 * Safety model: every piece of source text is HTML-escaped BEFORE any
 * transform, and transforms only ever inject tags we construct ourselves
 * (with regex-validated http(s) URLs inside quoted attributes) — so no
 * author-controlled HTML can reach the page. That is why this exists
 * instead of a full markdown dependency: the app UI holds tokens.
 *
 * Supported: fenced code blocks, inline code, headings, blockquotes,
 * ul/ol lists, hr, bold, strikethrough, links, images, bare-URL autolink,
 * newline = <br> (GitHub comment flavor). Everything else stays text.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline transforms on an ALREADY-ESCAPED line. */
function inline(escaped: string): string {
  // Protect code spans from the other transforms.
  const codes: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Images before links (same bracket syntax). URLs come out of escaped text,
  // so quotes inside them are &quot; and cannot terminate the attribute.
  s = s.replace(
    /!\[([^\]]*)\]\((https?:[^)\s]+)\)/g,
    '<img src="$2" alt="$1" loading="lazy">',
  );
  s = s.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  // Autolink bare URLs (not the ones just placed inside attributes: those are
  // preceded by a quote, this requires start-of-line or whitespace).
  s = s.replace(
    /(^|\s)(https?:\/\/[^\s<]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener">$2</a>',
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");

  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)] ?? ""}</code>`);
}

/** GitHub hides HTML comments (and an unterminated one hides to EOF) — match that. */
function stripComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--[\s\S]*$/, "");
}

export function mdToHtml(src: string): string {
  // Drop hidden comments BEFORE rendering so template boilerplate isn't shown.
  const lines = stripComments(src).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const paragraph: string[] = [];
  const flushP = (): void => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map((l) => inline(escapeHtml(l))).join("<br>")}</p>`);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flushP();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push(`<pre class="code">${escapeHtml(buf.join("\n"))}</pre>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushP();
      const level = Math.min(h[1].length, 3);
      out.push(`<div class="mdh mdh${level}">${inline(escapeHtml(h[2]))}</div>`);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushP();
      out.push("<hr>");
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushP();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(
        `<blockquote>${buf.map((l) => inline(escapeHtml(l))).join("<br>")}</blockquote>`,
      );
      continue;
    }

    const li = line.match(/^\s*([-*+]|\d+\.)\s+/);
    if (li) {
      flushP();
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        // GitHub task list: - [ ] / - [x]
        const task = m[2].match(/^\[([ xX])\]\s+(.*)$/);
        items.push(
          task
            ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(escapeHtml(task[2]))}</li>`
            : `<li>${inline(escapeHtml(m[2]))}</li>`,
        );
        i++;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    if (!line.trim()) {
      flushP();
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushP();
  return out.join("");
}

/**
 * Clip markdown SOURCE without leaving an unclosed code fence behind.
 * Comments are stripped FIRST: clipping must not cut one open (a half
 * comment would escape the renderer's stripping and show as text), and
 * hidden text must not eat the clip budget.
 */
export function clipMd(src: string, max: number): string {
  const clean = stripComments(src);
  if (clean.length <= max) return clean;
  let c = clean.slice(0, max) + "…";
  const fences = (c.match(/^\s*```/gm) ?? []).length;
  if (fences % 2 === 1) c += "\n```";
  return c;
}
