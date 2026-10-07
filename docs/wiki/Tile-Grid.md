# Tile Grid

Watch and drive up to six sessions at once, side by side in one window. Each tile is a
full live terminal: it reads, it takes your keystrokes, and it shows at a glance whether
its agent is working, idle, or waiting on you.

The grid is a desktop feature. It needs a window at least about 1180px wide, and it is
never offered in a popped-out session window.

## Turning it on

**App Settings → Header & Panels → Tiles.** This is a per-device setting, off by default,
so turning it on at your desk never puts the button on your phone. It shows a **Tiles**
button in the header, beside Split, and enables `Ctrl+Shift+G`.

## Opening a grid

- **Tiles button**: one click shows the tiles straight away. You get the grid you last
  had; if there is none, an open split as two tiles; otherwise your open sessions in tab
  order, up to six (fewer if the window is too small), with the session you are on
  focused. With the grid open, the same button closes it.
- **Right-click the Tiles button** to choose which sessions: a checkbox per open session in
  tab order, starting with the tiles you have (or had), greying out the rest once the grid
  is full. **Open tiles** shows them, replacing what the grid showed.
- **`Ctrl+Shift+G`**: exactly what a click on the Tiles button does.
- **`Ctrl`+click (or `Cmd`+click) a tab**: adds that session to the grid and focuses it. With
  the grid closed it opens what the Tiles button would show, plus that session. On macOS use
  `Cmd`: `Ctrl`+click there opens the tab's rename instead.
- **Drag a tab onto a tile** to replace that tile with it (the replaced session keeps
  running), or onto an empty slot to add it. Dragging a session that is already tiled onto
  another tile swaps the two.
- **"Open group as tiles"** in a tab group's menu, in the vertical tab rail with groups.
- **Run**: a session you start from this browser tab's Run button while the grid is open
  joins it. Sessions started elsewhere (an agent, another device, a cron job) do not.

The layout follows the tile count: 1x1, 2x1, three side by side on a wide screen (else a
2x2 with one empty slot), 2x2, 3x2. The grid holds at most six tiles, fewer when the
window is too small for six; the picker says which limit applies.

## A tile

Each tile has a small header: `● [logo] name · model ......... ⋯ ⤢ ×`

| Part   | What it does                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------ |
| `●`    | The session's state: working, idle, waiting on you, needs you (red, and the tile's border pulses), error, ended. Hover the header for how long. |
| logo   | Which agent runs in the tile (Claude Code, Codex, DeepSeek, Shell, ...). Hover it for the agent and the model by name. |
| name   | Double-click to rename the session.                                                              |
| model  | The model the session runs, when Codeman knows it: what the agent itself reports (it follows a `/model` switch), else the model its own config pins (DeepSeek's route, shown "from config"), else the model it was started with. Nothing when unknown. |
| `⋯`    | The session menu: options, open in a new window, close the session.                              |
| `⤢`    | Zoom: the tile fills the grid; press it again (or `Alt+Shift+Enter`) to get the grid back.        |
| `×`    | Remove the tile. The session keeps running; close it from `⋯` if you want it gone.                |

Click a tile to focus it. The focused tile has the accent border, takes your keyboard, and
is the session every panel follows: files, git status, respawn and Ralph, subagent windows,
voice and image paste. Tabs of tiled sessions carry a small underline.

Drag the thin lines between tiles to resize columns and rows. A tile never gets smaller than
about 60 columns; when the window is too small for all the tiles, the grid shows the focused
one on its own until the window is big enough again.

A tile whose session is not running shows **Not attached** with an **Attach** button. A tile
whose agent exited inside its pane says so instead; close that session from `⋯`.

## Moving tiles

Drag a tile by its header (anywhere but its buttons) onto another tile and the two trade
places; the dropped tile takes the focus. Empty slots are for adding sessions (drop a tab
there), so a tile cannot be dropped on one. Press `Escape` or let go anywhere else and nothing
changes, not even which tile has the focus: a header focuses its tile when you click it, not
when you press it.

With the keyboard, `Ctrl+Shift+Arrows` moves the focused tile left, right, up or down: it
trades places with the tile next to it (the one `Alt+Shift+Arrows` would focus) and keeps the
focus.

A moved tile takes the size of the place it lands in: column widths and row heights stay
where you dragged the dividers. Tiles do not move while one is zoomed. The new order is
saved with the grid.

## Keys

| Shortcut                 | Action                                                     |
| ------------------------ | ---------------------------------------------------------- |
| `Ctrl+Shift+G`           | Open or close the grid.                                     |
| `Alt+Shift+Arrows`       | Focus the tile to the left, right, above or below.          |
| `Ctrl+Shift+Arrows`      | Move the focused tile left, right, up or down.              |
| `Alt+Shift+Enter`        | Zoom the focused tile, or restore the grid.                 |
| `Ctrl+Tab`, `Alt+[` `]`  | Cycle through the tiles.                                    |
| `Ctrl+L`                 | Clear the focused tile.                                     |
| `Ctrl` `+` / `Ctrl` `-`  | Tile font size (tiles have their own, smaller font).        |

All of them can be rebound in App Settings → Shortcuts, where **Remove Focused Tile** can
also get a key. Outside the grid, `Alt+Shift+Arrows`, `Ctrl+Shift+Arrows` and
`Alt+Shift+Enter` go to the terminal as usual. While it is open, `Alt+Shift+Arrows` and
`Ctrl+Shift+Arrows` in a text field (renaming a tile, the file editor) still select text there;
inside a tile they focus and move tiles, so a terminal editor there (nano, micro, emacs) does
not get them. With the Tiles setting off, `Ctrl+Shift+G` does nothing.

## Leaving the grid

Clicking the tab of a session that is not tiled (or picking it with `Alt+1-9` or the
session finder) shows that session on its own, the normal single view. The grid is
remembered: the Tiles button or `Ctrl+Shift+G` brings it straight back. Going Home does the
same. Narrowing the window below the desktop width also returns to the single view.

The grid is saved on this device and comes back when you reload the page, with its focus,
zoom and column widths. A session that was closed in the meantime is simply left out.

Split shows the same logo, name and model above both of its panes.

The grid and Split are never open together: opening the grid turns an open split into two
tiles, and Split is unavailable while the grid is open.

## Read next

- [The Dashboard](The-Dashboard) - the single view, tabs and the header.
- [Keyboard Shortcuts](Keyboard-Shortcuts) - every binding.
- [Settings Reference](Settings-Reference) - where the Tiles setting lives.
