// clicker-files: modified from Herdr's shipped `files` mod (herdrdev/herdr-app, Apache-2.0).
// Changes: a worktree select, a preview that opens in a larger dialog with Preview/Markdown tabs,
// mermaid diagrams and images in the preview, image files shown as pictures.
//
// A lazy file browser for the focused pane's worktree, with bounded read-only previews.
//
// The header's select lists every worktree of that repo (`git worktree list`), on the
// pane's machine. The panel follows the focused pane: it shows the worktree that
// pane's live folder is in. A worktree the person picks holds until focus moves to
// another pane or that pane moves to another worktree; then it follows again.
// The shown worktree is published as shared "clicker-files.worktree" for other mods.
//
// Markdown and mermaid files (.mmd, .mermaid) always show rendered in the panel. The expand
// button at the header's right opens the same file in a dialog (this mod again, with
// `props().view`), which has the Preview | Markdown (Source) tabs. Mermaid diagrams (whole
// files and ```mermaid blocks) are drawn by ./mermaid.js without a browser; images on lines
// of their own are copied into mods/clicker-files-cache/ (the app draws images from its own
// folder only).
// Image files show as the picture, copied there the same way; the larger view shows it bigger
// (and an SVG's source on a Source tab).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Popover, TextView } from "gpui-base";
import { spaces, panes, focused, agents, exec, readTextFile, watchFolder, theme, settings, window, home, appHome, checking, setShared, openOverlay, closeOverlay, props, notify, run } from "herdr";
import * as fs from "fs/promises";
import { splitMarkdown, hash } from "./blocks.js";
import { fromBase64, imageSize } from "./media.js";

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
// HTML files show their source; a header button opens them in the system's browser.
const HTML = /\.(html?|xhtml)$/i;
// Image files the app can draw show as the picture; in the larger view SVG also has a Source tab.
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;
const SVG = /\.svg$/i;
// Rendering is slower than showing source: a very long file previews its first part.
const PREVIEW_LIMIT = 200000;
// Drawn diagrams (named by content) and copied images (named by where they are: a new version
// replaces the old file). A folder of its own under mods/: the app keeps a picture it loaded by
// its path, and reads it again when it is saved under mods/, but not in a hidden folder or
// outside mods/; saving into this mod's own folder would reload the mod.
const CACHE = "mods/clicker-files-cache";
// An image on another machine comes over as base64 in a command's output, decoded in this
// slow JS: keep it small. A local one is read in-process.
const REMOTE_IMAGE_LIMIT = 512 * 1024;
const LOCAL_IMAGE_LIMIT = 50 * 1024 * 1024;
// A diagram wider than the preview shrinks to fit down to this scale; below it, it scrolls.
const MIN_SCALE = 0.75;
// What a file previews as: "md", "mermaid", "svg", "image" (no source), or null (source only).
const previewKind = (file) => !file ? null : MARKDOWN.test(file) ? "md" : MERMAID.test(file) ? "mermaid"
  : SVG.test(file) ? "svg" : IMAGE.test(file) ? "image" : null;
