#!/bin/sh
# Freighter installer: sets up a control server or a remote (agent-only) server on Debian/Ubuntu.
#
#   curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh
#   curl -fsSL .../install.sh | sudo sh -s -- --role agent --dry-run
#
# Modelled on Tailscale's install.sh: everything lives in functions and `main "$@"` runs last, so a truncated download
# executes nothing; the OS is detected from /etc/os-release; privileges are checked up front. From Docker's
# get.docker.com it takes --dry-run. Beyond both: every step is idempotent (re-running upgrades in place), command
# output goes to a log that is shown only on failure, and nothing the operator owns (haproxy.cfg, config.yaml) is
# overwritten.
#
# Options (each also settable through the environment variable in brackets):
#   --role control|agent   what to install                      [FREIGHTER_ROLE, default control]
#   --ref <git ref>        branch, tag or commit to install      [FREIGHTER_REF, default main]
#   --from <dir>           install from a local checkout instead of cloning it    [FREIGHTER_FROM]
#   --dir <dir>            install location                      [FREIGHTER_DIR, default /opt/freighter]
#   --email <addr>         Let's Encrypt contact (acme.email)    [FREIGHTER_ACME_EMAIL]
#   --public-url <url>     URL of the dashboard (control only)   [FREIGHTER_PUBLIC_URL]
#   --node-version <v>     Node.js major to install              [FREIGHTER_NODE_MAJOR, default 24]
#   --with-agent           control role only: also run apps on this machine, through an agent of its own (with
#                          HAProxy and certbot). By default a control server only manages remote servers and
#                          runs no apps itself.                                       [FREIGHTER_WITH_AGENT=1]
#   --with-containers      agent servers: also install Podman, so apps can be deployed as container images
#                          (`image:` in app.yaml). Off by default; apps that run a command need none.
#                          Upgrades keep it.                                         [FREIGHTER_WITH_CONTAINERS=1]
#   --with-firewall        agent servers: also install ufw, so the dashboard can manage the firewall. Installing it
#                          does not turn it on. Off by default. Safe to re-run.                [FREIGHTER_WITH_FIREWALL=1]
#   --with-archives        agent servers: also install 7z, unzip, bzip2 and zstd, so the file explorer can extract
#                          7z, rar, zip and the tar variants. Off by default. Safe to re-run.   [FREIGHTER_WITH_ARCHIVES=1]
#   --with-mounts          agent servers: also install cifs-utils and nfs-common, so apps can use SMB and NFS volumes.
#                          Off by default. Safe to re-run on an existing server.            [FREIGHTER_WITH_MOUNTS=1]
#   --with-storage         agent servers: also install rclone, so this server can serve S3 storages (Storage in the
#                          dashboard). Off by default. Safe to re-run on an existing server.  [FREIGHTER_WITH_STORAGE=1]
#   --haproxy auto|dedicated|existing
#                          auto: use the HAProxy already on this server if there is one, else a dedicated one.
#                          dedicated: a separate Freighter-only HAProxy (own unit, own config); the system's
#                          HAProxy is not touched. existing: wire into the HAProxy you run.   [FREIGHTER_HAPROXY]
#   --http-port <n>        port HAProxy listens on for HTTP    [FREIGHTER_HTTP_PORT, default 80]
#   --https-port <n>       port HAProxy listens on for HTTPS   [FREIGHTER_HTTPS_PORT, default 443]
#   --public-https-port <n>  HTTPS port clients are redirected to (default: --https-port; use 443 when your own
#                          reverse proxy maps 443 -> --https-port)   [FREIGHTER_PUBLIC_HTTPS_PORT]
#   --accept-proxy         expect the PROXY protocol on both ports (nginx stream / HAProxy send-proxy in front)
#   --no-start             install but do not start services
#   --dry-run              print what would be done, change nothing
#   -h, --help

set -eu

REPO_URL="${FREIGHTER_REPO:-https://github.com/stavros-tsioulis/freighter.git}"
LOG=/var/log/freighter-install.log

# ---------- output ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m'); GRN=$(printf '\033[32m'); YLW=$(printf '\033[33m'); RST=$(printf '\033[0m')
else
	B=; DIM=; RED=; GRN=; YLW=; RST=
