# Console

An interactive shell in a service, in the dashboard. It is the **Console** tab of an app, and of a service in the project canvas. Admins only. Press **Open console**; nothing connects until you do.

## Where the shell runs

| Service | The shell |
| --- | --- |
| A command (a host process) | `bash` (else `sh`) **as the app's user**, in the directory its unit runs in (the current release). It has the service's environment: its variables, the values its connections resolve to, and its secrets. `HOME` is the app's shared directory. |
| An image | `bash` (else `sh`) **inside its running container**, through the app's rootless Podman. It has the container's own environment. |

The service has to be running. The shell is a normal terminal: colors, `vim`, `htop`, a resizable window, copy and paste. It can only do what the app's user can: it is not root.

From a terminal, [`freighter shell app/service`](/cli/apps#shell) opens the same shell, and [`freighter exec`](/cli/apps#exec) runs one command and returns its exit code.

## Sessions

- Each session is in the [audit log](/operate/dashboard#access-admin) when it opens and when it closes, with the service and how long it lasted. What you type is not recorded.
- A session with no input for 30 minutes is closed. Closing the tab or the browser hangs up the shell.
- At most 8 are open on a server at once.
- It needs `python3` on the server (the installer adds it).

## Turning it off

In the server's `config.yaml`:

```yaml
agent:
  console:
    enabled: true     # false: no consoles on this server
    idleMinutes: 30
    maxSessions: 8
```

The console runs through the dashboard's WebSocket (`/_console`), so a proxy in front of it has to pass WebSocket upgrades. HAProxy, nginx and Cloudflare do by default. The dashboard refuses it from a page on another site. A dashboard that uses another Freighter's API (`FREIGHTER_API_URL`) relays the console to it, so who may open one, and the audit log, are the other Freighter's.
