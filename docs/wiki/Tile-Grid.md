# Tile Grid

Watch and drive up to six sessions at once, side by side in one window. Each tile is a
full live terminal: it reads, it takes your keystrokes, and it shows at a glance whether
its agent is working, idle, or waiting on you.

The grid is a desktop feature. It needs a window at least about 1180px wide, and it is
never offered in a popped-out session window.

## Turning it on

**App Settings → Header & Panels → Tiles.** This is a per-device setting, on by default
on desktops and laptops and off on phones and tablets, and the button only appears in a
window at least 1180px wide.
It shows a **Tiles** button in the header, beside Split, and enables `Ctrl+Shift+G`.

## Opening a grid

- **Tiles button**: one click shows the tiles straight away. If you have used the grid in
  this browser before, you get it back exactly as you left it: the same sessions in the
  same places, an empty place where you left one, the same number of tiles, your column
  widths and row heights, the tile you were in, and a zoomed tile still zoomed. A session
  closed since frees its place, which is filled the way a new grid is filled (below).
  Otherwise, or when none of those sessions is left, you get as many tiles as you last
  chose (six until you choose; fewer if the window is too small or you have fewer sessions
  open): an open split's two first; otherwise the sessions that are working (the most
  recently started first), then the ones waiting on you (red and yellow tabs), then the
  rest, the most recently used first, so the oldest are the ones left out. The session you
  are on always comes along and is focused. With the grid open, the same button closes it.
- **Rest the pointer on the Tiles button** (or tab to it) for a short card that shows the
  count you chose and what a click and a right-click do.
- **Right-click the Tiles button** (or press `Shift+F10` on it) to choose how many tiles:
  **2**, **4** or **6**, each drawn as its layout. Your choice is remembered in this
  browser. Picking a count opens the grid with that many tiles (the grid you left, its
  tiles in their places, new ones in the empty places first), and it is what a click opens
  when there is no grid to bring back. With the grid open, picking a count re-forms it: the
  tile you are in always stays, extra tiles leave from the end, new ones join working ones
  first, then the ones waiting on you, then the most recent. A count the window is too
  small for is greyed out, with the reason.
- **`Ctrl+Shift+G`**: exactly what a click on the Tiles button does.
- **`Ctrl`+click (or `Cmd`+click) a tab**: adds that session to the grid and focuses it. With
  the grid closed it opens what the Tiles button would show with that session added: in the
  empty place while the grid has fewer tiles than the count you chose, else in place of the
  last tile (never more than the count). On macOS use
  `Cmd`: `Ctrl`+click there opens the tab's rename instead.
- **Drag a tab onto a tile** to replace that tile with it (the replaced session keeps
  running), or onto an empty slot to add it. Dragging a session that is already tiled onto
  another tile swaps the two.
- **"Open group as tiles"** in a tab group's menu, in the vertical tab rail with groups.
- **Run**: a session you start from this browser tab's Run button while the grid is open
  joins it. Sessions started elsewhere (an agent, another device, a cron job) do not.

The layout follows the tile count: 1x1, 2x1, three side by side on a wide screen (else a
2x2 with one empty slot), 2x2, 3x2. The grid holds at most six tiles, fewer when the
window is too small for six; the count menu says which limit applies.

Opening, the tiles fade in one after another and each terminal appears once its history
has loaded, rather than scrolling through it. Closing with the button, the tiles stay
on screen, dimmed, until the single session behind them has loaded, then fade away. With
reduced motion turned on in your system settings, the grid opens and closes at once.

## A tile

Each tile has a small header: `● [logo] name · model ......... ⋯ ⤢ ×`

| Part   | What it does                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------ |
| `●`    | The session's state: working, idle, waiting on you, needs you (red, and the tile's border pulses), error, ended. Hover the header for how long. |
| logo   | Which agent runs in the tile (Claude Code, Codex, DeepSeek, Shell, ...). Hover it for the agent and the model by name. |
| name   | Double-click to rename the session.                                                              |
| model  | The model the session runs, when Codeman knows it: what the agent itself reports (it follows a `/model` switch), else the model its own config pins (DeepSeek's route, shown "from config"), else the model it was started with. Nothing when unknown. OpenCode shows the model and its provider together (`Big Pickle OpenCode Zen`), exactly as its own composer does. |
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
places. Drop it on an empty slot and it moves there, leaving its old place empty; nothing else
moves, so the empty slot can be anywhere in the grid. The dropped tile takes the focus. Press
`Escape` or let go anywhere else and nothing changes, not even which tile has the focus: a
header focuses its tile when you click it, not when you press it.

With the keyboard, `Ctrl+Shift+Arrows` moves the focused tile one place left, right, up or
down: into the empty slot if that is the place, else trading places with the tile there. It
keeps the focus.

A moved tile takes the size of the place it lands in: column widths and row heights stay
where you dragged the dividers. Tiles do not move while one is zoomed. Where everything is,
the empty slot included, is saved with the grid and comes back when you turn the grid off
and on, and on a page reload while the grid is open.

Closing a tile leaves its place empty when the grid keeps its shape (six tiles to five), and a
new tile takes the first empty place. When the number of tiles changes the grid's shape (four
tiles to five is two columns to three), the tiles keep their places if they still fit, or line
up again from the top left. `Alt+Shift+Arrows` and `Ctrl+Tab` never stop on an empty slot.

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

The grid is saved in this browser every time you change it (moving, resizing, adding or
removing a tile, changing the count, focusing or zooming a tile), and never sent to the
server. However you leave it (the Tiles button, another tab, Home, a link, closing its last
tile or session), the Tiles button brings it back as it was. A page reload brings it back
when the grid was open; after you left it, a reload shows the single view and the Tiles
button still brings the grid back. A session that was closed or popped out into its own
window in the meantime frees its place for another one, picked the way a new grid picks
them; the place stays empty only when no other session is left. Right after a page reload
the page does not know yet which sessions are waiting for your answer, so that pick goes by
which sessions are working and which you used last. If the window has become too small for
all the tiles, the tile you were in fills the grid until the window is wide enough again,
and the rest of the layout is kept.

Split shows the same logo, name and model above both of its panes.

The grid and Split are never open together: opening the grid turns an open split into two
tiles, and Split is unavailable while the grid is open.

## Read next

- [The Dashboard](The-Dashboard) - the single view, tabs and the header.
- [Keyboard Shortcuts](Keyboard-Shortcuts) - every binding.
- [Settings Reference](Settings-Reference) - where the Tiles setting lives.
