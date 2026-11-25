# herdr-clicker

Clicker is a layout for the [Herdr](https://github.com/herdrdev/herdr-app) desktop app. It
keeps the arrangement of Herdr's own `main` layout: spaces and agents on the left, your panes
in the middle, a hidden Files and Changes panel on the right. It changes three parts of it:

- **Agents list.** By default it shows only the agents of the space you are in. (Herdr calls
  a workspace a "space".) The sort menu still offers Herdr's own views.
- **Spaces list.** Each space row ends with up to 5 marks, one for each agent there that has
  news: a red `!` for an agent that waits on you, a blue dot for one that finished while you
  weren't looking, and a spinner for one that is working. Rest the pointer on a space to see a
  card of its agents. Click an agent in the card to go to it.
- **Files panel.**
  - Worktrees: by default the panel shows the git worktree of the pane you are in. A menu lets
    you pick another worktree of the same repository.
  - Previews: Markdown files show rendered, with their Mermaid diagrams drawn and their images
    shown. Mermaid files show as the diagram. Image files show as the picture.
  - References: select lines in a file, and a button puts a reference to those lines into the
    input of the agent in the focused pane.
  - HTML files: a button opens the file in your web browser.

See [RECIPE.md](RECIPE.md) for what it looks like, how it behaves and how it is built.

## Herdr version

Clicker's three mods are copies of Herdr's shipped `agents`, `spaces` and `files` mods, with
the changes above. They match Herdr 0.1.18. The `cloned_from` field in each `mod.json` gives
the version. When a new Herdr version changes its shipped mods, make the same changes to
these copies by hand.

## Install

Copy the layout and its mods into Herdr's folder, then switch to the layout:

```sh
cp layouts/clicker.json ~/.config/herdr-app/layouts/
cp -R mods/clicker-agents mods/clicker-spaces mods/clicker-files ~/.config/herdr-app/mods/
herdr-app do layout.switch '{"name":"clicker"}'
```

To update, pull this repository and run the same `cp` commands. Herdr reloads a mod as soon
as its files change. The Clicker panels then start again from the beginning: for example, the
Files panel closes the file it showed.

Herdr's `ctrl-shift-l` key moves to your next layout, so it also takes you away from Clicker.

To remove Clicker, delete the files that the `cp` commands copied. Also delete
`~/.config/herdr-app/mods/clicker-files-cache/`. The Files panel keeps its drawn diagrams and
copied images there.

## Programs the mods run

- `git`: to list the worktrees of a repository and to read its changed files (`git status`).
  The Files panel and Herdr's Changes panel use the same `git status` result. Neither panel
  runs `git status` while the Herdr window is in the background.
- `sh`: to list the files in a folder.
- `find`: to delete cache files that were not used for 30 days.
- `base64`: to copy images from another machine. Herdr can show panes that run on another
  computer through SSH; an image there comes over as base64 text.

Opening a Markdown file never uses the network. An image on the web shows as a link that
opens in your browser.

## License

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). The mods are modified from
Herdr's shipped mods; the bundled diagram renderer has its own licenses in
`mods/clicker-files/vendor/LICENSES.md`.
