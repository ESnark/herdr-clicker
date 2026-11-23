// Mermaid diagrams as plain SVG the app can draw. Loaded only when a preview has a diagram:
// the bundle takes about a second to load.
//
// beautiful-mermaid lays out and draws without a browser (flowchart, state, sequence,
// class, ER, xychart-beta). Its colors are CSS custom properties and color-mix(), which
// the app's SVG renderer doesn't read, so they are computed here and written in as
// #rrggbb; its Google Fonts @import goes too (nothing is fetched).
import { renderMermaidSVG } from "./vendor/beautiful-mermaid.js";

// The diagram types it draws, by their first word (case-insensitive).
const KNOWN = /^(graph|flowchart|statediagram(-v2)?|sequencediagram|classdiagram|erdiagram|xychart(-beta)?)\b/i;

function rgb(color) {
  let h = String(color ?? "").trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((x) => x + x).join("");
  if (!/^[0-9a-f]{6}/i.test(h)) return null;
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

// The index of the ")" that closes the "(" at `open`, or -1.
function closing(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

// "a, b(c, d), e" -> ["a", " b(c, d)", " e"]: commas inside parentheses stay.
function split(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

// Replaces every var(...) and color-mix(...) in `expr` with its value.
function resolve(expr, vars, depth = 0) {
  if (depth > 24) return expr;
  let out = "", i = 0;
  while (i < expr.length) {
    const m = /^(var|color-mix)\(/.exec(expr.slice(i, i + 10));
    if (!m) { out += expr[i++]; continue; }
    const open = i + m[1].length, end = closing(expr, open);
    if (end < 0) { out += expr.slice(i); break; }
    const inner = expr.slice(open + 1, end);
    out += m[1] === "var" ? variable(inner, vars, depth) : mix(inner, vars, depth);
    i = end + 1;
  }
  return out;
}

function variable(inner, vars, depth) {
  const [name, ...fallback] = split(inner);
  const value = vars[name.trim()];
  if (value != null) return resolve(value.trim(), vars, depth + 1);
  return fallback.length ? resolve(fallback.join(",").trim(), vars, depth + 1) : "";
}

// color-mix(in srgb, A p%, B [q%]): mixed channel by channel.
function mix(inner, vars, depth) {
  const parts = split(inner).map((p) => p.trim());
  if (parts.length < 3) return "";
  const read = (p) => {
    const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(resolve(p, vars, depth + 1).trim());
    return { c: rgb(m[1].trim()), p: m[2] != null ? Number(m[2]) / 100 : null };
  };
  const a = read(parts[1]), b = read(parts[2]);
  if (!a.c || !b.c) return "";
  const pa = a.p ?? (b.p != null ? 1 - b.p : 0.5);
  return hex(a.c.map((v, k) => v * pa + b.c[k] * (1 - pa)));
}

// The SVG with plain colors and only the font rules kept.
function flatten(svg, fonts) {
  const vars = {};
  const root = /<svg\b[^>]*\sstyle="([^"]*)"/.exec(svg)?.[1] ?? "";
  const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? "";
  for (const m of (root + ";" + style.replace(/\/\*[\s\S]*?\*\//g, "")).matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) vars[m[1]] = m[2];
  const css = `text { font-family: ${fonts.ui}; } .mono { font-family: ${fonts.mono}; }`;
  return svg
    .replace(/<style>[\s\S]*?<\/style>/, `<style>${css}</style>`)
    // Attribute values only: a label may itself say "var(x)".
    .replace(/(\s[\w:-]+)="([^"]*)"/g, (all, name, value) => {
      if (!/var\(|color-mix\(/.test(value) && !(name.trim() === "style" && value.includes("--"))) return all;
      let v = resolve(value, vars);
      if (name.trim() === "style") v = v.split(";").filter((d) => d.trim() && !d.trim().startsWith("--")).join(";");
      return v ? `${name}="${v}"` : "";
    });
}

// Renders `source` with the panel's colors. Returns { svg, width, height } or throws
// (an unknown diagram type, or a syntax error) with a message for people.
export function renderDiagram(source, { bg, fg, ui, mono }) {
  const text = String(source ?? "").trim();
  const head = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("%%"))?.trim() ?? "";
  if (!KNOWN.test(head)) throw new Error(`Not drawn here: "${head.split(/\s/)[0] || "empty"}" (flowchart, state, sequence, class, ER and xychart are)`);
  const raw = renderMermaidSVG(text, { bg, fg, transparent: true, font: "Inter" });
  const svg = flatten(raw, { ui: `${ui ? `'${ui}', ` : ""}system-ui, -apple-system, 'Helvetica Neue', sans-serif`, mono: `${mono ? `'${mono}', ` : ""}ui-monospace, Menlo, monospace` });
  const num = (name) => Number(new RegExp(`<svg\\b[^>]*\\s${name}="([\\d.]+)"`).exec(svg)?.[1] ?? 0);
  return { svg, width: num("width"), height: num("height") };
}
