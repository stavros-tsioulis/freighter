# Deploy from Git

Link an app to a branch and Freighter builds and deploys it, on every push or when you press **Deploy latest**. Builds go through the same health-checked engine as uploads: a broken build or an unhealthy release never replaces the one that's running.

```
push ──webhook──▶ API ──▶ agent on the app's server
                           1  git fetch the branch           (SSH key, as root)
                           2  export the commit's files      (git archive: no hooks, no filters)
                           3  run build.commands, sandboxed  (unprivileged user, limits, no secrets)
                           4  deploy the result              (health check, switch, rollback)
```

The webhook only *triggers* a build. Freighter always fetches the branch from the repository itself, so a forged or replayed webhook can at most redeploy the commit that's already at the head of the branch.

## Give Freighter read access

Public repositories work over `https://` with no key. For private ones there are two options:

- **An imported or generated SSH key** (**SSH keys** in the dashboard, admin only). *Import key* takes the private key of an account that can read your repositories: your own, a machine user, or an organisation deploy key. A passphrase is used once and not stored. *Generate key* creates a new ed25519 key and shows its public half to add to your Git host. Keys are stored encrypted (AES-256-GCM) and never shown again. One key can serve any number of repositories.
- **A deploy key per app.** Choose *Generated deploy key for this app* when linking. The agent creates a key on the app's server and shows you the public half to add under the repository's deploy keys (leave write access off). The private half never leaves that server.

From the CLI:

```sh
freighter ssh-key import work-github --file ~/.ssh/id_ed25519
freighter ssh-key generate deploy-acme       # prints the public key to add to your Git host
```

## Create an app from a repository

In the dashboard, on **Apps**, choose **Deploy**, then **Git repository**:

1. Pick the **SSH key**, or *None* for a public HTTPS repository.
2. Enter the **repository**, such as `git@github.com:acme/shop.git`. The **branch** list fills from the repository, with the default branch selected.
3. Freighter reads `app.yaml` on that branch and shows the app it will create (from `name:`) and the commit.
4. With more than one server, choose where it builds and runs.
5. **Deploy** links the repository and starts the first build. You then get the webhook URL and a secret, shown once.

```sh
freighter git add git@github.com:acme/shop.git --branch main --key work-github
```

An existing app can be linked from its **Source** tab, or with `freighter git link shop --repo … --key …`. The branch, key and auto-deploy setting can be changed later on the same tab.

### Monorepos

Set a **subdirectory** (`--subpath apps/web`). Freighter reads `app.yaml` from there, and that directory becomes the release.

### app.yaml starts the app

When you deploy a branch for a new app, the dashboard fills a form with what its `app.yaml` says: services, environment, secret names, build commands and limits, release retention. Change what you like; the form is what the app starts with. A branch without an `app.yaml` works too: give the app a name and fill the form in.

After the first deploy the repository's `app.yaml` is not read again, so a push that changes it still deploys the new commit, with a warning that the file wasn't applied. Change the app's configuration on its **Settings** tab (or with `freighter config set`); saving redeploys the current release with it, and later builds use its build commands.

## Deploy on push

Add the webhook on your Git host:

| Host | Where | Settings |
| --- | --- | --- |
| GitHub, Gitea, Forgejo | Settings, Webhooks, Add webhook | Payload URL from Freighter, content type `application/json`, the secret, *Just the push event* |
| GitLab | Settings, Webhooks | URL and secret token from Freighter, *Push events*, branch filter set to the linked branch |

The URL is `https://freighter.example.com/api/v1/hooks/<app>` and must be reachable from your Git host. Pick the webhook format when linking (`github` checks `X-Hub-Signature-256`, `gitlab` checks `X-Gitlab-Token`). The *Last webhook* line on the Source tab shows the latest delivery and what Freighter did with it.

If your Git host can't reach Freighter, skip the webhook and press **Deploy latest** or run `freighter git deploy shop`. A lost secret can be replaced with **Rotate secret** (`freighter git rotate-secret shop`).

## Building

Put the build in `app.yaml`:

```yaml
build:
  timeout: 15m          # default
  memory: 2G            # default
  cpu: 2                # default
  commands:
    - pnpm install --frozen-lockfile
    - pnpm build
```

Whatever the commands leave in the checkout (build output, `node_modules`) is what gets deployed, and `services.*.command` runs from that directory. Without `build:`, the checkout is deployed as it is.

Each build is a transient systemd unit running as the unprivileged `freighter-build` user:

| | |
| --- | --- |
| Limits | memory, CPU and time from `build:`, and at most 1024 tasks |
| Filesystem | read-only system, private `/tmp`, no `/home`. It can write only to its checkout and a per-app package cache under `/var/lib/freighter-build/cache/<app>` |
| Hidden | `/srv/apps`, `/etc/freighter`, `/var/lib/freighter`, `/run/freighter`, `/etc/haproxy`, `/etc/letsencrypt` |
| Network | allowed, so package managers work |
| Secrets | none. The app's environment and secrets aren't visible to builds |

The build log streams live on the app's **Deployments** tab (open a row) and is kept with the deployment.

::: warning
This is process sandboxing, not a VM. Only link repositories whose code you'd run on that server.
:::

## Good to know

- **Coalescing.** At most one deployment per app waits in the queue. Pushes that arrive meanwhile join it, and a push during a running build queues exactly one follow-up.
- **Unchanged head.** A webhook for a commit that's already deployed is recorded as a successful no-op. *Deploy latest* always deploys.
- **Separate queues per server.** A long build on one server never delays deployments on another.
- **Submodules and Git LFS** aren't fetched.
- **Host keys.** The first connection to a Git host accepts its key and pins it (`git.knownHosts: accept-new`). Set `knownHosts: yes` to refuse hosts you haven't pinned yourself.
