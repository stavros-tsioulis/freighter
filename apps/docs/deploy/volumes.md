# Volumes

A volume is a folder that belongs to one app and survives releases. It lives in `/srv/apps/<app>/shared/volumes/<name>` on the app's server. A service attaches it under `volumes:` and sees it at the path it asks for:

```yaml
services:
  web:
    command: node server.js
    volumes:
      uploads: /data/uploads
    environment:
      UPLOAD_DIR: "@volume:uploads.path"     # /data/uploads
  worker:
    image: ghcr.io/acme/worker:1
    volumes:
      uploads: /var/uploads                  # the same folder, inside the container
```

- **Command services** get the folder bound at that path and may write to it. The path can't be under a system directory (`/etc`, `/usr`, `/proc`, `/srv/apps` and the like).
- **Images** get it as a container volume, as before.
- Several services of an app can attach the same volume. Names are lowercase with single hyphens; `shared` is taken. In the dashboard, the volume name field suggests the app's remote folders and the volumes other services already use, so sharing one is a pick from the list.
- The folders are owned by the app's user and are removed with the app.

## Paths in environment values

Type `@` in an environment value and the dashboard lists `volume:shared` and the app's volumes, then `path`.

| Reference | Value |
| --- | --- |
| `@volume:name.path` | where the service that holds the reference sees the volume |
| `@volume:shared.path` | the app's shared directory, `/srv/apps/<app>/shared` (command services only: containers don't see it) |

A command service that doesn't attach a volume still sees the app's folder at its place on the server; an image only sees what it attaches.

## Remote volumes

A volume declared under the app's `volumes:` is a folder on another machine, mounted onto the same place:

```yaml
volumes:
  media:
    type: smb
    host: nas.lan
    share: media
    path: uploads        # a folder inside the share (optional)
    user: svc
    domain: WORKGROUP    # optional
  archive:
    type: nfs
    host: 10.0.0.5
    export: /exports/archive
    version: "4.1"       # 3, 4, 4.1 or 4.2 (default 4)
```

Attach them like any volume (`volumes: { media: /data/media }`). The mount is a systemd mount unit; a service that uses it starts after the mount and stops with it.

- **SMB passwords** are never in the file. Set one on the app's **Settings** tab, in *Remote volumes*; it is written to a root-only file on the server and can't be read back. A deploy fails until it is set.
- **Ownership:** SMB files appear owned by the app's user (`uid`/`gid`, mode `0660` for files and `0770` for folders). NFS permissions come from the NFS server.
- **Mounts are soft:** when the other machine is unreachable, reads and writes fail with an error instead of hanging for ever. Services that need the share should have a health check.
- **A failed mount fails the deploy**, with the journal of the mount unit. The volume's state is shown on the Settings tab.
- Deleting an app unmounts its volumes first and never deletes anything on the remote side.
- Two releases run side by side during a switch, so they briefly share a volume. Don't keep a SQLite database on a network share.

### Install the tools

A server needs `cifs-utils` (SMB) and `nfs-common` (NFS). The server's page in the dashboard shows whether they are there; **Add mount support…** installs them and restarts the agent, as for containers and storage. On the machine the dashboard runs on, re-run the installer with `--with-mounts`:

```sh
curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh -s -- --with-agent --with-mounts
```

## API

| Endpoint | |
| --- | --- |
| `GET /apps/:app/volumes` | the remote volumes: `type`, `state` (`mounted`, …) and whether an SMB password is set | 
| `PUT /apps/:app/volumes/:name/password` | `{"password": "…"}`, admin. Never stored by the API or logged |
