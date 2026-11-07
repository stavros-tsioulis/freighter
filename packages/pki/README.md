# @freighter/pki

The small PKI that lets one control plane manage agents on other servers over mutual TLS (phase 7).

## Trust model
- The **control plane** owns a private CA (`pki.dir`, default `/var/lib/freighter/pki`, files `0600`) and one client identity, `CN=freighter-control-plane`, signed by that CA.
- Each **agent** gets a server certificate for exactly the address you registered (`CN=<server name>`, SAN = that host name or IP). The agent generates its key and CSR locally; the key never leaves the host. The subject and SANs come from the server record, never from the CSR.
- **Agent → accepts** only clients whose certificate chains to the CA *and* has CN `freighter-control-plane` (TLS 1.3 only).
- **Control plane → accepts** only an agent whose certificate chains to the CA, matches the registered address, *and* whose SHA-256 fingerprint equals the one recorded at enrollment. A different agent certificate from the same CA cannot stand in for a server.
- **Enrollment** is a one-time token (1 hour, single use, only its hash is stored) redeemed over the control plane's normal HTTPS endpoint. The operator pins the CA fingerprint on the command line; the agent refuses to install anything if the CA it receives does not match.

## What a compromised agent can and cannot do
It controls its own server (it runs as root there), including the apps and secrets on it. It cannot impersonate the control plane (it has no client key), reach other agents (they require the client certificate), or impersonate another server to the control plane (pinned fingerprints).
A compromised **control plane** can operate every server, as expected; it also holds the CA key, so keep that host tight.

## Lifecycle
Agent certificates last one year (the Servers page warns under 30 days). Renew with `freighter server token <name>` on the control plane and `freighter-agent enroll …` again on the server, then restart the agent. To retire a server: remove it (`freighter server remove`) and close its firewall port; its certificate is useless without the control plane's client key.
There is no CRL/OCSP: the control plane decides which agents it talks to, and agents only accept the one client identity.
