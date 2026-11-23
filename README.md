# herdr-clicker

A layout for the [Herdr](https://github.com/herdrdev/herdr-app) desktop app, built on its
default window:

- **Agents** list shows only the selected workspace's agents by default.
- Resting the pointer on a **space** shows a card of its agents; click one to go to it.
- **Files** panel picks git worktrees (and follows the focused pane into them), and
  previews Markdown and Mermaid files with diagrams and images.

See [RECIPE.md](RECIPE.md) for what it looks like, how it behaves and how it is built.

## Install

Copy the layout and its mods into Herdr's folder, then switch to it:

```sh
cp layouts/clicker.json ~/.config/herdr-app/layouts/
cp -R mods/clicker-agents mods/clicker-spaces mods/clicker-files ~/.config/herdr-app/mods/
herdr-app do layout.switch '{"name":"clicker"}'
```

`ctrl-shift-l` switches back to your previous layout; deleting the files removes it.

The mods run `git` (worktrees, status), `sh`, `find` (cache cleanup) and `base64`
(images on another machine). Opening a Markdown file never reaches the network: web
images show as links.

## License

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). The mods are modified from
Herdr's shipped mods; the bundled diagram renderer has its own licenses in
`mods/clicker-files/vendor/LICENSES.md`.
