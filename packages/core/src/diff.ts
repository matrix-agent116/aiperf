export interface DiffLine {
  /** new-file line number (null for deletions and hunk headers) */
  newLine: number | null;
  type: "add" | "del" | "ctx" | "hunk";
  text: string;
}

/** Parse a unified-diff patch into lines, tracking new-file line numbers. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      // @@ -a,b +c,d @@
      const m = raw.match(/\+(\d+)/);
      newLine = m ? parseInt(m[1], 10) : newLine;
      out.push({ newLine: null, type: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      out.push({ newLine, type: "add", text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-")) {
      out.push({ newLine: null, type: "del", text: raw.slice(1) });
    } else {
      out.push({ newLine, type: "ctx", text: raw.replace(/^ /, "") });
      newLine++;
    }
  }
  return out;
}

/**
 * New-file line numbers that GitHub will accept an inline RIGHT-side comment on
 * (added + context lines within the diff). Comments on other lines 422 the review.
 */
export function commentableLines(patch: string): Set<number> {
  const set = new Set<number>();
  for (const l of parsePatch(patch)) {
    if ((l.type === "add" || l.type === "ctx") && l.newLine != null) {
      set.add(l.newLine);
    }
  }
  return set;
}
