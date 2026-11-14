# Storage

[S3 storages](/deploy/storage): an S3 endpoint that Freighter runs, on a local folder or an SFTP or SMB share.

## storage

```sh
freighter storage list
freighter storage show <name>
freighter storage create <name> --server <server> [--type local|sftp|smb] [options]
freighter storage set <name> [--public | --private] [options]
freighter storage rotate-keys <name>
freighter storage connect <name> [--aws | --rclone | --env]
freighter storage delete <name>
```

```
$ freighter storage create files --server contabo-1 --domain files.example.com
Storage files created on contabo-1.
  endpoint     https://files.example.com
  access key   AKIA…Q7
  secret key   wJal…9s        (shown once)
$ freighter storage list
NAME     TYPE   SERVER      DOMAIN              PUBLIC  USED
files    local  contabo-1   files.example.com   no      1.2 GB
media    sftp   contabo-1   media.example.com   yes     -
```

| Option | |
| --- | --- |
| `--type` | `local` (a folder the agent keeps; the default), `sftp` or `smb` |
| `--domain <hostname>` | the endpoint's domain (then [verify it](/cli/configure#domain) like any other) |
| `--public` | anyone can read, nobody can write without a key; adds a second, read-only endpoint |
| `--public-domain <hostname>` | the public endpoint's domain |
| `--host`, `--port`, `--user`, `--path` | where an `sftp` or `smb` storage is |
| `--share <name>` | an `smb` share |
| `--key-file <path>` | a private key file for `sftp` (`-` for standard input), instead of a password |
| `--password-stdin` | the remote password, read from standard input (never an argument) |

`create` tests the remote connection first and says why it can't connect. The key pair is shown once; `rotate-keys` makes a new one and restarts the apps that use it. `connect` prints how to use the storage: the AWS CLI commands, an `rclone` remote, or the variables to give an app (`--env`).

## storage file

```sh
freighter storage file ls <name>:<path>
freighter storage file get <name>:<path> [<local>]
freighter storage file put <local>... <name>:<path> [--overwrite]
freighter storage file mkdir <name>:<path>
freighter storage file mv <name>:<path> <name>:<path>
freighter storage file rm <name>:<path>...
freighter storage file link <name>:<path> [--expires 1h]
```

Paths are `/bucket/key`. Buckets are the folders at the top.

```
$ freighter storage file ls files:/photos
NAME      SIZE     MODIFIED
2026/     -        3d ago
cover.jpg 412 KB   1h ago
$ freighter storage file put ./cover.jpg files:/photos/
$ freighter storage file link files:/photos/cover.jpg --expires 24h
https://files.example.com/photos/cover.jpg?X-Amz-Algorithm=…
```

`link` is a signed address that downloads the file without a key until it expires (a minute to seven days). On a public storage the file's address is just its URL, and `link` prints that.
