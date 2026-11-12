# Firewall

The server page's **Firewall** tab manages [ufw](https://help.ubuntu.com/community/UFW) on that server. Add it with **Add the firewall** on the Features tab, or `--with-firewall` when [installing](/install/script). It is installed **off**.

## Turning it on

**Turn on** first allows what you need to keep reaching the server: SSH (the port `sshd` really uses), the HAProxy HTTP and HTTPS ports and, if the agent is remote, its port. Add more ports in the dialog. Then incoming traffic that no rule allows is dropped. Rules are managed only while it is on; turning it off keeps them.

## Rules

Each rule has an action (**allow**, **deny**, **reject**, or **limit**, which allows but refuses addresses that connect too often), a port or range, a protocol, and an optional source address or network. The first matching rule wins, so put a deny above a broader allow (**More**, then **Position**). A rule with no address also gets an IPv6 copy; it is hidden by default and removed with its pair.

The **default** for incoming and outgoing traffic applies when no rule matches. Deny incoming and allow outgoing is the usual setup.

## Not locking yourself out

A change that would block SSH, the web ports or the agent is refused with the reason, and goes through only when you confirm it. Removing a rule checks it is still the one you saw.

## Settings

`agent.firewall.enabled: false` hides the tab and refuses its operations. `agent.firewall.readOnly: true` allows only viewing. See [config.yaml](/reference/config-yaml). Changes are in the [audit log](/operate/dashboard#access-admin).

ufw filters traffic to the host. Docker and Podman can add their own firewall rules for published ports that bypass ufw, so check a container's reachability from outside rather than assuming the rules cover it.
