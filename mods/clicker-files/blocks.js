// What a markdown preview draws, in order: markdown chunks (TextView renders them),
// mermaid diagrams and rows of images (the mod draws those: TextView shows neither).
//
// A ```mermaid / ~~~mermaid fence becomes a diagram wherever it is, even indented in a
// list (the list is then cut in two around it). A line holding only images (markdown
// `![alt](src)`, a linked `[![alt](src)](href)`, or HTML `<img>` in plain wrappers such as
// `<p align="center">`) becomes an image row. Other fences stay markdown, so a mermaid
// fence shown inside another code block stays text.

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
// A link reference definition, "[name]: url" (not a footnote "[^1]: ...").
const REF = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;
const MD_IMG = /\[!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)\]\(\s*<?([^)\s>]+)>?[^)]*\)|!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMG = /<img\b[^>]*>/gi;
const WRAPPERS = /<\/?(?:a|p|div|picture|source|center|span|br)\b[^>]*>/gi;

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}
const px = (v) => (v && /^\d+(\.\d+)?(px)?$/i.test(v.trim()) ? parseFloat(v) : null);

// The images on a line that holds nothing else, or null.
function imageLine(line) {
  if (!line.trim() || !/!\[|<img\b/i.test(line)) return null;
  const items = [];
  let rest = line.replace(MD_IMG, (_all, alt1, src1, href, alt2, src2) => {
    items.push({ alt: alt1 ?? alt2 ?? "", src: src1 ?? src2, href: href ?? null, width: null });
    return "";
  });
  rest = rest.replace(HTML_IMG, (tag) => {
    const src = attr(tag, "src");
    if (src) items.push({ alt: attr(tag, "alt") ?? "", src, href: null, width: px(attr(tag, "width")) });
    return "";
  });
  return items.length && !rest.replace(WRAPPERS, "").trim() ? items : null;
}

// { blocks: [{kind: "md", text} | {kind: "mermaid", source} | {kind: "images", items}], refs }.
// `refs`: every link reference definition, for each markdown chunk to end with (a chunk
// renders on its own, so a [link][ref] whose definition is in another chunk would break).
export function splitMarkdown(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const blocks = [], refs = [];
  let md = [];
  const flush = () => {
    if (md.some((l) => l.trim())) blocks.push({ kind: "md", text: md.join("\n") });
    md = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      const [, indent, marks, info] = f;
      // The fence closes at the next run of the same mark, at least as long; else at the end.
      const close = new RegExp(`^\\s*${marks[0] === "`" ? "`" : "~"}{${marks.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      if (/^\s*mermaid\b/i.test(info)) {
        flush();
        // Inside a list the fence is indented: drop that indent from its lines.
        const body = lines.slice(i + 1, j).map((l) => l.slice(Math.min(indent.length, l.length - l.trimStart().length)));
        blocks.push({ kind: "mermaid", source: body.join("\n") });
      } else md.push(...lines.slice(i, Math.min(j + 1, lines.length)));
      i = j;
      continue;
    }
    if (REF.test(line)) refs.push(line.trim());
    const images = imageLine(line);
    if (images) { flush(); blocks.push({ kind: "images", items: images }); continue; }
    md.push(line);
  }
  flush();
  return { blocks, refs: refs.join("\n") };
}

// A short stable name for a text: FNV-1a 32-bit, plus its length.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + text.length.toString(36);
}
