# freighter command reference

Full docs: `apps/docs/cli/*.md` in the Freighter repo (or the docs site's /cli pages). `[app]` can be omitted inside a directory with `app.yaml`.

## Contents
- Apps & services · Deploy · Configure · Servers · Storage · Access · CLI itself · On the machine (`host`)

## Apps & services
```
app list [--project p] [--server s] | app show [app] | app delete [app] [--forget] | app move [app] --project <name|none>
ps [app] | start|stop|restart [app[/service]] | logs [app[/service]] [-n N] [-f] | stats [app] [--since 1h]
exec <app/service> [-i] [-t] [-e K=V] -- cmd… | shell <app/service>
project list|create|rename|delete|show
```
`app delete` removes services, routing, certs, releases, secrets, deploy key; no undo. `--forget` drops only dashboard records.

## Deploy
```
deploy [path] [--app n] [--server s] [--no-wait] [--dry-run] [-v] [--timeout 10m]
deploy --image <ref> --app <n> [--port N] [--login host=user]
deploy --git <repo> [--branch b] [--key k] [--subpath d] [--no-auto]
redeploy [app] | rollback [app] [release] | release list [app]
deployment list [app] [-n 20] [--failed] | show <id> | logs <id> [-f] | cancel <id>
```

## Configure
```
config show|edit|apply|diff [app] [-f app.yaml]
var list [app[/svc]] [--resolved] | var set <app[/svc]> K=V… [--build] | var unset <app[/svc]> K… [--build]
secret list <app/svc> | secret set <app/svc> KEY [--stdin]
domain list|add|verify|remove [app] <host> [--service s] [--http]
volume list [app] | volume password [app] <name> [--stdin]
git show|link|check|deploy|rotate-secret|rotate-key|unlink [app]
```

## Servers
```
server list|show <n>|add <n> --address h|token <n>|check <n>|upgrade <n> [--ref r] [--with feat…]|restart <n>|remove <n>
server config <n> [set key=value…]
firewall <server> [enable [--open p…]|disable|allow|deny|reject|limit <port>[/tcp|/udp] [--from a] [--to a] [--comment t] [--position n]|delete <number>|default <incoming|outgoing> <action>]
file ls|cat|get|put|mkdir|… <server>:<path>          (admin)
process …  settings …                                  (see --help)
```

## Storage
```
storage list|show|create|set|rotate-keys|connect|delete   storage file ls|get|put|mkdir|mv|rm|link <name>:<path>
```

## Access
```
login [url] [--token t] [--name ctx] | logout [ctx] | whoami | context list|use|show|remove
token list | token create <name> [--role viewer|deployer|admin] -q | token revoke <id>
ssh-key list|generate|import|remove | registry list|add|remove | cert list|renew
audit [--app a] [--who token] [--action prefix] [-n 50]
```

## CLI itself
```
upgrade [--check] | completion bash|zsh|fish | install-cli (server serves /install-cli)
```
Env: `FREIGHTER_URL`, `FREIGHTER_TOKEN`, `FREIGHTER_CONTEXT`, `FREIGHTER_CONFIG`, `FREIGHTER_NO_UPDATE_CHECK`, `NO_COLOR`.

## On the machine
`freighter host …` are the commands that run on the server itself (agent, installer tasks) — not for use from a laptop. Check `freighter host --help` and `apps/docs/cli/host.md`.
