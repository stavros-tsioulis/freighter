# Access

## login, logout, whoami

```sh
freighter login [url] [--token <token>] [--name <context>]
freighter logout [context]
freighter whoami
```

`login` asks for a token without echoing it, checks it, and saves it as a context named after the host (`--name` to choose). Pass `--token` only in scripts; better, set `FREIGHTER_TOKEN` and skip `login`. `logout` forgets a context on this machine. The token itself stays valid until it is [revoked](#token).

```
$ freighter whoami
ci (deployer) on freighter.example.com
```

## context

```sh
freighter context list
freighter context use <name>
freighter context show
freighter context remove <name>
```

Contexts are in `~/.config/freighter/config.json`, readable only by you. Tokens are kept there as they are; use a token with only the role the machine needs.

## token

```sh
freighter token list
freighter token create <name> [--role viewer|deployer|admin]
freighter token revoke <id>
```

The role defaults to `viewer`. `create` prints the token once; `-q` prints only the token, for a script. Admin only. See [Users and tokens](/operate/access) for what each role may do.

## ssh-key

Keys for cloning private repositories and for SFTP storages.

```sh
freighter ssh-key list
freighter ssh-key generate <name>
freighter ssh-key import <name> --file <path|-> [--passphrase-stdin]
freighter ssh-key remove <name>
```

`generate` and `list` show the public key. `remove` is refused while an app uses the key.

## registry

Logins for private container registries, used when pulling images.

```sh
freighter registry list
freighter registry add <host> --username <user> --password-stdin
freighter registry remove <host> [--username <user>]
```

A registry can have several logins; pick one for an app with [`deploy --login`](/cli/deploy#from-an-image). They are stored encrypted and never shown again.

## cert

```sh
freighter cert list
freighter cert renew [--force]
```

`list` shows every `tls: auto` hostname with its expiry, soonest first. `renew` renews what is due, or everything with `--force`. Renewal runs by itself every day.

## audit

```sh
freighter audit [--app <name>] [--who <token>] [--action <name>] [-n 50]
```

Who did what: deploys, config changes, [console and exec](/cli/apps#exec) sessions, token and key changes. Admin only.

## sync, version, upgrade

```sh
freighter sync          # re-read every server now, instead of at the next periodic sync
freighter version       # this CLI, the control server, and each agent's version
freighter upgrade       # replace this CLI with the one the control server serves
```