fi
step()  { printf '\n%s==>%s %s%s%s\n' "$B" "$RST" "$B" "$*" "$RST"; }
ok()    { printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
skip()  { printf '  %s•%s %s%s%s\n' "$DIM" "$RST" "$DIM" "$*" "$RST"; }
warn()  { printf '  %s!%s %s\n' "$YLW" "$RST" "$*" >&2; }
die()   { printf '\n%serror:%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

# run <description> <command...>: run quietly, log the output, show the log tail only if it fails.
# With --dry-run the command is printed instead of run.
run() {
	desc=$1; shift
	if [ "$DRY_RUN" = 1 ]; then
		printf '  %s$%s %s%s%s\n' "$DIM" "$RST" "$DIM" "$*" "$RST"
		return 0
	fi
	printf '\n$ %s\n' "$*" >>"$LOG"
	if "$@" >>"$LOG" 2>&1; then
		ok "$desc"
	else
		printf '\n%sfailed:%s %s\n%s$ %s%s\n' "$RED" "$RST" "$desc" "$DIM" "$*" "$RST" >&2
		tail -n 20 "$LOG" >&2
		die "see $LOG for the full output"
	fi
}

# write_file <path> <mode>: stdin -> file, only if the content changed. Returns 0 when it wrote.
write_file() {
	path=$1; mode=$2
	tmp=$(mktemp)
	cat >"$tmp"
	if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
		rm -f "$tmp"; skip "$path is up to date"; return 1
	fi
	if [ "$DRY_RUN" = 1 ]; then
		rm -f "$tmp"; printf '  %s$%s %swrite %s%s\n' "$DIM" "$RST" "$DIM" "$path" "$RST"; return 0
	fi
	install -D -m "$mode" "$tmp" "$path"; rm -f "$tmp"
	ok "wrote $path"
}

have() { command -v "$1" >/dev/null 2>&1; }

usage() { sed -n '2,/^$/p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

# ---------- 1. preflight ----------
preflight() {
	step "Checking this machine"

	[ "$(uname -s)" = Linux ] || die "Freighter runs on Linux with systemd (this is $(uname -s))."
	[ "$(id -u)" = 0 ] || [ "$DRY_RUN" = 1 ] || die "run as root: re-run with sudo (curl ... | sudo sh)."
	[ -d /run/systemd/system ] || die "systemd is not running as PID 1; Freighter needs it to supervise apps."

	case "$(uname -m)" in
		x86_64|amd64) NODE_ARCH=x64 ;;
		aarch64|arm64) NODE_ARCH=arm64 ;;
		*) die "unsupported CPU architecture: $(uname -m) (x86_64 and arm64 are supported)." ;;
	esac

	[ -r /etc/os-release ] || die "cannot detect the distribution (no /etc/os-release)."
	# shellcheck disable=SC1091
	. /etc/os-release
	case "${ID:-}:${ID_LIKE:-}" in
		debian:*|ubuntu:*|*:*debian*|*:*ubuntu*) ;;
		*) die "${PRETTY_NAME:-this distribution} is not supported yet; the installer handles Debian and Ubuntu (apt). The manual steps in the docs work anywhere with systemd: https://github.com/stavros-tsioulis/freighter/tree/main/apps/docs/install" ;;
	esac
	ok "${PRETTY_NAME:-$ID} on $(uname -m), systemd running"

	if have curl; then DL="curl -fsSL"; elif have wget; then DL="wget -qO-"; else DL=; fi
	if [ -z "$DL" ] && [ "$DRY_RUN" != 1 ]; then
		apt-get update -qq >>"$LOG" 2>&1 && apt-get install -y -qq curl ca-certificates >>"$LOG" 2>&1 || die "need curl or wget and could not install curl."
		DL="curl -fsSL"
	fi
	[ "$DRY_RUN" = 1 ] || $DL https://nodejs.org/dist/index.json >/dev/null 2>&1 || die "cannot reach nodejs.org; check this machine's internet access."
}

# Decide between the HAProxy the operator already runs and a Freighter-only one.
detect_haproxy_mode() {
	# An earlier install recorded whose HAProxy this is (see setup_haproxy). Re-running the installer, and upgrades,
	# must not flip that because of what happens to be installed or running now.
	if [ "$HAPROXY_MODE" = auto ] && [ -r /etc/haproxy/freighter/mode ]; then
		case $(cat /etc/haproxy/freighter/mode) in
			dedicated) HAPROXY_MODE=dedicated; HAPROXY_RECORDED=1 ;;
			existing) HAPROXY_MODE=existing; HAPROXY_RECORDED=1 ;;
		esac
	fi
	if [ "$HAPROXY_MODE" = none ]; then ok "No agent on this machine: it runs no apps, so no HAProxy or certbot either"; return; fi
	if [ "$HAPROXY_MODE" = auto ]; then
		if dpkg -s haproxy >/dev/null 2>&1 && systemctl is-enabled haproxy >/dev/null 2>&1; then HAPROXY_MODE=existing; else HAPROXY_MODE=dedicated; fi
		ok "HAProxy: $HAPROXY_MODE ($([ "$HAPROXY_MODE" = existing ] && echo "found one on this server; --haproxy dedicated to use a separate one" || echo "none running here; Freighter gets its own"))"
	else
		ok "HAProxy: $HAPROXY_MODE ($([ "${HAPROXY_RECORDED:-0}" = 1 ] && echo "as recorded by the earlier install" || echo "as requested"))"
	fi
	# A dedicated HAProxy needs its ports free (unless it is ours from an earlier run).
	if [ "$HAPROXY_MODE" = dedicated ] && ! systemctl is-active freighter-haproxy >/dev/null 2>&1; then
		for pt in "$HTTP_PORT" "$HTTPS_PORT"; do
			if port_in_use "$pt"; then
				die "port $pt is already in use. Pick other ports (--http-port/--https-port), or use --haproxy existing if that is your HAProxy."
			fi
		done
	fi
}

