// clicker-files: modified from Herdr's shipped `files` mod (herdrdev/herdr-app, Apache-2.0).
// Changes: a worktree select, Preview/Markdown tabs, mermaid diagrams and images in the preview.
//
// A lazy file browser for the focused pane's worktree, with bounded read-only previews.
//
// The header's select lists every worktree of that repo (`git worktree list`), on the
// pane's machine. The panel follows the focused pane: it shows the worktree that
// pane's live folder is in. A worktree the person picks holds until focus moves to
// another pane or that pane moves to another worktree; then it follows again.
// The shown worktree is published as shared "clicker-files.worktree" for other mods.
//
// Markdown and mermaid files (.mmd, .mermaid) open on a Preview tab. Mermaid diagrams (whole
// files and ```mermaid blocks) are drawn by ./mermaid.js without a browser; images on lines
// of their own are copied into .cache/ (the app draws images from its own folder only).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Popover, TextView } from "gpui-base";
import { spaces, panes, focused, agents, exec, readTextFile, watchFolder, theme, settings, window, home, appHome, checking, setShared } from "herdr";
import * as fs from "fs/promises";
import { splitMarkdown, hash } from "./blocks.js";
import { hashBytes, fromBase64, imageSize } from "./media.js";

// Where the focused pane is now: its live folder, its machine, its space and pane.
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id, pane: f?.pane ?? null };
}
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const SHARED_KEY = "clicker-files.worktree";
const ASK_EVERY = 3000;
// Markdown files open on a Preview tab (rendered) beside a Markdown tab (the source).
const MARKDOWN = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
// Mermaid files open on a Preview tab (the diagram) beside a Source tab.
const MERMAID = /\.(mmd|mermaid)$/i;
// Rendering is slower than showing source: a very long file previews its first part.
const PREVIEW_LIMIT = 200000;
// Drawn diagrams and copied images, by content: hidden, so writing them doesn't reload the mod.
const CACHE = "mods/clicker-files/.cache";
// An image on another machine comes over as base64 in a command argument: keep it small.
const REMOTE_IMAGE_LIMIT = 512 * 1024;
// A diagram wider than the preview shrinks to fit down to this scale; below it, it scrolls.
const MIN_SCALE = 0.75;
// What a file previews as: "md", "mermaid", or null (source only).
const previewKind = (file) => !file ? null : MARKDOWN.test(file) ? "md" : MERMAID.test(file) ? "mermaid" : null;
// A drawing's name: its source and the colors and fonts it was drawn with.
const diagramKey = (source, c) => hash(`${source}\u0000${c.bg}\u0000${c.fg}\u0000${c.ui}\u0000${c.mono}`);

