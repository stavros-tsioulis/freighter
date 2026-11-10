# File explorer

**Servers → a server → Files** shows every file on that server, as root, from the dashboard. Admins only; see [the security model](/operate/security#the-file-explorer).

## Moving around

Folders open with a double-click (or **Enter**). The path above the list is clickable; click its last part, the pencil, or double-click it to type a path (`..`, `~` and relative paths work). **Backspace** goes up a folder. The chips under it jump to `/srv/apps`, `/etc/freighter`, `/var/log`, `/tmp` and the like. Symbolic links show where they point and open if they lead to a folder. Click a column heading to sort; folders always come first. **Filter** narrows the folder you are in.

## Several at once

Click to select, **Ctrl/⌘-click** to add, **Shift-click** for a range, **Ctrl/⌘+A** for all, or tick the boxes. Then:

| | |
| --- | --- |
| **Download** | a file as it is; a folder or several items as a zip, built while it streams (no temporary file, any size) |
| **Copy**, **Cut**, **Paste** | **Ctrl/⌘+C, X, V** or the buttons. The clipboard follows you between folders. Pasting where a name is taken stops and asks: **Replace** or **Keep both** (the copy is named `name copy`). Copying into the same folder keeps both without asking |
| **Rename** | **F2** |
| **Delete** | **Delete**, after a confirmation. Folders go with everything in them |
| **New folder** | |

Right-click gives the same actions on the selection. Each item is handled on its own: if some fail (no permission, name taken), the rest still happen and you get a list of what didn't.

## Upload

**Upload** picks files, **Upload a folder** a whole folder, or drag files and folders onto the list. They go one request each, three at a time, with progress and a cancel button; a file appears only when it has arrived in full. Names already in the folder ask before being replaced. New files and folders belong to the owner of the folder they land in.

## Good to know

- Moving and copying keep owners, permissions and timestamps (`cp -a`), so copying `/srv/apps/shop/shared` keeps it usable by the app.
- It will not delete or move `/`, `/etc`, `/usr` and the other top-level system folders, or a folder with a [remote volume](/deploy/volumes) mounted inside.
- Zips skip symbolic links and anything unreadable, and say so in a `_NOT_INCLUDED.txt` inside. Entries over 4 GiB use ZIP64; some older tools can't open those.
- A folder lists up to 10,000 entries.
- Turn it off, or make it read-only, per server with `agent.files` in [config.yaml](/reference/config-yaml).