# port_in_use <port>: is something listening on it? Uses ss, else /proc (state 0A = LISTEN).
port_in_use() {
	if have ss; then [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]; return; fi
	hex=$(printf '%04X' "$1")
	awk -v p=":$hex" '$4 == "0A" && $2 ~ p"$" {f=1} END {exit !f}' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

# ---------- 2. system packages ----------
install_packages() {
	step "Installing system packages"
	pkgs="git tar gzip curl ca-certificates openssl xz-utils"
	[ "$HAS_AGENT" = 0 ] || pkgs="$pkgs openssh-client haproxy certbot python3"  # python3: the console's terminal helper
	# Rootless Podman for image services: it needs the setuid newuidmap/newgidmap helpers (uidmap), a user-level network
	# stack, and a login manager that keeps /run/user/<uid> alive for the app's user (dbus-user-session).
	if [ "$HAS_AGENT" = 1 ] && [ "$WITH_CONTAINERS" = 1 ]; then
		pkgs="$pkgs podman uidmap slirp4netns fuse-overlayfs dbus-user-session"
		# pasta (passt) is the newer rootless network stack; not every release has it, and slirp4netns covers the others.
		if apt-cache show passt >/dev/null 2>&1; then pkgs="$pkgs passt"; fi
	fi
	# Remote volumes: mount.cifs and mount.nfs.
	if [ "$HAS_AGENT" = 1 ] && [ "$WITH_MOUNTS" = 1 ]; then pkgs="$pkgs cifs-utils nfs-common"; fi
	# Archive tools for the file explorer. The 7-Zip package is called 7zip on current releases, p7zip-full on older ones.
	if [ "$HAS_AGENT" = 1 ] && [ "$WITH_ARCHIVES" = 1 ]; then
		pkgs="$pkgs unzip bzip2 zstd"
		if apt-cache show 7zip >/dev/null 2>&1; then pkgs="$pkgs 7zip"; else pkgs="$pkgs p7zip-full"; fi
	fi
	# ufw is only installed: the dashboard turns it on, after it has made sure SSH and Freighter stay reachable.
	if [ "$HAS_AGENT" = 1 ] && [ "$WITH_FIREWALL" = 1 ]; then pkgs="$pkgs ufw"; fi
	# rclone comes as a zip.
	if [ "$HAS_AGENT" = 1 ] && [ "$WITH_STORAGE" = 1 ]; then pkgs="$pkgs unzip"; fi
	missing=
	for p in $pkgs; do
		dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"
	done
	if [ -z "$missing" ]; then skip "all packages already installed"; return; fi
	export DEBIAN_FRONTEND=noninteractive
	run "refreshed package index" apt-get update
	# shellcheck disable=SC2086
	run "installed:$missing" apt-get install -y --no-install-recommends $missing

	# Debian starts its own haproxy.service on install. In dedicated mode that one is not ours to run.
	if [ "$HAPROXY_MODE" = dedicated ] && [ "$DRY_RUN" != 1 ] && echo "$missing" | grep -qw haproxy; then
		run "turned off the stock haproxy.service (Freighter has its own)" systemctl disable --now haproxy
	fi
}

# ---------- 3. Node.js ----------
# From nodejs.org, checksum-verified, into /opt/node-<version> with symlinks in /usr/local/bin: independent of
# whatever the distribution packages and of NodeSource.
install_node() {
	step "Installing Node.js $NODE_MAJOR"
	if have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; then
		skip "node $(node --version) is already installed"
		NODE_BIN=$(command -v node)
		return
	fi
	[ "$DRY_RUN" = 1 ] && { printf '  %s$%s %sdownload + verify node v%s.x linux-%s from nodejs.org%s\n' "$DIM" "$RST" "$DIM" "$NODE_MAJOR" "$NODE_ARCH" "$RST"; NODE_BIN=/usr/local/bin/node; return; }

	base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
	sums=$($DL "$base/SHASUMS256.txt") || die "could not fetch $base/SHASUMS256.txt"
	file=$(printf '%s\n' "$sums" | awk -v a="linux-$NODE_ARCH.tar.xz" '$2 ~ a"$" {print $2}')
	[ -n "$file" ] || die "no Node $NODE_MAJOR build for linux-$NODE_ARCH on nodejs.org."
	want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')
	ver=${file#node-}; ver=${ver%-linux-*}

	tmp=$(mktemp -d)
	$DL "$base/$file" >"$tmp/$file" || die "download of $file failed."
	got=$(sha256sum "$tmp/$file" | awk '{print $1}')
	[ "$got" = "$want" ] || die "checksum mismatch for $file (expected $want, got $got); refusing to install it."

	dest="/opt/node-$ver"
	rm -rf "$dest"; mkdir -p "$dest"
	tar -xJf "$tmp/$file" -C "$dest" --strip-components=1
	rm -rf "$tmp"
	for b in node npm npx corepack; do ln -sf "$dest/bin/$b" "/usr/local/bin/$b"; done
	NODE_BIN=/usr/local/bin/node
	ok "node $ver -> /usr/local/bin/node ($(printf '%s' "$got" | cut -c1-12)… verified)"
}

# ---------- 3b. rclone, for S3 storages ----------
# `rclone serve s3` needs 1.65 or newer, which the distributions' packages are not, so the upstream release is installed,
# checked against the checksums published next to it.
RCLONE_VERSION=1.68.2
install_rclone() {
	[ "$HAS_AGENT" = 1 ] && [ "$WITH_STORAGE" = 1 ] || return 0
	step "Installing rclone $RCLONE_VERSION (S3 storage)"
	if [ -x /usr/local/bin/rclone ] && /usr/local/bin/rclone version 2>/dev/null | awk 'NR==1 {split(substr($2,2),v,"."); exit !((v[1]+0>1) || (v[1]+0==1 && v[2]+0>=65))}'; then
		skip "$(/usr/local/bin/rclone version | head -n1) is already installed"
		return
	fi
	[ "$DRY_RUN" = 1 ] && { printf '  %s$%s %sdownload + verify rclone v%s linux-%s from downloads.rclone.org%s\n' "$DIM" "$RST" "$DIM" "$RCLONE_VERSION" "$NODE_ARCH" "$RST"; return; }

	case $NODE_ARCH in x64) rarch=amd64 ;; *) rarch=$NODE_ARCH ;; esac
	base="https://downloads.rclone.org/v$RCLONE_VERSION"
	file="rclone-v$RCLONE_VERSION-linux-$rarch.zip"
	sums=$($DL "$base/SHA256SUMS") || die "could not fetch $base/SHA256SUMS"
	want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')
	[ -n "$want" ] || die "no rclone $RCLONE_VERSION build for linux-$rarch on downloads.rclone.org."

	tmp=$(mktemp -d)
	$DL "$base/$file" >"$tmp/$file" || die "download of $file failed."
	got=$(sha256sum "$tmp/$file" | awk '{print $1}')
	[ "$got" = "$want" ] || die "checksum mismatch for $file (expected $want, got $got); refusing to install it."
	unzip -q -j "$tmp/$file" '*/rclone' -d "$tmp" || die "could not unpack $file."
	install -m 0755 "$tmp/rclone" /usr/local/bin/rclone
	rm -rf "$tmp"
	ok "rclone $RCLONE_VERSION -> /usr/local/bin/rclone ($(printf '%s' "$got" | cut -c1-12)… verified)"
}

