# Deploying from a Git repository (over SSH)

Link an app to a Git repository and Freighter builds and deploys it for you: on every push to the branch, or when you press **Deploy latest**. Deployments go through the same health-checked, auto-rolling-back engine as uploaded artifacts; a broken build or an unhealthy release never replaces the running one.

```
push ──webhook──▶ Freighter API ──▶ agent on the app's server
                                     1  git fetch the branch            (SSH key, as root)
                                     2  export the commit's files       (git archive: no hooks, no filters)
                                     3  run build.commands, sandboxed   (unprivileged user, limits, no secrets)
                                     4  deploy the result               (health check, blue/green, rollback)
```

The webhook only **triggers**. Freighter always fetches the branch from the repository itself, so a forged or replayed webhook can at worst re-deploy the branch head that is already there.

## SSH keys: import once, use for any repository

Freighter clones over SSH (`git@host:org/repo.git` or `ssh://…`); public repositories also work over `https://` with no key. There are two ways to give it access to a private repository:

1. **Imported SSH keys (Settings → SSH keys, admin).** Paste or choose the *private* key of the account that can read your repositories (your own, a machine user, or an org-level deploy key). If it is passphrase-protected, enter the passphrase once; Freighter stores the key *without* the passphrase, encrypted at rest (AES-256-GCM, key file next to the registry database). The private key is never returned by the API or shown again; the table shows its fingerprint and which apps use it. Import one key per Git account you deploy from, then pick it per repository.
2. **A generated deploy key per app.** If you choose *Generated deploy key for this app* (the default on an app's Source tab), the agent creates a read-only key on the server that builds it and shows you the public half to add under the repository's *Deploy keys*. The private half never leaves that server.

An imported key is sent to the agent that is about to clone, over the local socket or the pinned mutual-TLS connection, kept in a `0600` file only for the duration of that `git` call, and deleted right after. It is never written into a build, a log or an error message.

## Deploy from a repository

**Overview → New app from Git** (admin):

1. Pick the **SSH key** (or *None* for a public HTTPS repository).
2. Enter the **repository** URL. Once it looks valid, the **branch** list fills from the real remote (`git ls-remote`), the default branch preselected.
3. Freighter reads `app.yaml` on that branch and shows the app it will create (its `name:`) and the commit. **Deploy** links the repository and starts the first build. If you have more than one server you also choose where it builds and runs; the app is then pinned to that server.
4. Optionally add the push **webhook** it shows (URL + one-time secret) on your git host so every push deploys.

From the CLI:

```sh
freighter ssh-key import work-github --file ~/.ssh/id_ed25519      # once
freighter git add git@github.com:acme/shop.git --branch main --key work-github
freighter git link shop --repo git@github.com:acme/shop.git --key work-github   # for an app that already exists
```

An existing app can be linked from its **Source** tab (same choices; the repository's `app.yaml` must carry the app's name) and its key and branch can be changed later there.

**Webhooks.** The push webhook is the same for every host: `POST <your Freighter>/api/v1/hooks/<app>` signed with the app's secret. Choose the format when linking: `github` (`X-Hub-Signature-256`, event `push`; also what Gitea/Forgejo send), or `gitlab` (`X-Gitlab-Token`, `Push Hook`). Hosts that cannot reach your Freighter still work: use **Deploy latest** (or `freighter git deploy <app>`).

```yaml
# /etc/freighter/config.yaml (all optional)
api:
  publicUrl: https://freighter.example.com   # used to show the webhook URL; derived from the request when unset
  dnsServers: [1.1.1.1, 8.8.8.8]              # used to verify domains (default); [] uses the system resolver
  publicIps: [203.0.113.7]                    # this host's public IP(s): the DNS target shown when adding domains

git:
  knownHosts: accept-new                      # or "yes" to refuse hosts you have not pinned yourself
```

## `app.yaml`

`app.yaml` lives in the repository (at the subdirectory you chose) and its `name` must equal the app's name. New in the manifest:

```yaml
build:
  timeout: 15m          # default; the build is killed after this
  memory: 2G            # default
  cpu: 2                # default: up to 2 cores
  commands:
    - pnpm install --frozen-lockfile
    - pnpm build
```

Whatever the commands leave in the checkout (build output, `node_modules`) is what gets deployed, so `command:` in `services:` runs against that directory. Without `build:`, the checkout is deployed as is.

### No `app.yaml` in the repository?

`app.yaml` is an init file. A new app starts from the **settings** the dashboard form sends (filled in from the repository's `app.yaml` when it has one; services, environment, secret names, build commands, release retention: everything `app.yaml` can define except the name), or else from the file itself. The result is the app's configuration, kept on its server. Later deploys don't read the repository's `app.yaml`: the configuration is changed on the app's *Settings* tab or with `freighter config set`, validated by the same parser, and deployed through the same health-gated engine.

- **New app:** in *Deploy from Git* the form is filled from `app.yaml`; with no file the dialog asks for an app name.
- **Existing app:** *Settings* tab → *Save and redeploy*.
- **API:** `settings` on `POST /v1/git/deployments`, `GET/PUT /v1/apps/:app/config`, `POST /v1/manifest/render` for the preview.
- Secret *values* are never part of the form; set them on the Environment tab.

## What a build can and cannot do

Each build is a transient systemd unit (`systemd-run`) under the unprivileged user `freighter-build`:

| | |
| --- | --- |
| limits | `MemoryMax`, `CPUQuota`, `TasksMax=1024`, `RuntimeMaxSec` from `build:` |
| filesystem | read-only system (`ProtectSystem=strict`), private `/tmp`, no `/home`, writes only to its own checkout and a per-app package cache |
| hidden | `/srv/apps`, `/etc/freighter` (secrets), `/var/lib/freighter` (registry, keys), `/run/freighter` (agent socket), `/etc/haproxy`, `/etc/letsencrypt` |
| privileges | `NoNewPrivileges`, no devices, no kernel tunables or modules |
| network | **allowed**, so package managers work |
| secrets | none are passed in; the app's runtime environment and secrets are not visible to builds |

This is process sandboxing, not a VM: do not link repositories you would not run on the server. The SSH key is used by Freighter itself (as root) to fetch, never by build code, and git only ever exports files — nothing from the repository is executed during fetch.

The server needs `git`, `openssh-client`, `systemd-run`, and whatever your build needs (Node, pnpm, …).

## Behaviour worth knowing

- **Coalescing:** at most one deployment per app waits in the queue; pushes that arrive while one is waiting join it. A push during a running build queues exactly one follow-up.
- **Unchanged head:** a webhook for a commit that is already deployed is recorded as a successful no-op. **Deploy latest** always deploys.
- **Failures:** a failed build or an unhealthy release leaves the running release untouched. The build log is kept with the deployment (Deployments tab, expand a row; follows live while it runs).
- **Per-server queues:** a long build on one server never delays deployments on another.
- **Submodules** and Git LFS are not fetched.
- **Webhook format "other"** can be linked and deployed manually, but push webhooks need `github` or `gitlab` (their signing schemes are what is verified).

## Troubleshooting

| symptom | likely cause |
| --- | --- |
| *Test connection* / branch list: `permission denied (publickey)` | the key cannot read this repository, or the generated deploy key was not added / was rotated |
| a private repository lists no branches | pick the SSH key first; without one only public HTTPS repositories work |
| import: “the key is passphrase-protected” | enter its passphrase; it is used once and not stored |
| `host key verification failed` | the git host's key changed; remove the app's `known_hosts` under `/var/lib/freighter/git/<app>/` on the server |
| webhook delivery shows `401` | secret mismatch: rotate it in the Source tab and update the host |
| delivery `2xx` but nothing deploys | see *Last webhook* in the Source tab: wrong branch, auto-deploy off, not a push event |
| `app.yaml is for "x" but this app is "y"` | the manifest's `name` differs from the app's name |
| cannot delete a key | apps still use it; switch them to another key first |
| build killed | raise `build.timeout` / `build.memory` |

## Alternative: build in CI and push the artifact

If you prefer to build in GitHub Actions / GitLab CI (and keep build tooling off the server), upload the result with the API instead; no deploy key or webhook is needed. Ready-made pipelines: [`ci/github-actions.yml`](ci/github-actions.yml), [`ci/gitlab-ci.yml`](ci/gitlab-ci.yml). Create a deployer token with `freighter token create --role deployer` and store it as the `FREIGHTER_TOKEN` secret.
