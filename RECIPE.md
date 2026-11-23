# Clicker

Herdr's default window, tuned for working one workspace at a time. The Agents list shows
only the selected space's agents by default. Resting the pointer on a space shows a card of
that space's agents beside it, so another space's agent is one click away. The Files panel
follows the focused pane into whatever git worktree it is in, lets you pick any worktree of
that repo, and previews Markdown and Mermaid files, diagrams and images included, and image
files.

## What you see

Left to right, then top to bottom:

- **Sidebar**, 268 px (44–480, drag its edge), theme `chrome` background. Below 160 px
  its lists draw a compact rail; the fold toggle sets 44 px (76 on macOS):
  - Brand bar, 46 px, drags the window (shipped `workspace-chrome`).
  - **Spaces** (`clicker-spaces`) and **Agents** (`clicker-agents`), sharing the rest
    equally (weight 1 each, at least 90 px); the line between them drags.
  - Footer, 69 px (shipped `workspace-chrome` with `{ "footer": true }`).
- **Work column**, the rest of the width:
  - Tab bar, 42 px, drags the window (shipped `tabs`; its Files and Changes buttons, for
    the panels turned on in Herdr's welcome, open the right panel).
  - Work body, 8 px padding and gap: the shown tab's panes as cards (radius 10, 1 px
    `border`, 1 px `accent` border on the focused pane, framed even when alone), each with
    a 30 px header on top (shipped `pane`). On the right, a hidden panel, 368 px
    (280–900): a stack of **Files** (`clicker-files`) and **Changes** (shipped `changes`).
  - Status bar, 28 px (shipped `workspace-status`).

No look of its own: theme, fonts and colors come from the person's settings.

## How it behaves

Agent statuses look as in Herdr everywhere: `working` a spinner, `blocked` a red
"Needs you" pill, `done` a dot, `idle` a ring.

**Agents list.** The sort button at its top right opens a menu: **Selected workspace**
(the default), Priority, Grouped by space. The pick is kept in shared
`clicker-agents.sort`. Selected workspace lists only the shown space's agents, under one
header with the space's name; with none it says "No agents in <space>.". Switching spaces
switches the list. Everything else is the shipped list: pins, sub-agent trees, folding,
times since the last change, `agent.next` / `agent.prev` order.

**Spaces list.** Resting the pointer 300 ms on a space that has agents opens a card to
the right of its row (in the folded rail, clear of the rail). It lists that space's
agents: program icon, a label (the tab's name if someone named it, else the agent's own
title, else the program), and the status mark. Clicking one focuses its pane (switching
space and tab). The card closes 250 ms after the pointer leaves both row and card, so the
pointer can cross the gap. Spaces without agents get no card. Past 320 px the list scrolls.