# ---------- 4. user, group, directories ----------
create_user_and_dirs() {
	step "Creating the freighter user and directories"
	if getent passwd freighter >/dev/null; then
		skip "user freighter exists"
	else
		run "created system user freighter" useradd --system --home-dir /var/lib/freighter --shell /usr/sbin/nologin freighter
	fi
	# `useradd --system` makes a same-named group on Debian; make sure for the agent-only case too.
	getent group freighter >/dev/null || run "created group freighter" groupadd --system freighter

	if [ "$DRY_RUN" = 1 ]; then
		printf '  %s$%s %sinstall -d /var/lib/freighter /srv/apps /etc/freighter{,/apps,/agent}%s\n' "$DIM" "$RST" "$DIM" "$RST"; return
	fi
	if [ "$ROLE" = control ] && [ "$HAS_AGENT" = 0 ]; then
		install -d -o freighter -g freighter -m 0755 /var/lib/freighter
		install -d -o freighter -g freighter -m 0750 /var/lib/freighter/artifacts   # uploads wait here on their way to a server
		install -d -m 0755 /etc/freighter
		ok "/var/lib/freighter, /etc/freighter"
		return
	elif [ "$ROLE" = control ]; then
		install -d -o freighter -g freighter -m 0755 /var/lib/freighter
		install -d -o root -g freighter -m 0770 /var/lib/freighter/artifacts
	else
		install -d -m 0750 -g freighter /var/lib/freighter
		install -d -m 0750 -g freighter /var/lib/freighter/artifacts
	fi
	install -d -m 0755 /srv/apps /etc/freighter /etc/freighter/apps /etc/freighter/agent
	ok "/var/lib/freighter, /srv/apps, /etc/freighter"
}

# ---------- 5. fetch + build Freighter ----------
install_freighter() {
	step "Installing Freighter ($REF) into $DIR"
	if [ -n "$FROM" ]; then
		[ -d "$FROM/apps/cli" ] || die "--from $FROM does not look like a Freighter checkout."
		if [ "$DRY_RUN" = 1 ]; then printf '  %s$%s %scopy %s -> %s%s\n' "$DIM" "$RST" "$DIM" "$FROM" "$DIR" "$RST"
		else
			mkdir -p "$DIR"
			tar -C "$FROM" --exclude=.git --exclude=node_modules --exclude=.output --exclude=.nuxt -cf - . | tar -C "$DIR" -xf -
			ok "copied $FROM"
		fi
	elif [ -d "$DIR/.git" ]; then
		run "fetched $REF" git -C "$DIR" fetch --quiet --depth 1 origin "$REF"
		run "checked out $REF" git -C "$DIR" checkout --quiet --force FETCH_HEAD
	else
		[ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ] || die "$DIR exists and is not a Freighter checkout; move it or pass --dir."
		run "cloned $REPO_URL" git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$DIR"
	fi

	if [ "$DRY_RUN" = 1 ]; then printf '  %s$%s %scorepack enable && pnpm install --frozen-lockfile%s\n' "$DIM" "$RST" "$DIM" "$RST"
	else
		export PATH="/usr/local/bin:$PATH"
		run "enabled corepack (pnpm)" corepack enable
		# pnpm is fetched by corepack on first use; a CI-style non-interactive install avoids download prompts.
		COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 run "installed dependencies" sh -c "cd '$DIR' && pnpm install --frozen-lockfile"
	fi
	# Everything is built to plain JavaScript and run with node; no TypeScript runs on the server.
	builds="@freighter/cli"
	[ "$HAS_AGENT" = 0 ] || builds="$builds @freighter/agent"
	[ "$ROLE" != control ] || builds="$builds @freighter/dashboard"
	if [ "$DRY_RUN" = 1 ]; then printf '  %s$%s %spnpm --filter %s build%s\n' "$DIM" "$RST" "$DIM" "$(echo "$builds" | sed 's/ / --filter /g')" "$RST"
	else
		for b in $builds; do CI=1 run "built $b" sh -c "cd '$DIR' && pnpm --filter $b build"; done
	fi

	# Launchers: plain node, running the built files.
	launcher() { # launcher <name> <built file>
		printf '#!/bin/sh\n[ -x "$PWD" ] && [ -r "$PWD" ] || cd /\nexec %s --enable-source-maps %s/%s "$@"\n' "$NODE_BIN" "$DIR" "$2" |
			write_file "/usr/local/bin/$1" 0755 || true
	}
	launcher freighter apps/cli/dist/cli.js
	[ "$HAS_AGENT" = 0 ] || launcher freighter-agent apps/agent/dist/main.js
}

