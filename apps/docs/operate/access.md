# Users and tokens

Freighter has no user accounts. Everyone and everything authenticates with an **API token**, and each token has one role. Give each person and each pipeline its own token, so you can revoke one without affecting the others and the audit log shows who did what.

## Roles

Roles are cumulative:

| Role | Can |
| --- | --- |
| **viewer** | see apps, services, deployments, releases, servers, certificates, metrics and secret names |
| **deployer** | everything a viewer can, plus deploy (upload or *Deploy latest*), roll back, start, stop, restart, read logs and build logs, test Git connections |
| **admin** | everything, including secret values, domains, Git links, SSH keys, servers, tokens, the audit log, certificate renewal and sync |

A CI pipeline that uploads builds needs **deployer**. Uploaded archives are unpacked and run on your servers, so treat deployer as trusted.

## Create a token

**Dashboard (admin).** Go to **API tokens**, press **New token**, then pick a name and role. The token is shown once. Copy it then.

**CLI**, on the control server, as the user that owns the registry:

```sh
sudo -u freighter freighter host token create ci-github --role deployer
sudo -u freighter freighter token list
sudo -u freighter freighter token revoke <id>
```

The CLI is how you create the very first admin token, and how you get back in if every admin token is lost.

## Using a token

- **Dashboard.** Paste it on the sign-in page. It's exchanged for an `HttpOnly`, `SameSite=Strict` session cookie that lasts 7 days. Signing out or revoking the token ends the session.
- **API.** Send `Authorization: Bearer fr_…`.
- **CLI commands that talk to the API** (`push`, `git`, `ssh-key`) read `--url` and `--token`, or `$FREIGHTER_URL` and `$FREIGHTER_TOKEN`.

## Revoking

Revoke from **API tokens** or with `freighter token revoke`. Anything using the token stops working immediately, including browser sessions signed in with it.

## How tokens are protected

- Only a SHA-256 hash of each token is stored. Tokens can't be recovered, only replaced.
- Ten failed attempts from one address in a minute are blocked with `429`.
- Browser writes need an `X-Requested-With: freighter` header, which the dashboard sends and other sites can't.
- Responses forbid framing (`X-Frame-Options: DENY`).

## Audit log

Every change through the API is recorded with its time, the token that made it, the action, the app and the details: deploys, rollbacks, secrets set (names only), domains, tokens, servers, keys, Git links. Admins can see it under **Audit log**, or with `GET /api/v1/audit`. Changes made with the CLI directly on a server bypass the API and aren't recorded here. Their deploys still appear in the app's deployment history.