// 245 KB, 1.2 MB.
const fileSize = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
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
    // spot(on, image path) -> { state: "ok" | "error", path, width, height, bytes, ext, error, stale }:
    // markdown images and the open image file. A stale one still shows until it is copied again.
    this.pictures = new Map();
    this.previewWidth = 0; // the preview's width, for fitting diagrams and images
    this.redrawUntil = 0; // see image()
    // Redraws for a moment after a new image is first drawn (see image()). A timer set up here
    // keeps working; outside that moment a tick does nothing.
    cx.timer.every(250, cx => { if (this.redrawUntil > Date.now()) cx.notify(); });
    // The larger view (a dialog): one file of one worktree, given by the panel that opened it.
    const view = _props?.view ?? props()?.view;
    if (view?.file && view.root) {
      this.view = view;
      this.root = view.root; this.on = view.on ?? null;
      this.context = { key: "view", cwd: view.root, on: this.on };
      this.show(view.file, cx);
      // Follows saves, as the panel does: the folder watch (on this computer) and every 10 s.
      this.watch(view.root, cx);
      cx.timer.every(10000, cx => this.reread(cx));
      return;
    }
    // Cache files not written for a month go; one still needed is written again.
    if (!checking()) exec("find", [`${appHome()}/${CACHE}`, "-type", "f", "-mtime", "+30", "-delete"]).catch(() => {});
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
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

  key(tg) {
    // The larger view keeps the worktree it was opened with.
    if (this.view) return "view";
    tg ??= this.target();
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
      try {
        while (this.context === context) {
          const changed = await watchFolder(root);
          if (!this.current(context)) continue;
          // Images from a changed path are copied again (not on every refresh: they aren't read
          // again otherwise). A returned root path means everything under it.
          const hit = (abs) => (changed ?? []).some(p => p === abs || inside(abs, p));
          if (this.staleWhere((on, abs) => !on && hit(abs))) this.wantMedia = true;
          if (this.view) this.reread(cx); else this.refresh(cx);
        }
      }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  // The larger view reads its one file again; the panel refreshes instead.
  reread(cx) {
    if (!this.file) return;
    const context = this.context;
    cx.spawn(async cx => { try { await this.readFile(this.file, context, cx); } catch {} finally { cx.notify(); } });
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
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.text = null; this.lines = null; this.pop = null;
    this.imageActual = false;
    // Opening a file reads its images again: a change the watch missed, or one on another
    // machine (no watch there). The old picture shows until the new copy is written.
    if (path) this.staleWhere(() => true);
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
    const kind = previewKind(path);
    if (kind === "image") return this.readImage(path, context, cx);
    const text = await readTextFile(`${context.cwd}/${path}`, { on: context.on });
    if (this.file !== path || !this.current(context)) return;
    if (text === null) { this.fileError = "This file is no longer available"; return; }
    if (text !== this.text) {
      if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
      const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
      this.code?.release();
      this.text = text; this.fileError = null;
      this.lines = null; this.pop = null; // a new source view has no selection
      this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
        value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
        font_family: settings().font_family, font_size: 12,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      cx?.notify(); // the text shows now; drawings follow
      if (kind === "svg") this.staleWhere((on, abs) => on === (context.on ?? null) && abs === `${context.cwd}/${path}`);
    } else if (!this.wantMedia) return;
    if (kind === "svg") return this.readImage(path, context, cx);
    await this.prepareMedia(path, context, cx);
  }

  // The open image file, copied into the cache: when it opens, and again when it changed
  // (the folder watch says so; an SVG's text changed).
  async readImage(path, context, cx) {
    const abs = `${context.cwd}/${path}`, key = spot(context.on, abs);
    if (!this.need(key) || this.imageLoading === key) return;
    this.imageLoading = key;
    try { await this.copyPicture(key, abs, context.on); }
    finally { if (this.imageLoading === key) this.imageLoading = null; }
    if (this.file === path && this.current(context)) cx?.notify();
  }

  // An image that has no copy yet, or a stale one.
  need(key) {
    const p = this.pictures.get(key);
    return !p || Boolean(p.stale);
  }

  // Marks the images whose (machine, path) pass `test` to be copied again. True if any did.
  staleWhere(test) {
    let any = false;
    for (const [key, p] of this.pictures) {
      const [on, abs] = JSON.parse(key);
      if (!p.stale && test(on, abs)) { p.stale = true; any = true; }
    }
    return any;
  }

  // Copies one image into the cache and records it, or why it couldn't be.
  async copyPicture(key, abs, on) {
    let p;
    try { p = { state: "ok", ...(await this.copyImage(abs, on)) }; }
    catch (e) { p = { state: "error", error: String(e?.message ?? e) }; }
    this.pictures.set(key, p);
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
    const text = full.length > PREVIEW_LIMIT ? full.slice(0, PREVIEW_LIMIT) + "\n\n*… (preview truncated: the larger view's Markdown tab shows more)*" : full;
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

  // Copies one markdown image into the cache. True when it copied it.
  async loadPicture(it) {
    const where = this.pictureSource(it);
    if (!where || !this.need(where.key)) return false;
    await this.copyPicture(where.key, where.abs, this.on);
    return true;
  }

  // The agent a reference goes to: the focused pane's, when it runs on the file's machine
  // (a path means nothing on another one). With its pane's folder, for a shorter path.
  referTarget() {
    if (!this.file || !this.root) return null;
    const paneId = focused()?.pane;
    if (!paneId) return null;
    const agent = agents().find(a => a.pane === paneId);
    if (!agent) return null;
    const machine = agent.address.includes("/") ? agent.address.split("/")[0] : null;
    if (machine !== (this.on ?? null)) return null;
    return { agent, cwd: panes().find(p => p.pane === paneId)?.cwd ?? null };
  }

  // The lines selected in the source view, or null when nothing is. A selection that ends at
  // the start of a line (a drag down to the next line's edge) leaves that line out.
  selectedLines() {
    if (!this.code) return null;
    const r = this.code.selected_range();
    const a = Math.min(r?.start ?? 0, r?.end ?? 0), b = Math.max(r?.start ?? 0, r?.end ?? 0);
    if (b <= a) return null;
    const v = this.code.value();
    const end = v[b - 1] === "\n" && b - 1 > a ? b - 1 : b;
    const line = (o) => v.slice(0, o).split("\n").length;
    return { start: line(a), end: line(end) };
  }

  // The reference as the agent reads it. Claude Code takes `@path#L10-20` as a file reference
  // with a line range; other agents (Codex, pi, ...) get `path:10-20` and read the file
  // themselves. The path is relative to the agent's folder when the file is inside it.
  referText(agent, cwd, lines) {
    const abs = `${this.root}/${this.file}`;
    const dir = (cwd ?? "").replace(/\/+$/, "");
    const path = dir && inside(abs, dir) && abs !== dir ? abs.slice(dir.length + 1) : abs;
    const span = !lines ? "" : lines.start === lines.end ? `${lines.start}` : `${lines.start}-${lines.end}`;
    if (agent.app === "claude-code" || agent.program?.key === "claude") return `@${path}${span ? `#L${span}` : ""}`;
    return span ? `${path}:${span}` : path;
  }

  // The button that adds a reference to the selected lines to the focused agent's input,
  // without sending it. It floats beside where the mouse was let go after selecting. Herdr
  // can't type into a terminal without Enter, so this pastes: the reference goes on the
  // clipboard, the agent's pane takes focus, `terminal.paste` puts it in, and the clipboard
  // gets its text back.
  referButton(t) {
    const pop = this.pop, lines = this.lines;
    if (!pop || !lines) return null;
    const target = this.referTarget();
    if (!target) return null;
    const name = target.agent.program?.name || target.agent.app || "agent";
    const label = lines.start === lines.end ? `L${lines.start}` : `L${lines.start}-${lines.end}`;
    // Below and right of the pointer; above it near the bottom, and kept inside the view.
    const W = 190, H = 28;
    const left = Math.max(6, Math.min(pop.x + 8, pop.width - W - 6));
    const top = pop.y + 14 + H <= pop.height - 6 ? pop.y + 14 : Math.max(6, pop.y - H - 10);
    // The theme's hover color is see-through: the outer layer keeps an opaque background,
    // and only the inner one takes the hover color, so the code behind never shows through.
    return div().id("files-refer").flex().absolute().left(left).top(top).h(H).max_w(W).rounded(7).cursor_pointer()
      .bg(t.popover).border(1).border_color(t.border).shadow_md()
      .tooltip(`Add ${this.referText(target.agent, target.cwd, lines)} to ${name}'s input`)
      // The press stays here: the editor under it would start a new selection.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        const now = this.referTarget();
        const picked = this.selectedLines() ?? lines;
        if (!now || !picked) return;
        const text = ` ${this.referText(now.agent, now.cwd, picked)} `;
        let before;
        try { before = cx.read_from_clipboard(); } catch {}
        cx.write_to_clipboard(text);
        run("pane.focus", { pane: now.agent.pane });
        run("terminal.paste");
        this.pop = null;
        cx.notify();
        // Gives the paste time to read the clipboard, then puts its text back; the larger view
        // closes then, so typing goes on in the agent.
        cx.timer.after(400, cx => {
          if (before !== undefined) { try { cx.write_to_clipboard(before); } catch {} }
          if (this.view) closeOverlay(props()?.overlay);
        });
      })
      .child(h_flex().id("files-refer-face").h_full().min_w(0).px(9).gap(5).items_center().rounded(6)
        .text_size(12).text_color(t.foreground).hover(s => s.bg(t.hover))
        .child(div().flex_none().font_medium().child(label))
        .child(div().flex_none().text_color(t.dim).child("→"))
        .child(div().min_w(0).truncate().text_color(t.muted).child(name)));
  }

  // The source view. Letting go of the mouse reads the selection and puts the reference
  // button there; a new press or a scroll takes it away.
  sourceView(t) {
    if (!this.code) return div().p(12).text_color(t.dim).child(this.fileError || "Loading file…");
    const hide = (_e, cx) => { if (this.pop) { this.pop = null; cx.notify(); } };
    return div().id("files-source").relative().flex().flex_col().flex_1().min_h(0)
      .on_mouse_down("left", hide)
      .on_scroll_wheel(hide)
      .on_mouse_up("left", (e, cx) => {
        const lines = this.selectedLines();
        const b = e.bounds;
        const at = e.local_position ?? (b ? { x: e.position.x - b.x, y: e.position.y - b.y } : null);
        this.lines = lines;
        this.pop = lines && at && b ? { x: at.x, y: at.y, width: b.width, height: b.height } : null;
        cx.notify();
      })
      .child(Editor.new(this.code).flex_1().min_h(0))
      .when(Boolean(this.pop), el => { const b = this.referButton(t); return b ? el.child(b) : el; });
  }

  // The panel header's browser button for an HTML file. A local file opens where it is, so
  // files next to it (CSS, scripts, images) load too. A file on another machine is copied
  // here first, alone: what it links by relative path doesn't come with it.
  browserButton(t) {
    return div().id("files-browser").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(this.on ? `Open a copy in the browser (from ${this.on}; files it links aren't copied)` : "Open in the browser")
      .on_click((_e, cx) => {
        const file = this.file, root = this.root, on = this.on;
        if (!file || !root) return;
        const abs = `${root}/${file}`;
        if (!on) { this.openExternal(abs, cx); return; }
        cx.spawn(async cx => {
          try {
            const text = await readTextFile(abs, { on });
            if (text === null) throw new Error("This file is no longer available");
            const copy = await this.writeCache(`page-${hash(`${on}\u0000${abs}\u0000${text}`)}.html`, text);
            this.openExternal(`${appHome()}/${copy}`, cx);
          } catch (e) {
            notify({ title: "Cannot open in the browser", body: `${file}: ${String(e?.message ?? e)}`, level: "error" });
          }
        });
      })
      .child(svg("mods/clicker-files/external.svg").size(14).flex_none());
  }

  // The panel header's expand button: opens the shown file in the larger view.
  expandButton(t) {
    return div().id("files-expand").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Open in a larger view")
      .on_click((_e, cx) => {
        if (!this.file || !this.root) return;
        openOverlay({ mod: "clicker-files", kind: "dialog", width: 0.82, height: 0.86,
          props: { view: { file: this.file, root: this.root, on: this.on ?? null } } });
      })
      .child(svg("mods/clicker-files/expand.svg").size(14).flex_none());
  }

  // Preview | Markdown (Source for mermaid and SVG files), in the larger view's header. The choice holds for the next ones too.
  mdTabs(t, kind) {
    const tab = (mode, label) => div().id(`files-md-${mode}`).h(22).px(9).flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .when(this.mdMode === mode, el => el.bg(t.raised).text_color(t.foreground).font_medium())
      .when(this.mdMode !== mode, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
      .on_click((_e, cx) => {
        this.mdMode = mode;
        this.pop = null;
        try { localStorage.setItem("md-mode", mode); } catch {}
        cx.notify();
      })
      .child(label);
    return h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.surface).border(1).border_color(t.border)
      .child(tab("preview", "Preview"))
      .child(tab("markdown", kind === "md" ? "Markdown" : "Source"));
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

  // Writes a file into the cache. A diagram's name is a hash of what it holds, so it is written
  // once; an image's is where it came from, so it is written over (`replace`).
  async writeCache(name, contents, replace = false) {
    await this.ensureCache();
    const path = `${appHome()}/${CACHE}/${name}`, rel = `${CACHE}/${name}`;
    if (replace || !(await this.io(() => fs.exists(path)))) await this.io(() => fs.writeFile(path, contents));
    // A picture already drawn is read again by the app once it sees the save: draw for a while.
    if (replace && this.drawn?.has(rel)) this.redrawUntil = Math.max(this.redrawUntil, Date.now() + 4000);
    return rel;
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

  // An image file: fitted to the panel, never enlarged. When it doesn't fit, a click shows it
  // at its own size (scrolling) and another fits it again. Its size and format below.
  imageView(t) {
    const p = this.pictures.get(spot(this.on, `${this.root}/${this.file}`));
    const note = (text, color) => div().p(12).text_size(12).text_color(color ?? t.dim).child(text);
    if (!p) return note(this.fileError || "Loading image…");
    if (p.state === "error") return note(`Image not shown: ${p.error}`, t.blocked);
    const room = this.imageRoom ?? { w: Math.max(120, (this.previewWidth || 420) - 32), h: 320 };
    // No size in its header (an SVG without width, height or viewBox): a square.
    const w = p.width || Math.min(room.w, room.h), h = p.height || w;
    const fit = Math.min(1, room.w / w, room.h / h);
    const actual = this.imageActual && fit < 1;
    const scale = actual ? 1 : fit;
    const info = [p.width && p.height ? `${p.width} × ${p.height}` : null, p.ext.toUpperCase(), fileSize(p.bytes),
      fit < 1 ? (actual ? "100% · click to fit" : `${Math.round(fit * 100)}% · click for 100%`) : null].filter(Boolean).join(" · ");
    return v_flex().flex_1().min_h(0)
      .child(div().id(`files-image-${this.file}`).flex_1().min_h(0).p(16).overflow_scrollbar()
        .when(!actual, el => el.flex().items_center().justify_center())
        .on_size_change((size, cx) => {
          const next = { w: Math.max(40, Math.floor(size.width) - 32), h: Math.max(40, Math.floor(size.height) - 32) };
          if (next.w !== this.imageRoom?.w || next.h !== this.imageRoom?.h) { this.imageRoom = next; cx.notify(); }
        })
        .child(div().id("files-image-pic").flex_none()
          .when(fit < 1, el => el.cursor_pointer().on_click((_e, cx) => { this.imageActual = !this.imageActual; cx.notify(); }))
          .child(this.image(p.path).w(w * scale).h(h * scale))))
      .child(div().h(28).flex_none().px(14).flex().items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate().child(info));
  }

  // Copies an image into the cache under a name from where it is (machine and path), and
  // reads its size from its header. No hash of its bytes: this runtime's JS is too slow for that.
  // Local files are read in-process (under home); elsewhere, and from another machine, they
  // come over as base64 through a program, so only small ones.
  async copyImage(abs, on) {
    const ext = (abs.includes(".") ? abs.split(".").pop() : "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "img";
    let bytes = null;
    // Outside home, fs refuses (it may throw at once rather than reject): fall back below.
    if (!on) { try { bytes = await this.io(() => fs.readFile(abs)); } catch { bytes = null; } }
    if (bytes && bytes.length > LOCAL_IMAGE_LIMIT) throw new Error(`over ${LOCAL_IMAGE_LIMIT / 1024 / 1024} MB`);
    if (!bytes) {
      const r = await exec("sh", ["-c", `[ -f "$1" ] || exit 3; [ "$(wc -c < "$1")" -le ${REMOTE_IMAGE_LIMIT} ] || exit 5; base64 < "$1"`, "sh", abs], { on });
      if (r.code === 3) throw new Error("not found");
      if (r.code === 5) throw new Error(`over ${REMOTE_IMAGE_LIMIT / 1024} KB${on ? ` on ${on}` : ""}`);
      if (r.code !== 0) throw new Error("cannot read it");
      bytes = fromBase64(r.stdout);
    }
    const size = imageSize(bytes, ext);
    const path = await this.writeCache(`img-${hash(spot(on, abs))}.${ext}`, bytes, true);
    return { path, width: size?.width ?? null, height: size?.height ?? null, bytes: bytes.length, ext };
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

  // The larger view: the file's path, the Preview | Markdown tabs and a close button over
  // the preview or the source. Links to other files open here too.
  renderView(t) {
    const kind = previewKind(this.file);
    // Markdown, mermaid and SVG have Preview | Markdown (Source) tabs; other images only the picture.
    const tabs = Boolean(kind) && kind !== "image";
    const sourceShown = !kind || (tabs && this.mdMode !== "preview");
    return v_flex().id("files-view").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(46).flex_none().pl(18).pr(10).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/clicker-files/file.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(this.file ?? ""))
        .when(tabs, el => el.child(this.mdTabs(t, kind)))
        .child(div().id("files-view-close").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Close (Esc)")
          .on_click(() => closeOverlay(props()?.overlay))
          .child(svg("mods/clicker-files/close.svg").size(14).flex_none())))
      .child(sourceShown ? this.sourceView(t) : this.rendered(t, kind));
  }

  // A file shown rendered: the picture of an image (or SVG), else the markdown or mermaid preview.
  rendered(t, kind) {
    return kind === "image" || kind === "svg" ? this.imageView(t) : this.preview(t, kind);
  }

  render(cx) {
    if (this.view) return this.renderView(theme());
    const tg = this.target();
    if (this.key(tg) !== this.context?.key) this.refresh(cx);
    this.publish(tg);
    const t = theme();
    const waiting = tg.cwd && tg.root === undefined;
    const kind = previewKind(this.file);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .when(Boolean(this.file) || !tg.repo, el => el.child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? base(this.root))))
        .when(!this.file && Boolean(tg.repo), el => el.child(div().flex_1()).child(this.select(tg, t)))
        .when(Boolean(kind), el => el.child(this.expandButton(t)))
        .when(HTML.test(this.file ?? ""), el => el.child(this.browserButton(t))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading || waiting ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      // The panel always shows a markdown, mermaid or image file rendered; its source is in the larger view.
      .when(Boolean(kind), el => el.child(this.rendered(t, kind)))
      .when(Boolean(this.file) && !kind, el => el.child(this.sourceView(t)));
  }
}