# ---------- 6. HAProxy ----------
# Freighter never edits an haproxy.cfg you own. It owns /etc/haproxy/freighter. Either it is loaded by the HAProxy you
# already run (existing), or by a separate instance with its own unit and config (dedicated).
setup_haproxy() {
	[ "$HAPROXY_MODE" != none ] || return 0
	step "Preparing HAProxy ($HAPROXY_MODE)"
	if [ "$DRY_RUN" = 1 ]; then
		printf '  %s$%s %screate /etc/haproxy/freighter, placeholder certificate, %s%s\n' "$DIM" "$RST" "$DIM" \
			"$([ "$HAPROXY_MODE" = dedicated ] && echo "/etc/freighter/haproxy/haproxy.cfg (ports $HTTP_PORT/$HTTPS_PORT)" || echo "EXTRAOPTS in /etc/default/haproxy")" "$RST"; return
	fi
	install -d /etc/haproxy/freighter /etc/haproxy/freighter/certs
	# Remember whose HAProxy this is: upgrades use it to know whether Freighter owns the config or the operator does.
	printf '%s\n' "$HAPROXY_MODE" >/etc/haproxy/freighter/mode
	for f in hostnames.map https.map; do [ -e "/etc/haproxy/freighter/$f" ] || : >"/etc/haproxy/freighter/$f"; done
	# The :80 rules refer to the freighter_acme backend, which HAProxy requires to exist; Freighter rewrites this file
	# (keeping that backend) on every deploy.
	if [ ! -s /etc/haproxy/freighter/backends.cfg ]; then
		printf '# Managed by freighter. Do not edit; regenerated on every deploy.\n\nbackend freighter_acme\n    server certbot 127.0.0.1:8888\n\nbackend freighter_challenge\n    http-request return status 200 content-type text/plain string "unset"\n' >/etc/haproxy/freighter/backends.cfg
	fi

	# HAProxy refuses to start with an empty `crt` directory.
	pem=/etc/haproxy/freighter/certs/placeholder.pem
	if [ ! -e "$pem" ] && ! ls /etc/haproxy/freighter/certs/*.pem >/dev/null 2>&1; then
		t=$(mktemp -d)
		openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=placeholder" -keyout "$t/k" -out "$t/c" >/dev/null 2>&1
		cat "$t/c" "$t/k" >"$pem"; chmod 600 "$pem"; rm -rf "$t"
		ok "placeholder certificate"
	else skip "certificate directory is not empty"; fi

	# A newer version's HAProxy rules can refer to backends an older backends.cfg doesn't have yet, and HAProxy refuses to
	# start on a config like that. So bring the generated backends up to date first (old rules never use the new
	# backends, so this is safe for the HAProxy that is running now), then write rules that need them.
	if [ "$HAPROXY_MODE" = dedicated ]; then hap_unit=freighter-haproxy; else hap_unit=haproxy; fi
	if systemctl is-active --quiet "$hap_unit" 2>/dev/null; then
		/usr/local/bin/freighter host haproxy sync >>"$LOG" 2>&1 || warn "could not refresh HAProxy's generated backends (see $LOG)"
	fi

	if [ "$HAPROXY_MODE" = dedicated ]; then
		# The config comes from Freighter itself, so the ports and redirects match /etc/freighter/config.yaml.
		install -d /etc/freighter/haproxy
		# Generate first: a failing `freighter` must not leave an empty config behind a pipe.
		cfg=$(/usr/local/bin/freighter host haproxy config) || die "could not generate the HAProxy config (is /etc/freighter/config.yaml valid?)"
		printf '%s\n' "$cfg" | write_file /etc/freighter/haproxy/haproxy.cfg 0644 || true
	elif [ -f /etc/default/haproxy ] && grep -q 'freighter/backends.cfg' /etc/default/haproxy; then
		skip "HAProxy already loads backends.cfg"
	elif [ -f /etc/default/haproxy ] && grep -q '^EXTRAOPTS=' /etc/default/haproxy; then
		warn "/etc/default/haproxy already sets EXTRAOPTS; add  -f /etc/haproxy/freighter/backends.cfg  to it yourself."
		HAPROXY_MANUAL=1
	else
		printf '\n# Added by the Freighter installer: load the generated backends.\nEXTRAOPTS="-S /run/haproxy-master.sock -f /etc/haproxy/freighter/backends.cfg"\n' >>/etc/default/haproxy
		ok "HAProxy loads /etc/haproxy/freighter/backends.cfg"
	fi
}

# ---------- 7. configuration + services ----------
write_config() {
	step "Writing configuration"
	if [ -e /etc/freighter/config.yaml ]; then
		skip "/etc/freighter/config.yaml exists, left alone"
		if [ "$ROLE" = control ] && [ "$HAS_AGENT" = 1 ] && ! grep -Eq '^[[:space:]]+localAgent:[[:space:]]*true' /etc/freighter/config.yaml; then
			warn "to run apps on this control server, set  api: { localAgent: true }  in it, then: systemctl restart freighter-api"
		fi
		if [ "$HAPROXY_MODE" = dedicated ]; then
			warn "make sure it has:  haproxy: { mainConfig: /etc/freighter/haproxy/haproxy.cfg, reloadCommand: [systemctl, reload, freighter-haproxy], httpPort: $HTTP_PORT, httpsPort: $HTTPS_PORT }"
		fi
		return
	fi
	{
		echo "# Host configuration. Every key is optional; see the config.yaml reference in the docs."
		if [ "$HAPROXY_MODE" = dedicated ] || [ "$HTTP_PORT" != 80 ] || [ "$HTTPS_PORT" != 443 ] || [ -n "$PUBLIC_HTTPS_PORT" ] || [ "$ACCEPT_PROXY" = 1 ]; then
			echo "haproxy:"
			if [ "$HAPROXY_MODE" = dedicated ]; then
				echo "  mainConfig: /etc/freighter/haproxy/haproxy.cfg"
				echo "  reloadCommand: [systemctl, reload, freighter-haproxy]"
			fi
			echo "  httpPort: $HTTP_PORT"
			echo "  httpsPort: $HTTPS_PORT"
			[ -z "$PUBLIC_HTTPS_PORT" ] || echo "  publicHttpsPort: $PUBLIC_HTTPS_PORT"
			[ "$ACCEPT_PROXY" = 0 ] || echo "  acceptProxy: true"
		fi
		if [ "$HAS_AGENT" = 0 ]; then :
		elif [ -n "$ACME_EMAIL" ]; then echo "acme:"; echo "  email: $ACME_EMAIL"; else echo "# acme:"; echo "#   email: ops@example.com   # required before any domain uses tls: auto"; fi
		if [ "$ROLE" = control ]; then
			echo "api:"
			if [ "$HAS_AGENT" = 1 ]; then echo "  localAgent: true    # this control server also runs apps, through its own agent"
			else echo "  localAgent: false   # this control server runs no apps; it manages remote servers"; fi
			if [ -n "$PUBLIC_URL" ]; then echo "  publicUrl: $PUBLIC_URL"; else echo "  # publicUrl: https://freighter.example.com"; fi
		fi
	} | write_file /etc/freighter/config.yaml 0644 || true
}

install_units() {
	step "Installing systemd services"
	src="$DIR/infra/systemd"
	[ "$DRY_RUN" = 1 ] && [ ! -d "$src" ] && src=${FROM:+$FROM/infra/systemd}
	units=
	[ "$HAS_AGENT" = 0 ] || units="freighter-agent.service freighter-renew.service freighter-renew.timer"
	[ "$ROLE" = control ] && units="$units freighter-api.service"
	[ "$HAPROXY_MODE" = dedicated ] && units="$units freighter-haproxy.service"
	changed=0
	for u in $units; do
		[ -f "$src/$u" ] || { [ "$DRY_RUN" = 1 ] && { skip "$u (not fetched yet in dry-run)"; continue; }; die "missing $src/$u"; }
		# The shipped API unit expects a copied build; run it straight from the checkout and use the node we installed.
		sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$DIR/apps/dashboard|" \
		    -e "s|^ExecStart=/usr/bin/node|ExecStart=$NODE_BIN|" "$src/$u" | write_file "/etc/systemd/system/$u" 0644 && changed=1
	done
	[ "$changed" = 0 ] || run "reloaded systemd" systemctl daemon-reload
}

start_services() {
	step "Starting services"
	if [ "$NO_START" = 1 ]; then skip "--no-start: not enabling or starting anything"; return; fi
	if [ "$HAPROXY_MODE" = none ]; then
		:
	elif [ "$HAPROXY_MODE" = dedicated ]; then
		run "enabled Freighter's HAProxy" systemctl enable freighter-haproxy
		run "started Freighter's HAProxy on :$HTTP_PORT and :$HTTPS_PORT" systemctl restart freighter-haproxy
	else
		run "enabled HAProxy" systemctl enable haproxy
		if [ "$DRY_RUN" != 1 ] && ! haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/freighter/backends.cfg >>"$LOG" 2>&1; then
			warn "HAProxy config does not validate yet (see $LOG). Fix it with 'freighter host haproxy setup', then: systemctl restart haproxy"
		else
			run "restarted HAProxy" systemctl restart haproxy
		fi
	fi
	if [ "$HAS_AGENT" = 1 ]; then
		run "enabled the agent" systemctl enable freighter-agent
		run "started the agent" systemctl restart freighter-agent
		run "enabled certificate renewal" systemctl enable --now freighter-renew.timer
	fi
	if [ "$ROLE" = control ]; then
		run "enabled the API and dashboard" systemctl enable freighter-api
		run "started the API and dashboard" systemctl restart freighter-api
	fi

	[ "$DRY_RUN" = 1 ] && return
	# Wait for what we started to actually answer, so "Installation complete" is true.
	if [ "$HAS_AGENT" = 1 ]; then
		i=0; until [ -S /run/freighter/agent.sock ]; do i=$((i + 1)); [ $i -le 20 ] || die "the agent did not create /run/freighter/agent.sock (journalctl -u freighter-agent)."; sleep 1; done
		ok "agent is listening on /run/freighter/agent.sock"
	fi
	if [ "$ROLE" = control ]; then
		i=0; until $DL http://127.0.0.1:3000/ >/dev/null 2>&1; do i=$((i + 1)); [ $i -le 30 ] || die "the dashboard did not come up on 127.0.0.1:3000 (journalctl -u freighter-api)."; sleep 1; done
		ok "dashboard is answering on 127.0.0.1:3000"
	fi
}

# ---------- 8. what next ----------
summary() {
	printf '\n%sFreighter %s server installed%s%s\n' "$GRN$B" "$ROLE" "$RST" "$([ "$DRY_RUN" = 1 ] && printf ' (dry run: nothing was changed)')"
	printf '\nNext steps:\n'
	n=1
	if [ -z "$ACME_EMAIL" ] && [ "$HAS_AGENT" = 1 ]; then
		printf '  %d. Set the Let'"'"'s Encrypt contact before using tls: auto:\n       edit /etc/freighter/config.yaml  ->  acme.email\n' $n; n=$((n + 1))
	fi
	if [ "$HAPROXY_MODE" = none ]; then
		:
	elif [ "$HAPROXY_MODE" = dedicated ]; then
		printf '  %d. Freighter'"'"'s HAProxy listens on :%s (HTTP) and :%s (HTTPS).\n' $n "$HTTP_PORT" "$HTTPS_PORT"; n=$((n + 1))
		if [ "$HTTP_PORT" != 80 ] || [ "$HTTPS_PORT" != 443 ]; then
			printf '       Point your reverse proxy at them: public :80 -> :%s, public :443 -> :%s.\n       Let'"'"'s Encrypt validates over public :80, so it must reach :%s. See "Behind your own reverse proxy" in the docs.\n' "$HTTP_PORT" "$HTTPS_PORT" "$HTTP_PORT"
		fi
	else
		printf '  %d. Connect your HAProxy (Freighter does not edit your haproxy.cfg):\n       freighter host haproxy setup\n' $n; n=$((n + 1))
	fi
	if [ "$ROLE" = control ] && [ "$HAS_AGENT" = 0 ]; then
		printf '  %d. Create the first admin token:\n       sudo -u freighter freighter host token create admin --role admin\n' $n; n=$((n + 1))
		printf '  %d. Publish the dashboard (127.0.0.1:3000) through your reverse proxy, with HTTPS.\n' $n; n=$((n + 1))
		printf '  %d. Add the servers that will run your apps (Servers -> Add server), then enroll each:\n       freighter login https://<dashboard>; freighter server add <name> --address <host>\n' $n
	elif [ "$ROLE" = control ]; then
		printf '  %d. Create the first admin token%s:\n       sudo -u freighter freighter host token create admin --role admin\n' $n "$([ "$HAPROXY_MODE" = existing ] && echo ", then publish 127.0.0.1:3000 through HAProxy" || echo ", then publish 127.0.0.1:3000 as your dashboard hostname")"
	else
		printf '  %d. Allow only the control server to reach the agent:\n       ufw allow from <control-server-ip> to any port 7443 proto tcp\n' $n; n=$((n + 1))
		printf '  %d. On the control server add this server, then run the printed command here:\n       freighter server add <name> --address <this-host>\n       freighter-agent enroll --control URL --token fre_... --ca-fingerprint SHA256:...\n       systemctl restart freighter-agent\n' $n
	fi
	[ "${HAPROXY_MANUAL:-0}" = 0 ] || printf '\n  %s!%s add  -f /etc/haproxy/freighter/backends.cfg  to EXTRAOPTS in /etc/default/haproxy\n' "$YLW" "$RST"
	[ "$DRY_RUN" = 1 ] || printf '\nInstall log: %s\n' "$LOG"
}

main() {
	ROLE=${FREIGHTER_ROLE:-control}; REF=${FREIGHTER_REF:-main}; FROM=${FREIGHTER_FROM:-}; DIR=${FREIGHTER_DIR:-/opt/freighter}
	ACME_EMAIL=${FREIGHTER_ACME_EMAIL:-}; PUBLIC_URL=${FREIGHTER_PUBLIC_URL:-}; NODE_MAJOR=${FREIGHTER_NODE_MAJOR:-24}
	HAPROXY_MODE=${FREIGHTER_HAPROXY:-auto}; HTTP_PORT=${FREIGHTER_HTTP_PORT:-80}; HTTPS_PORT=${FREIGHTER_HTTPS_PORT:-443}; PUBLIC_HTTPS_PORT=${FREIGHTER_PUBLIC_HTTPS_PORT:-}; ACCEPT_PROXY=0
	HAS_AGENT=0; [ "${FREIGHTER_WITH_AGENT:-0}" = 1 ] && HAS_AGENT=1
	WITH_CONTAINERS=0; [ "${FREIGHTER_WITH_CONTAINERS:-0}" = 1 ] && WITH_CONTAINERS=1
	WITH_STORAGE=0; [ "${FREIGHTER_WITH_STORAGE:-0}" = 1 ] && WITH_STORAGE=1
	WITH_MOUNTS=0; [ "${FREIGHTER_WITH_MOUNTS:-0}" = 1 ] && WITH_MOUNTS=1
	WITH_ARCHIVES=0; [ "${FREIGHTER_WITH_ARCHIVES:-0}" = 1 ] && WITH_ARCHIVES=1
	WITH_FIREWALL=0; [ "${FREIGHTER_WITH_FIREWALL:-0}" = 1 ] && WITH_FIREWALL=1
	NO_START=0; DRY_RUN=0; HAPROXY_MANUAL=0; DL=; NODE_BIN=; NODE_ARCH=

	while [ $# -gt 0 ]; do
		case $1 in
			--role) ROLE=${2:?--role needs a value}; shift 2 ;;
			--ref) REF=${2:?--ref needs a value}; shift 2 ;;
			--from) FROM=${2:?--from needs a directory}; shift 2 ;;
			--dir) DIR=${2:?--dir needs a directory}; shift 2 ;;
			--email) ACME_EMAIL=${2:?--email needs an address}; shift 2 ;;
			--public-url) PUBLIC_URL=${2:?--public-url needs a URL}; shift 2 ;;
			--node-version) NODE_MAJOR=${2:?--node-version needs a major version}; shift 2 ;;
			--haproxy) HAPROXY_MODE=${2:?--haproxy needs auto, dedicated or existing}; shift 2 ;;
			--http-port) HTTP_PORT=${2:?--http-port needs a number}; shift 2 ;;
			--https-port) HTTPS_PORT=${2:?--https-port needs a number}; shift 2 ;;
			--public-https-port) PUBLIC_HTTPS_PORT=${2:?--public-https-port needs a number}; shift 2 ;;
			--accept-proxy) ACCEPT_PROXY=1; shift ;;
			--with-agent) HAS_AGENT=1; shift ;;
			--with-containers) WITH_CONTAINERS=1; shift ;;
			--with-storage) WITH_STORAGE=1; shift ;;
			--with-mounts) WITH_MOUNTS=1; shift ;;
			--with-archives) WITH_ARCHIVES=1; shift ;;
			--with-firewall) WITH_FIREWALL=1; shift ;;
			--no-agent) HAS_AGENT=0; shift ;; # the default; kept for scripts written before it was
			--no-start) NO_START=1; shift ;;
			--dry-run) DRY_RUN=1; shift ;;
			-h|--help) usage; exit 0 ;;
			*) die "unknown option: $1 (see --help)" ;;
		esac
	done
	case $ROLE in control|agent) ;; *) die "--role must be 'control' or 'agent'." ;; esac
	[ "$ROLE" != agent ] || HAS_AGENT=1 # a remote server is its agent
	[ "$HAS_AGENT" = 1 ] || HAPROXY_MODE=none
	case $HAPROXY_MODE in none|auto|dedicated|existing) ;; *) die "--haproxy must be auto, dedicated or existing." ;; esac
	for pv in "$HTTP_PORT" "$HTTPS_PORT" "$PUBLIC_HTTPS_PORT"; do
		case $pv in ''|*[!0-9]*) [ -z "$pv" ] && continue; die "ports must be numbers, got '$pv'." ;; esac
		[ "$pv" -ge 1 ] && [ "$pv" -le 65535 ] || die "port out of range: $pv."
	done
	[ "$HTTP_PORT" != "$HTTPS_PORT" ] || die "--http-port and --https-port must differ."
	case $NODE_MAJOR in ''|*[!0-9]*) die "--node-version must be a major version number, e.g. 24." ;; esac
	case $ACME_EMAIL in *[!A-Za-z0-9.@_+-]*) die "--email contains unexpected characters." ;; esac
	case $PUBLIC_URL in *[!A-Za-z0-9:/._-]*) die "--public-url contains unexpected characters." ;; esac

	if [ "$DRY_RUN" = 1 ]; then LOG=/dev/null; else mkdir -p "$(dirname "$LOG")" 2>/dev/null || true; : >"$LOG" 2>/dev/null || LOG=/dev/null; fi
	printf '%sFreighter installer%s  role=%s ref=%s dir=%s%s\n' "$B" "$RST" "$ROLE" "$REF" "$DIR" "$([ "$DRY_RUN" = 1 ] && printf '  [dry run]')"

	preflight
	detect_haproxy_mode
	install_packages
	install_node
	install_rclone
	create_user_and_dirs
	install_freighter
	write_config
	setup_haproxy
	install_units
	start_services
	summary
}

main "$@"
