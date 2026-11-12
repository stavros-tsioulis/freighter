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
| **Extract** | shown when everything selected is an archive. Each one is unpacked into a folder named after it, beside it: `site.tar.gz` becomes `site/`. If that name is taken the folder is called `site copy`. See below |
| **Rename** | **F2** |
| **Delete** | **Delete**, after a confirmation. Folders go with everything in them |
| **New folder** | |

Right-click gives the same actions on the selection. Each item is handled on its own: if some fail (no permission, name taken), the rest still happen and you get a list of what didn't.

## Extract

By file extension: `.zip`, `.tar`, `.tar.gz` / `.tgz`, `.tar.bz2`, `.tar.xz`, `.tar.zst`, `.7z`, `.rar`, and single files compressed with `.gz`, `.bz2` or `.xz` (these give a folder holding the one file). What comes out belongs to the owner of the folder it lands in, not to whoever packed it.

tar needs nothing extra. zip needs `unzip` (or 7z), and 7z and rar need 7z. The server's **Features** tab shows what is installed; **Add archive support…** installs 7z, unzip, bzip2 and zstd and restarts the agent, as for containers. On the machine the dashboard runs on, re-run its installer with `--with-archives`:

```sh
curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh -s -- --with-agent --with-archives
```

An archive that can't be unpacked leaves nothing behind. Paths that climb out of the folder (`../`) are refused or stripped by the tools.

## Upload

**Upload** picks files, **Upload a folder** a whole folder, or drag files and folders onto the list. They go one request each, three at a time, with progress and a cancel button; a file appears only when it has arrived in full. Names already in the folder ask before being replaced. New files and folders belong to the owner of the folder they land in.

## Good to know

- Moving and copying keep owners, permissions and timestamps (`cp -a`), so copying `/srv/apps/shop/shared` keeps it usable by the app.
- It will not delete or move `/`, `/etc`, `/usr` and the other top-level system folders, or a folder with a [remote volume](/deploy/volumes) mounted inside.
- Zips skip symbolic links and anything unreadable, and say so in a `_NOT_INCLUDED.txt` inside. Entries over 4 GiB use ZIP64; some older tools can't open those.
- A folder lists up to 10,000 entries.
- Turn it off, or make it read-only, per server with `agent.files` in [config.yaml](/reference/config-yaml).