**Files panel.**
- *Worktrees.* In a git repo the header shows a select with the shown worktree's branch.
  It lists "Follow focused pane" and every worktree of the focused pane's repo
  (`git worktree list`, on that pane's machine): branch, path, "main checkout", and how
  many agents work in it. Following, the root is the top of the worktree the focused
  pane's live folder is in (the deepest one: a worktree can sit inside the main checkout).
  A picked worktree shows a pin and holds until focus moves to another pane or that pane
  moves to another worktree. The shown worktree is published as shared
  `clicker-files.worktree` (`{ space, on, root, picked }`).
- *Preview.* Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdx`) and Mermaid
  (`.mmd`, `.mermaid`) files always show rendered in the panel. An expand button at the
  header's right end opens the file in a dialog (82% × 86% of the window; Esc or × closes
  it) with **Preview | Markdown** (Source for Mermaid) tabs; the pick is remembered. The
  preview renders the Markdown, draws every
  ```` ```mermaid ```` / `~~~mermaid` block (any indent, also inside lists) as a diagram,
  and shows lines holding only images (`![a](src)`, `[![a](src)](href)`, `<img>` in plain
  wrappers, with its `width`) as image rows. Web images are not fetched: a link chip
  opens them in the browser. Links to other files of the worktree open in the panel;
  `http(s)` and `mailto` links open outside. Diagram types it can't draw show why, then
  their source. The open file re-reads when it is saved (and every 10 s).
- *Image files.* PNG, JPEG, GIF, WebP, BMP, ICO and TIFF show as the picture, and so does
  SVG; the expand button opens them in the larger view too, where an SVG also has
  **Preview | Source** tabs. The picture is centered and fitted to the panel (or the view),
  never enlarged; when it doesn't fit, a click shows it at its own size (scrolling) and
  another click fits it again. A bar below gives its size in pixels, format, file size and
  scale. A local image shows its new version a moment after it is saved; on another
  machine, open it again.
- *Reference to an agent.* Selecting lines in a source view (a code file, or the larger
  view's Markdown tab) and letting go of the mouse shows a floating button beside the pointer,
  such as **L10-20 → Claude Code**, when the focused pane runs an agent on the file's machine.
  A new press, a scroll, a tab switch or a reload of the file takes it away. Clicking it puts
  a reference to those lines into that agent's input without sending it. Claude Code gets
  `@path#L10-20`, which it reads as a file reference with a line range; other agents (Codex,
  pi, …) get `path:10-20` and read the file themselves. The path is relative to the agent's
  folder when the file is inside it. Herdr can't type into a terminal without Enter, so the
  button pastes: the reference goes on the clipboard, the agent's pane takes focus,
  `terminal.paste` puts it in, and after 400 ms the clipboard gets its text back (non-text
  contents are not kept). The larger view closes after it.
- *HTML.* `.html`, `.htm` and `.xhtml` files show their source, with a browser button at the
  header's right end. A file on this computer opens where it is, so the CSS, scripts and
  images it links load too. A file on another machine is copied into
  `mods/clicker-files-cache/` and the copy opens: files it links by relative path are not
  copied, so a page that needs them shows without them.

## Built from

- Layout `layouts/clicker.json`: root `row` (`titlebar: none`, traffic lights at 12,16,
  `canvas` background, 1 px `border` dividers) → `sidebar` column [`brand`, `sidebar-lists`
  column [`spaces`, `agents`], `sidebar-footer`] + `work` column [`tabs`, `work-body` row
  [`main` (`{ "tab": "active", "pane": … }`), `panel` column [`panel-body` stack
  [`files`, `changes`]]], `status`]. Node ids are the shipped `main` layout's, which the
  shipped mods look up (`sidebar`, `panel`, `panel-body`).
- `clicker-agents`, `clicker-spaces`, `clicker-files`: copies of the shipped `agents`,
  `spaces`, `files` mods with the changes above (each says so at its top). Shipped mods
  used as they are: `workspace-chrome` (also for icons), `tabs`, `pane`, `changes`,
  `workspace-status`.
- `herdr`: `agents`, `spaces`, `panes`, `focused`, `terminals`, `theme`, `settings`,
  `shared`/`setShared`, `setAgentOrder`, `layout`, `window`, `run` (`pane.focus`,
  `layout.resize`, `terminal.pin`, …), `exec`, `readTextFile`, `watchFolder`,
  `openOverlay`/`closeOverlay`, `appHome`, `home`, `checking`. `gpui-base`: `HoverCard`
  (the space card), `Popover` (the worktree select), `TextView` (Markdown), `Editor`
  (source). `fs/promises` for the cache.
- Programs: `git` (`rev-parse`, `worktree list --porcelain -z`, `status`), `sh` (folder
  listing, as shipped), `find` (when the panel starts, removes cache files not written for
  30 days), `base64` (images on
  another machine, up to 512 KB), `open` / `xdg-open` (`mailto` links).
- Diagrams: `mods/clicker-files/vendor/beautiful-mermaid.js`, beautiful-mermaid 1.1.3 with
  elkjs and entities bundled into one ES module by bun and patched for the mod runtime
  (the patches are listed at its top). `mermaid.js` loads it on the first diagram (about a
  second), renders SVG with the theme's background and foreground, and turns its CSS
  variables and `color-mix()` into plain colors. Drawings and copied images go to
  `mods/clicker-files-cache/`, a folder of its own made on first use. A drawing is named by
  its source and colors; an image by its machine and path, so a new version is written over
  the old copy. `media.js` reads image sizes from their headers.

## Watch out

- The mod runtime is not a browser: built-in prototypes are frozen (assigning `toString`
  throws), `window` exists but is not a window, and `setTimeout` throws. Stock
  beautiful-mermaid/elkjs fail on all three; the bundle's header says how it works around
  them.
- Async work started while drawing (`cx.spawn` in `render`, then `fs`, `exec`, a sleep or
  an import) never came back here. Diagrams and images are made by the task that reads the
  open file; drawing only reads what it made and flags what is missing for the next read.
- `image()` keeps a picture it loaded by its path, for the whole app. Saving over that file
  makes the app read it again only under `mods/`, and not in a hidden folder there; saving
  into the showing mod's own folder reloads that mod (its state is lost). So the cache is a
  separate, non-hidden folder under `mods/`.
- The mod runtime's JS is slow (a loop over bytes took 0.45 s per MB), so images are not
  named by a hash of their bytes.
- `image()` loads only files under the app folder (so images are copied into the cache),
  loads them lazily on first draw, and doesn't redraw the panel when ready: the first time
  a path is drawn, a timer set up in `init` redraws for 2 s.
- The SVG renderer draws `<text>` (Korean included) but not `foreignObject`, which stock
  Mermaid uses for labels.
- `HoverCard` content draws over the rest of the window, outside the sidebar block.
- While the window is idle or covered it may draw no frames, so screenshots can show stale
  states.
- Limits: diagram types are flowchart, state, sequence, class, ER and xychart (no pie,
  gantt, …); an image inside a line of text is not shown; a diagram inside a list splits
  the list in two; the preview renders the first 200,000 characters; another machine's
  images over 512 KB are not shown, nor local ones over 50 MB; HEIC and AVIF are not drawn.
