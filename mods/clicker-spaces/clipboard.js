// Clipboard sync: text that something on another machine copies there comes to this
// computer's clipboard too.
//
// A program in a terminal on another machine doesn't know it is far away: Herdr's terminals
// there carry no SSH_CONNECTION. So it copies with that machine's own tool (pbcopy, xclip,
// or the system's API directly), and the text stays there. Herdr does pass OSC 52 from those
// terminals to this clipboard, but only some programs send it.
//
// So this reads the clipboard of the machine the focused pane is on, every second, and
// copies a new text here. Only changes it sees happen are copied: the first read, and the
// first one after focus moves to another machine or after a pause, only note what is there.
// It reads while the window is in front, and for 15 s after it goes to the back (copy, then
// switch to another app and paste). One way only: nothing goes from here to that machine.
import { spaces, focused, exec, window, checking } from "herdr";

const EVERY = 1000;
const GRACE = 15000;
// Larger text stays on the other machine (it would come over every time it changed).
const LIMIT = 1024 * 1024;

// Run on the other machine with the checksum the caller has as $1. Prints "same", "none"
// (no text), "big <sum>", or the new checksum on a line of its own and then the text.
// macOS has pbpaste; Linux wl-paste or xclip. A desktop's DISPLAY and XAUTHORITY may be
// missing from where Herdr runs programs: then the usual ones are tried.
const SCRIPT = `f=$(mktemp) || exit 1
trap 'rm -f "$f"' EXIT
if command -v pbpaste >/dev/null 2>&1; then pbpaste > "$f" 2>/dev/null
elif command -v wl-paste >/dev/null 2>&1 && [ -n "$WAYLAND_DISPLAY" ]; then wl-paste --no-newline --type text > "$f" 2>/dev/null
elif command -v xclip >/dev/null 2>&1; then
  [ -n "$DISPLAY" ] || export DISPLAY=:0
  if [ -z "$XAUTHORITY" ]; then
    for a in /run/user/$(id -u)/.mutter-Xwaylandauth.* "$HOME/.Xauthority"; do [ -r "$a" ] && { export XAUTHORITY="$a"; break; }; done
  fi
  xclip -o -selection clipboard > "$f" 2>/dev/null
else echo none; exit 0; fi
[ -s "$f" ] || { echo none; exit 0; }
sum=$(cksum < "$f" | tr -s ' ' '-')
[ "$sum" = "$1" ] && { echo same; exit 0; }
[ "$(wc -c < "$f" | tr -d ' ')" -le ${LIMIT} ] || { echo "big $sum"; exit 0; }
echo "$sum"; cat "$f"`;

// The panels share one VM: of several copies of this mod, one reads at a time.
const lease = globalThis[Symbol.for("clicker.clipboardSync")] ??= { owner: null, at: 0 };

// The machine of the focused pane; null for this computer.
function focusedMachine() {
  const space = spaces().find(s => s.active), f = focused();
  if (f?.pane === null) return f.terminal?.includes("/") ? f.terminal.split("/")[0] : null;
  return space?.machine ?? null;
}

export function startClipboardSync(cx) {
  if (checking()) return;
  const me = {};
  // `on`: the machine being read; `sum`: its clipboard's checksum at the last read, null when
  // the next read only notes what is there.
  const state = { on: undefined, sum: null, busy: false, backSince: 0 };
  cx.timer.every(EVERY, cx => {
    const now = Date.now();
    if (window()?.active !== false) state.backSince = 0;
    else if (!state.backSince) state.backSince = now;
    const on = focusedMachine();
    if (!on || (state.backSince && now - state.backSince > GRACE)) { state.on = undefined; state.sum = null; return; }
    if (on !== state.on) { state.on = on; state.sum = null; }
    if (state.busy || (lease.owner !== me && now - lease.at < 3 * EVERY)) return;
    lease.owner = me; lease.at = now;
    state.busy = true;
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", ["-c", SCRIPT, "clipboard", state.sum ?? "-"], { on, timeout: 5000 });
        if (r.code !== 0 || state.on !== on) return;
        const out = r.stdout, nl = out.indexOf("\n");
        const head = nl < 0 ? out.trim() : out.slice(0, nl);
        if (head === "same") return;
        if (head === "none") { state.sum = "none"; return; }
        if (head.startsWith("big ")) { state.sum = head.slice(4); return; }
        const first = state.sum === null;
        state.sum = head;
        if (first || nl < 0) return;
        const text = out.slice(nl + 1);
        if (cx.read_from_clipboard() !== text) cx.write_to_clipboard(text);
      } catch {} // the machine is away: try again next time
      finally { state.busy = false; }
    });
  });
}
