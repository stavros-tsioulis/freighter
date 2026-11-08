#!/usr/bin/env bash
# Helper for the Freighter lab (two clean systemd "servers" in Docker). Run from anywhere.
set -euo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")"
DC="docker compose -f compose.yaml"
API=http://localhost:3000/api/v1

wait_ready() { # wait for systemd to finish booting in a container
  local svc=$1 i state=""
  for i in $(seq 1 60); do
    state=$($DC exec -T "$svc" systemctl is-system-running 2>/dev/null || true)
    case "$state" in running|degraded) return 0 ;; esac
    sleep 1
  done
  echo "$svc: systemd did not finish booting ($state). See: ./lab.sh logs $svc" >&2
  return 1
}

new_token() { # new_token <role> -> prints a fresh API token
  $DC exec -T control sudo -u freighter freighter token create --name "lab-$1-$RANDOM" --role "$1" | grep -o 'fr_[A-Za-z0-9_-]*'
}
control() { $DC exec -T control "$@"; }
demo() { control lab-git-demo "$@"; }

usage() {
  cat <<'USAGE'
usage: ./docker/lab.sh <command>

  up                 build (first time) and start both servers, wait until they are ready
  down               stop and DELETE both servers (a fresh clean start next time)
  stop | start       pause / resume without losing state
  status             systemd state of the Freighter units on both servers
  shell [control|remote]   root shell on a server (default: control)
  token [role]       create an API token on control (role: admin|deployer|viewer, default admin)
  enroll-remote      server add + enroll the "remote" server and restart its agent
  push <example|/path> [server]  upload docker/examples/<example> (or a directory inside control, e.g. /work/myapp)
                     through the API; server: local|remote (apps are pinned to their first server)
  git-demo [remote]  import the lab SSH key, create a repo on the lab's git host (control, over SSH) and deploy it;
                     with "remote" the app is built and run on the remote server instead
  git-push [app] [msg]  commit what you changed in docker/workspace/<app> (default gitdemo) and push (sends the webhook)
  smoke              run the whole walkthrough against a FRESH lab and print PASS/FAIL per step
  logs [service]     docker logs of a server (control or remote)
USAGE
}