// A folder on a machine, as a map key.
const spot = (on, path) => JSON.stringify([on ?? null, path]);
// `path` is the folder `dir` or inside it.
const inside = (path, dir) => Boolean(path && dir) && (path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/"));
const base = (path) => (path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
// The worktree that holds `path`: the deepest one (a worktree can sit inside the main checkout).
const owner = (path, trees) => trees.filter(w => inside(path, w.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
const treeName = (w) => w.branch ?? (w.head ? `detached ${w.head.slice(0, 7)}` : base(w.path));

// `git worktree list --porcelain`: one record per checkout, the main one first. With -z
// fields end in NUL and records in an empty field; without it, newlines play both parts.
function parseWorktrees(out, sep) {
  const list = [];
  let cur = null;
  for (const field of out.split(sep)) {
    if (field.startsWith("worktree ")) {
      cur = { path: field.slice(9), branch: null, head: null, bare: false, prunable: false, main: list.length === 0 };
      list.push(cur);
    } else if (!cur) continue;
    else if (field === "") cur = null;
    else if (field.startsWith("HEAD ")) cur.head = field.slice(5);
    else if (field.startsWith("branch ")) cur.branch = field.slice(7).replace(/^refs\/heads\//, "");
    else if (field === "bare") cur.bare = true;
    else if (field === "prunable" || field.startsWith("prunable ")) cur.prunable = true;
  }
  // A bare repo has no files to show; a prunable checkout's folder is gone.
  return list.filter(w => !w.bare && !w.prunable);
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.git = new Map(); // spot(on, folder) -> { top, common } | null (not in a repo)
    this.asking = new Set(); // spots whose git is being asked
    this.askedAt = new Map(); // spot -> when its git was last asked
    this.trees = new Map(); // spot(on, common dir) -> that repo's worktrees
    this.pick = null; // { path, pane, space, from }: a worktree the person picked, while it holds
    this.menuOpen = false;
    // The markdown tab last chosen, kept across restarts; Preview by default.
    try { this.mdMode = localStorage.getItem("md-mode") === "markdown" ? "markdown" : "preview"; } catch { this.mdMode = "preview"; }
    this.diagrams = new Map(); // hash of source and colors -> { state: "ok" | "error", path, width, height, error }
    this.pictures = new Map(); // spot(on, image path) -> { state: "ok" | "error", path, width, height, error }
    this.previewWidth = 0; // the preview's width, for fitting diagrams and images
    this.redrawUntil = 0; // see image()
    // Cache files made over a month ago go; one still shown is made again when next needed.
    if (!checking()) exec("find", [`${appHome()}/${CACHE}`, "-type", "f", "-mtime", "+30", "-delete"]).catch(() => {});
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // Redraws for a moment after a new image is first drawn (see image()). A timer set up here
    // keeps working; outside that moment a tick does nothing.
    cx.timer.every(250, cx => { if (this.redrawUntil > Date.now()) cx.notify(); });
  }

  // What the panel shows now. `root`: the picked worktree while the pick holds, else the
  // worktree the focused pane is in (its top), else that pane's folder when it isn't in a
  // repo; undefined while git hasn't answered for that folder yet.
  target() {
    const loc = location();
    if (!loc.cwd) { this.pick = null; return { ...loc, root: null, auto: null, repo: null, trees: [] }; }
    const g = this.git.get(spot(loc.on, loc.cwd));
    if (g === undefined) return { ...loc, root: undefined, auto: undefined, repo: null, trees: [] };
    const auto = g ? g.top : loc.cwd;
    const trees = g ? this.trees.get(spot(loc.on, g.common)) ?? [] : [];
    // A pick holds for the pane it was made on, while that pane stays in the same worktree.
    const p = this.pick;
    if (p && (p.pane !== loc.pane || p.space !== loc.space || p.from !== auto || !g || (trees.length && !trees.some(w => w.path === p.path)))) this.pick = null;
    return { ...loc, root: this.pick?.path ?? auto, auto, repo: g, trees };
  }

  key(tg = this.target()) {
    return JSON.stringify({ root: tg.root ?? null, on: tg.on ?? null, space: tg.space ?? null });
  }

  // Asks git where `cwd` is: its worktree's top and the repo's common git dir. Then
  // lists that repo's worktrees. Refreshes when the answer changed.
  // At most every few seconds per folder unless `force`: the folder watch refreshes on
  // every save while an agent edits files.
  ask(on, cwd, cx, force = false) {
    const k = spot(on, cwd);
    if (!cwd || this.asking.has(k)) return;
    if (!force && this.git.has(k) && Date.now() - (this.askedAt.get(k) ?? 0) < ASK_EVERY) return;
    this.askedAt.set(k, Date.now());
    this.asking.add(k);
    cx.spawn(async cx => {
      const before = JSON.stringify(this.git.get(k));
      let g = null;
      try {
        // Two reads: a folder name may itself contain a newline.
        const [top, common] = await Promise.all([
          exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
          exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
        ]);
        if (top.code === 0 && common.code === 0) g = { top: top.stdout.replace(/\n$/, ""), common: common.stdout.replace(/\n$/, "") };
      } catch { g = this.git.get(k) ?? null; } // the machine is away: keep what it knew
      if (g) await this.listTrees(g, on);
      this.git.set(k, g);
      this.asking.delete(k);
      if (JSON.stringify(g) !== before) this.refresh(cx);
      cx.notify();
    });
  }

  async listTrees(g, on) {
    try {
      // -z needs git 2.36; an older git on another machine gets the newline form.
      let r = await exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd: g.top, on });
      let sep = "\0";
      if (r.code !== 0) { r = await exec("git", ["worktree", "list", "--porcelain"], { cwd: g.top, on }); sep = "\n"; }
      if (r.code === 0) this.trees.set(spot(on, g.common), parseWorktrees(r.stdout, sep));
    } catch {}
  }

  // Tells other mods which worktree is shown, when that changes.
  publish(tg) {
    const value = tg.root ? { space: tg.space ?? null, on: tg.on ?? null, root: tg.root, picked: Boolean(this.pick) } : null;
    const text = JSON.stringify(value);
    if (text === this.published) return;
    this.published = text;
    setShared(SHARED_KEY, value);
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && this.key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const tg = this.target();
    // Ask git again each time: a checkout can appear, move or go between refreshes.
    if (tg.cwd) this.ask(tg.on, tg.cwd, cx);
    const root = tg.root ?? null, on = tg.on, next = this.key(tg);
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd: root, on }; this.root = root; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!root || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(root, cx);
        // The open file follows its saves (an agent writing a doc): read again, rebuilt only if changed.
        if (this.file) await this.readFile(this.file, context, cx).catch(() => {});
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.text = null;
    // Opening a file looks at its images again (they're cached by content, so this is cheap).
    if (path) this.pictures.clear();
    if (!path || !cx) return;
    const context = this.context;
    cx.spawn(async cx => {
      try { await this.readFile(path, context, cx); }
      catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Reads the open file and builds its source view; on a later read, only when its text
  // changed. Then makes what its preview draws (diagrams, images). That work runs here, never
  // while drawing: async work started during a render didn't come back in this runtime.
  async readFile(path, context, cx) {
    const text = await readTextFile(`${context.cwd}/${path}`, { on: context.on });
    if (this.file !== path || !this.current(context)) return;
    if (text === null) { this.fileError = "This file is no longer available"; return; }
    if (text !== this.text) {
      if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
      const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
      this.code?.release();
      this.text = text; this.fileError = null;
      this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
        value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
        font_family: settings().font_family, font_size: 12,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      cx?.notify(); // the text shows now; drawings follow
    } else if (!this.wantMedia) return;
    await this.prepareMedia(path, context, cx);
  }

  // Makes every diagram and image the open file's preview shows, one after another, then
  // draws again. Made ones are kept (by content), so a later call only does what's missing:
  // a render that finds something missing (a new theme, a run cut short) asks for this with
  // `wantMedia`, and the next read (a save, the 10 s refresh) does it.
  async prepareMedia(path, context, cx) {
    const kind = previewKind(path);
    if (!kind || this.mediaBusy) return;
    this.mediaBusy = true;
    this.wantMedia = false;
    let changed = false;
    try {
      const colors = this.diagramColors();
      for (const b of this.previewBlocks(kind).blocks) {
        if (this.file !== path || !this.current(context)) return;
        if (b.kind === "mermaid") changed = (await this.drawDiagram(b.source, colors)) || changed;
        else if (b.kind === "images") for (const it of b.items) changed = (await this.loadPicture(it)) || changed;
      }
    } finally {
      this.mediaBusy = false;
      if (changed && cx) this.settle(cx);
    }
  }

  // The blocks the preview draws, for the open text (markdown split once per text).
  previewBlocks(kind) {
    if (kind === "mermaid") return { blocks: [{ kind: "mermaid", source: this.text ?? "" }], refs: "" };
    const full = this.text ?? "";
    const text = full.length > PREVIEW_LIMIT ? full.slice(0, PREVIEW_LIMIT) + "\n\n*… (preview truncated: the Markdown tab shows more)*" : full;
    if (this.splitText !== text) { this.split = splitMarkdown(text); this.splitText = text; }
    return this.split;
  }

  diagramColors() {
    const t = theme(), s = settings();
    return { bg: t.background, fg: t.foreground, ui: s.ui_font_family, mono: s.font_family };
  }

  // Draws one mermaid source into the cache. True when it made something new.
  async drawDiagram(source, colors) {
    const key = diagramKey(source, colors);
    if (this.diagrams.has(key)) return false;
    let d;
    try {
      const m = await this.mermaid();
      const r = m.renderDiagram(source, colors);
      d = { state: "ok", path: await this.writeCache(`mermaid-${key}.svg`, r.svg), width: r.width, height: r.height };
    } catch (e) { d = { state: "error", error: String(e?.message ?? e) }; }
    this.diagrams.set(key, d);
    return true;
  }

  // Where an image item's file is, or null for what isn't copied (web, data: URLs, outside the root).
  pictureSource(it) {
    if (/^(https?:)?\/\//i.test(it.src) || /^[a-z][a-z0-9+.-]*:/i.test(it.src)) return null;
    const rel = this.resolveLink(it.src);
    if (!rel) return null;
    const abs = `${this.root}/${rel}`;
    return { abs, key: spot(this.on, abs) };
  }

  // Copies one image into the cache. True when it made something new.
  async loadPicture(it) {
    const where = this.pictureSource(it);
    if (!where || this.pictures.has(where.key)) return false;
    let p;
    try { p = { state: "ok", ...(await this.copyImage(where.abs, this.on)) }; }
    catch (e) { p = { state: "error", error: String(e?.message ?? e) }; }
    this.pictures.set(where.key, p);
    return true;
  }

  // Preview | Markdown (Source for a mermaid file), at the header's right end. The choice holds for the next ones too.
  mdTabs(t, kind) {
    const tab = (mode, label) => div().id(`files-md-${mode}`).h(22).px(9).flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .when(this.mdMode === mode, el => el.bg(t.raised).text_color(t.foreground).font_medium())
      .when(this.mdMode !== mode, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
      .on_click((_e, cx) => {
        this.mdMode = mode;
        try { localStorage.setItem("md-mode", mode); } catch {}
        cx.notify();
      })
      .child(label);
    return h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.surface).border(1).border_color(t.border)
      .child(tab("preview", "Preview"))
      .child(tab("markdown", kind === "mermaid" ? "Source" : "Markdown"));
  }

  // The rendered file: markdown chunks, diagrams and images in order. Each file keeps its
  // own scroll, and keeps it when the file is saved again.
  preview(t, kind) {
    if (this.text == null) return div().p(12).text_color(t.dim).child(this.fileError || "Loading file…");
    const { blocks, refs } = this.previewBlocks(kind);
    return v_flex().id(`files-md-scroll-${this.file}`).flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).gap(8).text_size(13.5).text_color(t.foreground)
      .on_size_change((size, cx) => {
        const w = Math.floor(size.width);
        if (w !== this.previewWidth) { this.previewWidth = w; cx.notify(); }
      })
      .children(blocks.map((b, i) =>
        b.kind === "md" ? TextView.markdown(`files-md-view-${this.file}-${i}`, refs ? `${b.text}\n\n${refs}` : b.text).selectable(true).on_link_click((url, cx) => this.follow(url, cx))
        : b.kind === "mermaid" ? this.diagram(b.source, i, t)
        : this.imageRow(b.items, i, t)));
  }

  // The width a diagram or image can take: the preview's, less its padding.
  room() {
    return Math.max(120, (this.previewWidth || 420) - 36);
  }

  // The mermaid helper, loaded on first use.
  mermaid() {
    return (this.mermaidModule ??= import("./mermaid.js"));
  }

  // One fs call at a time. Calls left waiting together never finished (a preview with two
  // diagrams and two images stalled them all); one after another they take milliseconds.
  io(op) {
    const run = (this.ioChain ?? Promise.resolve()).then(op, op);
    this.ioChain = run.catch(() => {});
    return run;
  }

  // In-process (fs), not exec: an exec waits behind every other mod's programs.
  ensureCache() {
    return (this.cacheReady ??= this.io(() => fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true })).catch(e => { this.cacheReady = null; throw e; }));
  }

  // Writes a file into the cache, once: a name is a hash of what it holds.
  async writeCache(name, contents) {
    await this.ensureCache();
    const path = `${appHome()}/${CACHE}/${name}`;
    if (!(await this.io(() => fs.exists(path)))) await this.io(() => fs.writeFile(path, contents));
    return `${CACHE}/${name}`;
  }

  // A mermaid block: the drawing once it's made, else a note; on failure the reason and its source.
  // Drawing only reads: a missing one is asked for, and readFile makes it.
  diagram(source, i, t) {
    const key = diagramKey(source, this.diagramColors());
    const d = this.diagrams.get(key);
    if (!d) {
      this.wantMedia = true;
      return div().py(10).text_size(12).text_color(t.dim).child(this.mermaidModule ? "Drawing diagram…" : "Loading the diagram renderer…");
    }
    if (d.state === "error") return v_flex().gap(4)
      .child(div().text_size(12).text_color(t.blocked).child(`Mermaid diagram not drawn: ${d.error}`))
      .child(TextView.markdown(`files-mmd-src-${key}-${i}`, "```\n" + source.replace(/```/g, "ˋˋˋ") + "\n```").selectable(true));
    const fit = Math.min(1, this.room() / (d.width || 1));
    // Shrink a little to fit; much wider than the panel, keep it legible and scroll sideways.
    if (fit >= MIN_SCALE) return div().child(this.image(d.path).w(d.width * fit).h(d.height * fit));
    return div().id(`files-mmd-${i}`).w_full().overflow_x_scrollbar().child(this.image(d.path).flex_none().w(d.width).h(d.height));
  }

  // An image element. The app starts loading an image file the first time one is drawn and
  // doesn't redraw this panel when it's done, so that draw comes up empty: the first time a
  // path is drawn, the panel draws again for the next 2 s (the timer set up in init).
  image(path) {
    if (!this.drawn?.has(path)) {
      (this.drawn ??= new Set()).add(path);
      this.redrawUntil = Math.max(this.redrawUntil, Date.now() + 2000);
    }
    return image(path);
  }

  // New drawings or images are ready: draw now (their first draw starts the redraws above).
  settle(cx) {
    cx?.notify();
  }

  // Images that stood on a line of their own, side by side, wrapping.
  imageRow(items, i, t) {
    return h_flex().flex_wrap().gap(8).items_end().children(items.map((it, k) => this.picture(it, `${i}-${k}`, t)));
  }

  // One image, or a note in its place. Drawing only reads, as for diagrams.
  picture(it, id, t) {
    const note = (text, onClick) => div().id(`files-img-${id}`).px(8).py(4).rounded(6).border(1).border_color(t.border).text_size(12).text_color(t.dim)
      .when(Boolean(onClick), el => el.cursor_pointer().hover(s => s.text_color(t.foreground)).on_click(onClick))
      .child(text);
    const label = it.alt || base(it.src) || "image";
    // Web images aren't fetched (opening a file shouldn't reach the network): a link instead.
    if (/^(https?:)?\/\//i.test(it.src)) return note(`${label} · web image ↗`, (_e, cx) => this.openExternal(it.src.startsWith("//") ? `https:${it.src}` : it.src, cx));
    if (/^[a-z][a-z0-9+.-]*:/i.test(it.src)) return note(`${label} · not shown`);
    const where = this.pictureSource(it);
    if (!where) return note(`${label} · outside this folder`);
    const p = this.pictures.get(where.key);
    if (!p) { this.wantMedia = true; return note(`${label} · loading…`); }
    if (p.state === "error") return note(`${label} · ${p.error}`);
    // Its own size (or the width the page asked for), never wider than the preview.
    const w0 = it.width || p.width || this.room(), h0 = p.width && p.height ? w0 * p.height / p.width : w0 * 0.6;
    const fit = Math.min(1, this.room() / w0);
    const pic = this.image(p.path).w(w0 * fit).h(h0 * fit);
    return it.href ? div().id(`files-img-${id}`).cursor_pointer().on_click((_e, cx) => this.follow(it.href, cx)).child(pic) : pic;
  }

  // Copies an image into the cache under a name from its bytes, and reads its size from them.
  // Local files are read in-process (under home); elsewhere, and from another machine, they
  // come over as base64 through a program, so only small ones.
  async copyImage(abs, on) {
    const ext = (abs.includes(".") ? abs.split(".").pop() : "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "img";
    let bytes = null;
    // Outside home, fs refuses (it may throw at once rather than reject): fall back below.
    if (!on) { try { bytes = await this.io(() => fs.readFile(abs)); } catch { bytes = null; } }
    if (!bytes) {
      const r = await exec("sh", ["-c", `[ -f "$1" ] || exit 3; [ "$(wc -c < "$1")" -le ${REMOTE_IMAGE_LIMIT} ] || exit 5; base64 < "$1"`, "sh", abs], { on });
      if (r.code === 3) throw new Error("not found");
      if (r.code === 5) throw new Error(`over ${REMOTE_IMAGE_LIMIT / 1024} KB${on ? ` on ${on}` : ""}`);
      if (r.code !== 0) throw new Error("cannot read it");
      bytes = fromBase64(r.stdout);
    }
    const size = imageSize(bytes, ext);
    const path = await this.writeCache(`img-${hashBytes(bytes)}.${ext}`, bytes);
    return { path, width: size?.width ?? null, height: size?.height ?? null };
  }

  // A link in a preview: another file of this worktree opens here; web and mail links open
  // in the system's handler; anything else (other schemes, #anchors) does nothing.
  follow(url, cx) {
    url = String(url ?? "").trim();
    if (!url || url.startsWith("#") || !this.file) return;
    let rel;
    if (/^file:\/\//i.test(url)) {
      let abs = url.replace(/^file:\/\/(localhost)?/i, "").replace(/[?#].*$/, "");
      try { abs = decodeURIComponent(abs); } catch {}
      if (!inside(abs, this.root) || abs === this.root) return;
      rel = abs.slice(this.root.replace(/\/+$/, "").length + 1);
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      if (/^(https?|mailto):/i.test(url)) this.openExternal(url, cx);
      return;
    } else rel = this.resolveLink(url);
    if (!rel) return;
    this.show(rel, cx);
    cx.notify();
  }

  // A relative link in the open file as a path under the root, or null when it leaves it.
  // "/docs/x.md" starts at the worktree's top, as on GitHub; others at the file's folder.
  resolveLink(link) {
    let rel = String(link).replace(/[?#].*$/, "");
    try { rel = decodeURIComponent(rel); } catch {}
    const parts = rel.startsWith("/") ? [] : (this.file ?? "").split("/").slice(0, -1);
    for (const seg of rel.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") { if (!parts.length) return null; parts.pop(); }
      else parts.push(seg);
    }
    return parts.join("/") || null;
  }

  // Web links through the app (no program to start); mailto through the system's opener.
  openExternal(url, cx) {
    if (/^https?:\/\//i.test(url) && cx?.open_url) { try { cx.open_url(url); return; } catch {} }
    const platform = window()?.platform;
    const [cmd, args] = platform === "macos" ? ["open", [url]]
      : platform === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
    exec(cmd, args).catch(() => {});
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/clicker-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/clicker-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // How many agents (on that machine, in any space) have their pane's folder in each worktree.
  agentCounts(tg) {
    const counts = new Map();
    if (!tg.trees.length) return counts;
    const cwd = new Map(panes().map(p => [p.pane, p.cwd]));
    for (const a of agents()) {
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (machine !== (tg.on ?? null)) continue;
      const w = owner(cwd.get(a.pane), tg.trees);
      if (w) counts.set(w.path, (counts.get(w.path) ?? 0) + 1);
    }
    return counts;
  }

  // A path for people: under this computer's home, starting at ~.
  short(path, on) {
    const h = on ? null : home();
    return h && inside(path, h) ? "~" + path.slice(h.length) : path;
  }

  // The select: "Follow focused pane", then every worktree of the repo.
  menu(tg, t) {
    const counts = this.menuOpen ? this.agentCounts(tg) : new Map();
    const autoTree = tg.trees.find(w => w.path === tg.auto);
    const choose = (pick) => (_e, cx) => {
      this.pick = pick;
      this.menuOpen = false;
      this.refresh(cx);
      cx.notify();
    };
    const item = (id, on, icon, title, sub, right, onClick) => h_flex().id(id).min_h(30).py(5).px(8).gap(9).flex_none().items_center().rounded(7)
      .cursor_pointer().hover(s => s.bg(t.hover)).on_click(onClick)
      .child(icon)
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(title))
        .when(Boolean(sub), el => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .when(Boolean(right), el => el.child(right))
      .child(on ? svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground) : div().w(14).flex_none());
    return v_flex().w(320).p(5).bg(t.popover).border(1).border_color(t.border).rounded(10).shadow_lg().text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Worktrees"))
      .child(item("wt-follow", !this.pick, svg("mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(t.muted),
        "Follow focused pane", autoTree ? `now: ${treeName(autoTree)}` : this.short(tg.auto, tg.on), null, choose(null)))
      .child(div().h(1).mx(8).my(4).bg(t.border))
      .child(v_flex().id("wt-list").max_h(360).overflow_y_scroll()
        .children(tg.trees.map(w => {
          const n = counts.get(w.path) ?? 0;
          return item(`wt-${w.path}`, this.pick?.path === w.path,
            svg("mods/workspace-chrome/git-branch.svg").size(14).flex_none().text_color(w.path === tg.root ? t.accent : t.muted),
            treeName(w), `${w.main ? "main checkout · " : ""}${this.short(w.path, tg.on)}`,
            n ? div().flex_none().text_size(11).text_color(t.dim).child(`${n} agent${n === 1 ? "" : "s"}`) : null,
            // Picking what the pane is in already is following it.
            choose(w.path === tg.auto ? null : { path: w.path, pane: tg.pane, space: tg.space, from: tg.auto }));
        })));
  }

  // The header's select button, with the worktree shown now; a pin while a pick holds.
  select(tg, t) {
    const cur = tg.trees.find(w => w.path === tg.root);
    const button = h_flex().id("files-worktree").h(26).max_w(220).px(8).gap(6).flex_none().items_center().rounded(6)
      .cursor_pointer().text_size(12).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(this.pick ? "Picked worktree · focus another pane to follow again" : "Following the focused pane")
      .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none())
      .child(div().min_w(0).truncate().child(cur ? treeName(cur) : base(tg.root)))
      .when(Boolean(this.pick), el => el.child(svg("mods/workspace-chrome/pin.svg").size(11).flex_none().text_color(t.accent)))
      .child(svg("mods/clicker-files/chevron-down.svg").size(11).flex_none());
    return Popover.new("files-worktrees")
      .anchor("top_right")
      .open(this.menuOpen)
      .on_open_change((open, cx) => {
        this.menuOpen = open;
        if (open && tg.repo) this.ask(tg.on, tg.cwd, cx, true); // new checkouts show up in the list
        cx.notify();
      })
      .trigger(button)
      .content(this.menu(tg, t));
  }

  render(cx) {
    const tg = this.target();
    if (this.key(tg) !== this.context?.key) this.refresh(cx);
    this.publish(tg);
    const t = theme();
    const waiting = tg.cwd && tg.root === undefined;
    const kind = previewKind(this.file);
    const md = Boolean(kind);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .when(Boolean(this.file) || !tg.repo, el => el.child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? base(this.root))))
        .when(!this.file && Boolean(tg.repo), el => el.child(div().flex_1()).child(this.select(tg, t)))
        .when(md, el => el.child(this.mdTabs(t, kind))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading || waiting ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(md && this.mdMode === "preview", el => el.child(this.preview(t, kind)))
      .when(Boolean(this.file) && !(md && this.mdMode === "preview"), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
