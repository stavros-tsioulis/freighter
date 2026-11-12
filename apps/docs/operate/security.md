# Security model

## Privilege split

| Component | Runs as | Can |
| --- | --- | --- |
| API and dashboard | `freighter`, sandboxed (`ProtectSystem=strict`, `NoNewPrivileges`) | read and write its registry, talk to agents |
| Agent | root | a fixed list of operations: deploy, roll back, control services, read logs, set secrets, manage certificates, report stats, build from Git |
| Apps | one system user per app | read their release, write only `shared/` and a private `/tmp` |
| Builds | `freighter-build`, in a transient sandboxed unit | write only their checkout and a per-app package cache |

The agent exposes no shell and no general file access. It only deploys artifacts that are inside its own artifacts directory, and secret values never come back out of it.

## App sandbox

Every service unit is generated with:

```ini
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/srv/apps/<app>/shared
TasksMax=512
```

and with `MemoryMax` and `CPUQuota` when `resources` sets them. `HOME` is `/srv/apps/<app>/shared`, because the real home is hidden: tools that cache under it (corepack, pnpm, npm) write there. Set `HOME` in `environment:` to change it. Apps can't see each other's secrets, because each env file is root-owned and read by systemd.

This is process isolation on a shared kernel, not a VM. It's well suited to apps you wrote or trust, and not to running untrusted code.

## Remote servers

The control server owns a private CA (`/var/lib/freighter/pki`, files `0600`) and one client identity, `CN=freighter-control-plane`.

- Each agent gets a server certificate for exactly the address you registered. The agent makes its own key, which never leaves the server, and the certificate's name comes from the server record, not from the request.
- An **agent accepts** only clients whose certificate chains to the CA and has the control plane's name, over TLS 1.3.
- The **control server accepts** only an agent whose certificate chains to the CA, matches the registered address, and whose fingerprint equals the one recorded at enrollment. Another certificate from the same CA can't stand in for a server.
- **Enrollment** uses a one-time token, valid for an hour, whose hash is all that's stored. The operator pins the CA fingerprint on the command line, and the agent refuses to install anything if it doesn't match.

A compromised agent controls its own server, including the apps and secrets on it. It can't impersonate the control server, reach other agents, or pose as another server. A compromised control server can operate every server and holds the CA key, so keep it locked down.

There's no revocation list. The control server decides which agents it talks to, and agents accept only the single client identity.

## The process list

The [process list](/operate/processes) shows every process on a server with its full command line, which can include secrets passed as arguments, and lets an admin signal them. It is admin-only, signals are audited by name and PID, and it can be turned off or made read-only per server with `agent.processes` in that server's `config.yaml`. It never signals PID 1, kernel threads, the agent or Freighter's own services.

## The file explorer

The [file explorer](/operate/files) shows every file on a server, and the agent runs as root, so this is the most powerful thing an admin token can do. It reads and changes anything the machine has: keys, certificates, the registry database, other apps' data.

- Only the **admin** role can use it. Each request is checked, and changes, uploads and downloads are in the audit log with the paths (never file contents).
- It can be turned off on a server (`agent.files.enabled: false`) or limited to looking and downloading (`agent.files.readOnly: true`), in that server's `config.yaml`. The setting lives on the server, so a stolen token can't undo it.
- It refuses to delete or move the system's top-level folders, and to delete a folder with a remote volume mounted inside it.
- Anything root creates through it belongs to the owner of the folder it goes in.

## Git

- Imported SSH keys are encrypted at rest with AES-256-GCM. The key for that lives in `/var/lib/freighter/secret.key`, next to the registry, so back both up together.
- A key is sent to the agent that's about to clone, kept in a `0600` file only for that `git` call, and deleted right after. It's never written into a build, a log or an error message.
- Fetching runs `git` as root but only exports files (`git archive`: no hooks, no filters). Repository code runs only in the build sandbox, as `freighter-build`, without secrets.
- Webhooks are verified (`X-Hub-Signature-256` or `X-Gitlab-Token`), bad signatures are rate-limited, and a webhook can only trigger a fetch of the linked branch.

## Recommendations

- Keep the API on `127.0.0.1` behind HAProxy and serve the dashboard over HTTPS only.
- Open port 7443 on remote servers to the control server's address only.
- Give deployer and admin tokens only to people and pipelines you'd trust with root on your servers.
- Back up `/var/lib/freighter` on the control server, which holds the registry, the CA and `secret.key`. Back up `/srv/apps/*/shared` and `/etc/freighter` on every server.