# Poll until a command succeeds (wait_for <seconds> <command...>).
wait_for() { local n=$1 i; shift; for i in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
# Does the app behind <host>:<port> answer with text matching <regex>?
serves() { curl -s -m 3 --resolve "$1:$2:127.0.0.1" "http://$1:$2/" | grep -Eq "$3"; }
# A field of the newest deployment of an app (needs $TOK).
latest() { curl -s -H "authorization: Bearer $TOK" "$API/apps/$1/deployments?limit=1" | jq -r ".deployments[0].$2"; }
latest_is() { [ "$(latest "$1" "$2")" = "$3" ]; }

# ---- SSH-key git deploys: control doubles as the git host (sshd + user "git"; the lab key is the only one it accepts) ----
KEY_NAME=lab
api() { # api <method> <path> [json] (needs $TOK; runs inside control so the repo hosts resolve)
  control curl -sS -X "$1" -H "authorization: Bearer $TOK" -H 'content-type: application/json' ${3:+-d "$3"} "$API/$2"
}
import_key() { # idempotent: import the lab key under the name "lab"
  api GET ssh-keys | jq -e --arg n "$KEY_NAME" '.keys[] | select(.name == $n)' >/dev/null && return 0
  control freighter ssh-key import "$KEY_NAME" --file /opt/freighter-lab/lab_key --url http://localhost:3000 --token "$TOK"
}
key_id() { api GET ssh-keys | jq -r --arg n "$KEY_NAME" '.keys[] | select(.name == $n) | .id'; }
probe() { # probe branches|inspect <repo> -> JSON from the API, using the lab key
  local body
  body=$(jq -nc --arg r "$2" --arg k "$(key_id)" '{repository:$r, sshKeyId:$k, branch:"main"}')
  api POST "git/$1" "$body"
}
# Domains are configured on the app (dashboard -> app -> Domains, the API, or `freighter domain`), not in app.yaml.
# These are the hostnames the lab's example apps are served on.
lab_domain() { # lab_domain <app> -> "<hostname> <tls>" (empty for apps without one)
  case "$1" in
    hello) echo "hello.localhost off" ;;
    image-hello) echo "image-hello.localhost off" ;;
    secure) echo "secure.localhost auto" ;;
    remote-hello) echo "remote-hello.localhost off" ;;
    gitdemo) echo "gitdemo.localhost off" ;;
    gitremote) echo "gitremote.localhost off" ;;
  esac
}
set_lab_domain() { # set_lab_domain <app> [server]: idempotent; adds the domain, verifies it (.localhost needs no DNS) and waits until it is live (needs $TOK, an admin token)
  local host tls id st i q=${2:+?server=$2}
  read -r host tls <<<"$(lab_domain "$1")"
  [ -n "$host" ] || return 0
  api GET "apps/$1/domains$q" | jq -e --arg h "$host" '.domains | map(select(.status == "active") | .hostname) == [$h]' >/dev/null 2>&1 && return 0
  api POST "apps/$1/domains$q" "$(jq -nc --arg h "$host" --arg t "$tls" '{hostname:$h,service:"web",tls:$t}')" >/dev/null
  id=$(api POST "apps/$1/domains/$host/verify" | jq -r '.id // empty')
  [ -n "$id" ] || { echo "could not verify the domain of $1" >&2; return 1; }
  for i in $(seq 1 300); do
    st=$(api GET "deployments/$id" | jq -r .status)
    case "$st" in success) return 0 ;; failed) echo "setting the domain of $1 failed: $(api GET "deployments/$id" | jq -r .error)" >&2; return 1 ;; esac
    sleep 1
  done
  echo "timed out waiting for the domain of $1" >&2; return 1
}
export -f wait_for serves latest latest_is api import_key key_id control probe lab_domain set_lab_domain
export API KEY_NAME DC

# Create the repo on the lab git host, then let Freighter name the app from app.yaml, link it and deploy it.
git_demo() {
  export TOK=${FREIGHTER_TOKEN:-$(new_token admin)}
  local where=${1:-} app=gitdemo ex=git-hello host=localhost server=local r secret
  [ "$where" = remote ] && { app=gitremote; ex=git-remote; host=control; server=remote; }
  import_key || return 1
  demo init "$app" "$ex" || return 1
  r=$(api POST git/deployments "$(jq -nc --arg r "git@$host:repos/$app.git" --arg k "$(key_id)" --arg s "$server" '{repository:$r,branch:"main",sshKeyId:$k,server:$s}')")
  secret=$(jq -r .webhookSecret <<<"$r")
  if [ -z "$secret" ] || [ "$secret" = null ]; then
    echo "could not deploy $app: $(jq -r '.error.message // .' <<<"$r") (already linked? run: pnpm lab down && pnpm lab up)" >&2
    return 1
  fi
  demo secret "$app" "$secret" || return 1     # from now on every push sends the signed webhook
  set_lab_domain "$app" "$server" || return 1   # routed once the first deployment is live
  cat <<MSG

$app is linked and its first deployment is building (dashboard: http://localhost:3000, app: http://$app.localhost:$([ "$server" = remote ] && echo 8081 || echo 8080)).
Edit docker/workspace/$app/message.txt, then: ./docker/lab.sh git-push $app "my change"
MSG
}

cmd=${1:-}; shift || true
case "$cmd" in
  up)
    $DC up -d --build
    wait_ready control; wait_ready remote
    for _ in $(seq 1 30); do curl -fs http://localhost:3000/api/health >/dev/null && break; sleep 1; done
    cat <<MSG

Both servers are up.
  Dashboard / API   http://localhost:3000        (create a token first: ./docker/lab.sh token)
  Apps on control   http://<host>.localhost:8080   https://<host>.localhost:8443
  Apps on remote    http://<host>.localhost:8081   https://<host>.localhost:8444
  Git host (SSH)    git@control:repos/<name>.git   (./docker/lab.sh git-demo; key: /opt/freighter-lab/lab_key)
  Root shells       ./docker/lab.sh shell control | remote
