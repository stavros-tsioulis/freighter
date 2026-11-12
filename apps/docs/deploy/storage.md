# S3 storage

A **storage** is an S3-compatible endpoint that Freighter runs for you: files kept on the server's own disk, or an SFTP or SMB share presented as S3. Put a domain on it and any S3 client or library can use it. Apps connect to it the same way they connect to each other.

Under the hood a storage is [rclone](https://rclone.org)'s S3 server, run as a service of its own app named `storage-<name>`. That gives it everything an app has: logs, restarts, [domains with HTTPS](/deploy/domains), zero-downtime redeploys. These apps are hidden from the app lists and managed from **Storage** in the dashboard.

## Kinds

| Kind | Files live | Notes |
| --- | --- | --- |
| **Local disk** | on the server, in `/srv/apps/storage-<name>/shared/data` | created and kept by the agent; deleting the storage deletes them |
| **SFTP** | on any SSH server | password or private key. The server's host key is shown for you to trust, then pinned. |
| **SMB** | on a Windows or NAS share | host, share, user, password, optional domain |

Buckets are the top-level folders of the backend. Clients create them with the S3 API.

Each storage has one **access key** and **secret key**. The secret is shown once, when the storage is created or the key is rotated. Rotating redeploys the apps that connect to the storage, so they get the new secret.

## Create one

**Storage → New storage**, pick the kind, give it a name and (for remote kinds) the connection details. **Test connection** checks them before anything is created. Then add a domain on the storage's **Domains** tab, as for an app. Without a domain the endpoint only listens on the server itself (`http://127.0.0.1:<port>`), which suits apps on the same server.

Use **path-style** addressing, `https://s3.example.com/<bucket>/<key>`: domains are single names, so `<bucket>.s3.example.com` does not exist. Most clients have a "force path style" option. The region is `us-east-1`.

## Connect an app

```yaml
services:
  web:
    command: node server.js
    environment:
      S3_ENDPOINT: "@storage:uploads.url"
      S3_REGION: "@storage:uploads.region"
      S3_ACCESS_KEY_ID: "@storage:uploads.accessKey"
      S3_SECRET_ACCESS_KEY: "@storage:uploads.secretKey"
```

| Attribute | Value |
| --- | --- |
| `url` | `https://<domain>`, or `http://127.0.0.1:<port>` while it has no domain (same server only) |
| `domain` | the storage's domain |
| `internal` | `http://127.0.0.1:<port>`, for apps on the same server |
| `region` | `us-east-1` |
| `accessKey`, `secretKey` | the key pair |

Storages are global: any app can use any storage, whatever project it is in. The key pair is **never written into the service's unit file**; it goes in a file that only root can read (`/etc/freighter/apps/<app>/<service>.refs.env`) which the unit loads. The Variables tab shows such values as hidden. Because every deploy resolves these references, each server that runs apps keeps a root-only copy of the storages' keys.

On the project canvas a storage appears as a dashed node, with an arrow from each service that uses it.

## Browse and upload

The storage's **Files** tab (admins) is a browser for what it holds. The top level lists the buckets; open one to see its keys, with folders as the S3 prefixes.

- **Upload** files, a whole folder, or drag them in; three at a time, with progress and a cancel button. A file appears only once it has arrived in full, and a name that exists asks before it is replaced.
- **Download** a file, **rename**, **delete** (folders and buckets go with everything in them, after a confirmation), **New bucket** and **New folder**.
- **Copy S3 URI** (`s3://bucket/key`) for the selection; the context menu also copies a URL when the storage has a domain.
- Sort by name, size or date, filter the list, select several with Ctrl/⌘ or Shift, and use Delete, F2, Enter and Backspace.

It reads and writes through the storage's own backend (the local folder, SFTP or SMB) as the storage's user, the same way the S3 endpoint does, so it needs no S3 key and works even while the endpoint is stopped. Changes are in the audit log with the paths, never the contents. Bucket names follow the S3 rules (3–63 characters of lowercase letters, digits, dots and hyphens).

It is off when the server's file explorer is (`agent.files.enabled` in the server's [config.yaml](/reference/config-yaml)), and read-only when `agent.files.readOnly` is set.

## Large transfers

The service sets [`proxy.timeout`](/reference/app-yaml#services) to 30 minutes, so HAProxy does not cut long uploads and downloads or slow remote backends. Any routed service can set it.

## Requirements

The server needs **rclone 1.65 or newer**, which distributions rarely ship. The installer fetches the upstream release and checks its checksum:

```sh
curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh -s -- --role agent --with-storage
```

On a remote server, use **Servers → the server → S3 storage → Add storage support** instead; it runs the same installer and keeps everything else as it is. Servers without rclone refuse to create a storage and say so.

## Limits

No per-bucket policies or public buckets, a single key pair per storage, no virtual-host-style addressing, no quotas or usage graphs.
