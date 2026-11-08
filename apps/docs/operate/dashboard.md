# The dashboard

The dashboard is served by the API on the control server. Sign in by pasting an API token. The session lasts 7 days, or until the token is revoked. What you can do depends on the token's [role](/operate/access).

## Apps

One row per app: its status, its services with a dot each (green running, amber starting or stopping, red failed), its first domain, the current release and when it last changed. Apps that need attention (a failed service, or a release missing on disk) are listed first, and the sentence under the title says how many there are.

From here, admins can **Deploy from Git** and deployers can **Upload archive**. **Sync** (admin) re-reads every server immediately instead of waiting for the next periodic sync. With more than one server, filter the list by server.

Below the list, **Recent deployments** shows the latest deploys and rollbacks across all apps.

## An app

The header shows the app's server, how many services are running, the current and previous release, and when it was last synced. The tabs:

| Tab | What's there | Role |
| --- | --- | --- |
| **Services** | state, address, restarts, memory and CPU with charts over 15 min, an hour or 6 hours; start, stop, restart | viewer (actions: deployer) |
| **Domains** | hostnames, DNS records to create, verify, remove (removal is routing-only: no redeploy) | viewer (changes: admin) |
| **Deployments** | history with trigger, commit and duration; open a row for its build log, warnings and errors; **Roll back**, **Upload archive** | viewer (actions: deployer) |
| **Source** | the linked repository, branch, key, auto-deploy, last webhook, settings for repositories without `app.yaml`; **Deploy latest**, **Test connection**, rotate secret or key, unlink | viewer (changes: admin) |
| **Logs** | the journal of a service, 10–1000 lines, *Live* mode refreshing every 3 seconds, copy and download | deployer |
| **Secrets** | secret names, warnings for declared ones that aren't set, set a value | viewer (set: admin) |

The open tab is part of the URL (`/apps/shop?tab=logs`), so you can share a link straight to it.

### Delete an app

Admins see **Delete app** in the app's header. The dialog lists what goes: the services, the routing and certificates for its domains, every release, the shared directory (where databases and uploads live), the secrets, the deploy key and the deployment history here. Its Git repository stays. You must type the app's name to enable the button, and there is no undo. If the app's server can't be reached, the dialog offers to remove only the dashboard's records. An app the server no longer reports (*Missing*) is removed from the dashboard alone. From a terminal: [`freighter app delete`](/reference/cli#app).

## Servers

Every server with its status (*Online*, *Offline*, *Waiting to enroll*, *Error*), the last error if any, and a strip of facts: hostname, uptime, load, memory used, free disk, number of apps, last contact, agent version and, for remote servers, how long their certificate has left. Admins can add servers, **Check now**, **Re-enroll**, **Upgrade** a remote server's agent to the version the dashboard runs (with progress, log and automatic rollback), and remove servers that have no apps.

Select a server's name to open its page. It shows the machine (hostname, uptime, load, memory, disk), the apps pinned to it, and, for admins, the agent and software: the version the agent runs next to the one the dashboard runs, whether HAProxy is Freighter's own or yours, the outcome of the last upgrade, and the agent certificate. The controls are **Check now**, **Check for updates**, **Upgrade**, **Restart agent**, **Re-enroll** and **Remove server**. **Check for updates** has the server itself ask the repository it was installed from, with its own git and network, whether `main` (or a branch, tag or commit you type) has newer commits than it runs, and lists them. It changes nothing on the server.

## Certificates

Every `tls: auto` hostname across all servers, soonest expiry first, with the date and the days left. Under 14 days shows amber and under 7 days red. Renewal is automatic, and admins can trigger it with **Renew due certificates**.

## Access (admin)

- **API tokens.** Create tokens (shown once) and revoke them.
- **SSH keys.** Import or generate the keys used to clone private repositories.
- **Audit log.** Every change made through the API, with who made it, the app and the details.

The moon or sun icon at the bottom of the sidebar switches between light and dark themes. The dashboard follows your system theme until you choose one.