MSG
    ;;
  down)   $DC down --remove-orphans --volumes ;;
  stop)   $DC stop ;;
  start)  $DC start; wait_ready control; wait_ready remote ;;
  status)
    for s in control remote; do
      echo "== $s: $($DC exec -T $s systemctl is-system-running 2>/dev/null || true)"
      $DC exec -T $s systemctl list-units --no-legend --no-pager 'freighter*' haproxy.service || true
    done ;;
  shell)  $DC exec "${1:-control}" bash ;;
  token)  $DC exec -T control sudo -u freighter freighter token create --name "lab-${1:-admin}" --role "${1:-admin}" ;;
  enroll-remote)
    out=$($DC exec -T control sudo -u freighter freighter server add remote --address remote --control http://control:3000)
    echo "$out"
    token=$(echo "$out" | grep -o 'fre_[A-Za-z0-9_-]*'); fp=$(echo "$out" | grep -o 'SHA256:[0-9A-F:]*')
    $DC exec -T remote freighter-agent enroll --control http://control:3000 --token "$token" --ca-fingerprint "$fp"
    $DC exec -T remote systemctl restart freighter-agent
    sleep 2
    $DC exec -T control sudo -u freighter freighter server check remote ;;
  push)
    ex=${1:?usage: push <example|/path> [server]}; server=${2:-}
    tok=${FREIGHTER_TOKEN:-$(new_token admin)}   # admin: pushing also sets the example's domain (saved before the first deploy)
    case "$ex" in /*) dir=$ex ;; *) dir=/opt/freighter-lab/examples/$ex ;; esac
    TOK=$tok set_lab_domain "$(basename "$ex")" "$server" || exit 1
    # An example that only has an app.yaml with `image:` services is deployed without an upload (the server pulls the image).
    [ -f "$dir/app.yaml" ] && [ "$($DC exec -T control ls "$dir" | tr -d '\r')" = app.yaml ] && src=$dir/app.yaml || src=$dir
    $DC exec -T control freighter push "$src" --url http://localhost:3000 --token "$tok" ${server:+--server "$server"} ;;
  git-demo) git_demo "$@" ;;
  git-push) demo push "${1:-gitdemo}" "${2:-Update from the lab}" ;;
  smoke)
    $DC down --remove-orphans >/dev/null 2>&1 || true
    "$SELF" up >/dev/null
    fails=0
    check() { # check <description> <command...>
      local d=$1; shift
      if out=$("$@" 2>&1); then echo "PASS  $d"; else echo "FAIL  $d"; echo "$out" | tail -5 | sed 's/^/        /'; fails=$((fails+1)); fi
    }
    TOK=$(new_token admin); export FREIGHTER_TOKEN=$TOK TOK
    check "dashboard answers"                          curl -fs http://localhost:3000/api/health
    check "deploy hello on control"                    "$SELF" push hello
    check "hello is served through HAProxy :8080"      serves hello.localhost 8080 "hello from the lab"
    # ---- container images: pulled by the server, run by rootless Podman, same zero-downtime release ----
    check "deploy an image app (the server pulls nginx)" "$SELF" push image-hello
    check "the image is served through HAProxy :8080"   wait_for 60 serves image-hello.localhost 8080 "Welcome to nginx"
    check "redeploy pulls the image again and swaps"    bash -c "$DC exec -T control freighter redeploy image-hello --url http://localhost:3000 --token $TOK | grep -q 'deployed image-hello'"
    check "a bad image tag fails the deploy..."         bash -c "! printf 'name: image-hello\\nservices:\\n  web:\\n    image: nginx:no-such-tag-xyz\\n' | $DC exec -T control sh -c 'cat > /tmp/bad.yaml && freighter push /tmp/bad.yaml --url http://localhost:3000 --token $TOK'"
    check "...and the working release keeps serving"    serves image-hello.localhost 8080 "Welcome to nginx"
    check "tls: auto app deploys (certbot shim)"       "$SELF" push secure
    check "http redirects to https"                    bash -c 'curl -s -o /dev/null -w "%{redirect_url}" http://secure.localhost:8080/ | grep -q "https://secure.localhost:8443"'
    check "https serves the app (self-signed)"         bash -c 'curl -sk -m 5 https://secure.localhost:8443/ | grep -q "hello over TLS"'
    check "remote enrolls over mutual TLS"             "$SELF" enroll-remote
    check "deploy remote-hello on the remote"          "$SELF" push remote-hello remote
    check "remote-hello served by the remote :8081"    serves remote-hello.localhost 8081 "hello from the remote server"
    check "remote-hello is NOT on control"             bash -c '! curl -s -m 5 http://remote-hello.localhost:8080/ | grep -q "remote server"'
    check "app stays pinned to its server"             bash -c "! $DC exec -T control freighter push /opt/freighter-lab/examples/remote-hello --url http://localhost:3000 --token $TOK --server local"
    # ---- deploy from Git over SSH: import a key -> branches -> inspect -> clone -> sandboxed build -> deploy -> webhook ----
    check "importing the lab SSH key works"            import_key
    check "the key is stored (and listed without its private half)" bash -c 'api GET ssh-keys | jq -e "(.keys | length) == 1 and (tostring | contains(\"PRIVATE\") | not)"'
    check "a private repository is unreachable without a key" bash -c '! api POST git/branches "{\"repository\":\"git@localhost:repos/gitdemo.git\"}" | jq -e ".branches"'
    demo init gitdemo git-hello
    check "branches are listed over SSH"               bash -c 'probe branches git@localhost:repos/gitdemo.git | jq -e ".defaultBranch == \"main\""'
    check "app.yaml on the branch names the app"       bash -c 'probe inspect git@localhost:repos/gitdemo.git | jq -e ".valid and .appName == \"gitdemo\""'
    check "deploy from the repository (git@localhost)" git_demo
    check "it is served, built as the sandbox user"    wait_for 120 serves gitdemo.localhost 8080 'version 1 \[built at [0-9:]+ by freighter-build\]'
    check "the deployment records the commit"          bash -c 'curl -s -H "authorization: Bearer $TOK" "$API/apps/gitdemo/deployments?limit=10" | jq -e "[.deployments[].commitSubject] | index(\"Initial commit\")"'
    demo message gitdemo "Hello from Git, version 2"
    check "the next push deploys automatically"        bash -c "'$SELF' git-push gitdemo 'Second change' && wait_for 120 serves gitdemo.localhost 8080 'version 2 \\[built at'"
    demo break gitdemo
    check "a failing build is reported as failed"      bash -c "'$SELF' git-push gitdemo 'Break the build' && wait_for 120 latest_is gitdemo status failed"
    check "...and the working version keeps serving"   serves gitdemo.localhost 8080 'version 2'
    check "a key in use cannot be deleted"             bash -c '! api DELETE "ssh-keys/$(key_id)" | jq -e ".ok"'
    check "deploy from git to the remote server (key sent over mTLS)" git_demo remote
    check "it is built and served by the remote"       wait_for 120 serves gitremote.localhost 8081 'version 1 \[built at [0-9:]+ by freighter-build\]'
    check "gitremote is NOT served by control"         bash -c '! curl -s -m 5 http://gitremote.localhost:8080/ | grep -q "version"'
    check "no private key was left behind on the servers" bash -c "! $DC exec -T control sh -c 'find /var/lib/freighter -name \"k-*\" -o -name key | grep -q .' && ! $DC exec -T remote sh -c 'find /var/lib/freighter -name \"k-*\" -o -name key | grep -q .'"
    echo
    [ $fails -eq 0 ] && echo "All checks passed." || { echo "$fails check(s) failed."; exit 1; } ;;
  logs)   $DC logs --tail 200 "${1:-control}" ;;
  *)      usage; exit 1 ;;
esac
