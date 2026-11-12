# Processes

The server's **Monitoring** tab lists what is running, under the memory chart. It is the same information as `top`, with Freighter's own processes marked.

Each row shows the process and its command, PID, user, CPU (percent of one core, measured over the last fraction of a second), memory (resident, with its share of the server), threads, state and when it started. Click a column to sort; the default is by memory. **Live** reads again every three seconds; pause it to keep a list still. The filter matches names, commands, users, PIDs and app names.

## Freighter's processes

A process that belongs to Freighter has a coloured stripe and a tag:

| Colour | What |
| --- | --- |
| Blue | A service of an app (`shop/web`) or a storage, including a container's processes. Click the tag to open the app. |
| Amber | A build |
| Violet | Freighter itself: the agent and the API |

Freighter's processes are recognised by the systemd unit they run in, and, for containers, by the app's user. **Freighter's only** shows just those; **Kernel threads** shows the ones that are hidden by default.

## Stopping a process

Open the row's menu (the dots, or right-click) and choose **Terminate** (SIGTERM, which lets it clean up) or **Kill** (SIGKILL, which doesn't). Both ask first.

- An app's process is started again by systemd right away. To stop it for good, use **Stop** on the app's **Services** tab.
- Freighter's own services, kernel threads, PID 1 and the agent itself can't be signaled.
- The signal is sent to the process that was listed. If its PID has been reused since, the request is refused and you refresh the list.

Admins only. Signals go in the audit log by process name and PID, never the command line, which can hold secrets.

## Turning it off

In that server's `config.yaml`: `agent.processes.enabled: false` removes the list, and `agent.processes.readOnly: true` allows looking but not signaling. See [config.yaml](/reference/config-yaml#agent).
