# Keyboard Shortcuts

Every binding, and how to change them. `Ctrl` also accepts `Cmd` on macOS.

Press `Ctrl+?` in the app for the same list in a floating overlay.

## Sessions and tabs

| Shortcut                        | Action                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| `Ctrl+K` (also `Cmd+K`, `Alt+K`)| Find an open session or start a new one.                         |
| `Ctrl+Tab`                      | Next session.                                                    |
| `Alt+[` / `Alt+]`               | Previous / next tab.                                             |
| `Alt+1` to `Alt+9`              | Switch to tab N. Physical keys, so macOS Option layouts work.    |
| `Ctrl+Shift+{` / `Ctrl+Shift+}` | Move the active tab left / right.                                |
| `Alt+B`                         | Collapse / expand the session sidebar, when that layout is on.    |

`Ctrl+W` is not a Codeman shortcut: it goes to the terminal, where shells and agent CLIs
use it to delete the previous word. **Close Session** has no key by default; close a session
from its tab, or bind a key to it in App Settings → Shortcuts.

## Terminal

| Shortcut                | Action                                                          |
| ----------------------- | --------------------------------------------------------------- |
| `Enter`                 | Send.                                                            |
| `Shift+Enter`           | Insert a newline without sending.                                |
| `Ctrl+Enter`            | Same.                                                            |
| `Ctrl+C`                | Copy the selection, or interrupt when nothing is selected.       |
| `Ctrl+Shift+C`          | Copy the selection. Never interrupts.                            |
| `Ctrl+V`                | Paste. An image on the clipboard uploads and pastes its file path instead. |
| `Ctrl+L`                | Clear the terminal.                                              |
| `Ctrl+Shift+R`          | Restore terminal size.                                           |
| `Ctrl` `+` / `Ctrl` `-` | Font size.                                                       |
| `Shift+Wheel`           | Scroll the local buffer, even where the wheel is forwarded to the CLI. |
| `Shift+drag`            | Start a selection in a pane whose mouse events go to the CLI.    |
| Right-click             | Copy the selection. With nothing selected the native menu is left alone. |
| `Ctrl+Z`                | Swallowed in agent sessions so a running CLI cannot be suspended. Normal job control in a shell. |

Anything you copy is cleaned on the way to the clipboard: each line loses the padding spaces a full-screen program paints across the rest of the row. Leading indentation is left exactly as it is, so indented code, a `git log` message body and `git diff` context lines paste back the way they looked on screen. An `Alt+drag` rectangular selection is copied exactly as it looks, so its columns stay lined up.

## Tile grid

| Shortcut                    | Action                                                       |
| --------------------------- | ------------------------------------------------------------ |
| `Ctrl+Shift+G`              | Open or close the tile grid (needs the Tiles setting on).     |
| `Alt+Shift+Arrows`          | Focus the tile to the left, right, above or below.            |
| `Alt+Shift+Enter`           | Zoom the focused tile, or restore the grid.                   |
| `Ctrl`+click / `Cmd`+click a tab | Add that session to the grid.                            |

While the grid is open, `Ctrl+Tab` and `Alt+[` / `Alt+]` cycle through the tiles, and the
terminal shortcuts above act on the focused tile. **Remove Focused Tile** has no key by
default. See [Tile Grid](Tile-Grid).

## Everything else

| Shortcut       | Action                          |
| -------------- | ------------------------------- |
| `Ctrl+Shift+V` | Toggle voice input.              |
| `Ctrl+?`       | Shortcut reference overlay.      |
| `Escape`       | Close panels and modals.         |

## Rebinding

**App Settings → Shortcuts.** Bindings live in a registry with per-user overrides, so a
rebind is stored as an override on top of the default rather than replacing the table.

Two things are deliberately not rebindable:

- **`Ctrl+C` smart copy.** The generic dispatch loop calls `preventDefault()` on every
  shortcut it handles, and doing that to `Ctrl+C` would swallow the interrupt when nothing
  is selected. It is handled separately for that reason.
- **`Escape`**, which closes whatever is open.

## Why some chords behave oddly

The terminal sees keystrokes before the app does. Any chord the app claims has to also be
swallowed at the terminal layer, or xterm writes the control byte into the session as well
as triggering the action. If you rebind something to a chord the terminal cares about
(`Ctrl+D`, say), expect the CLI to see it too.

`Alt+1` through `Alt+9` are matched on **physical key position** rather than the character
produced, so macOS Option layouts that produce `¡™£` still switch tabs.

## On phones

There is no physical keyboard, so the equivalents live in the keyboard accessory bar: `Esc`,
`Ctrl` as a one-shot modifier, `Tab`, arrows, and quick actions. See
[Mobile Guide](Mobile-Guide).

## Read next

- [The Dashboard](The-Dashboard) - what the shortcuts are navigating.
- [Settings Reference](Settings-Reference) - where the overrides are stored.
