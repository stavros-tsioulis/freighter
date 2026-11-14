// `curl -fsSL https://freighter.example.com/install-cli | sh`: installs the `freighter` CLI that matches this server.
// The CLI itself is /cli/freighter.mjs, bundled into the dashboard's files when it is built.
export default defineEventHandler((event) => {
  const origin = getRequestURL(event, { xForwardedProto: true, xForwardedHost: true }).origin;
  setResponseHeader(event, "content-type", "text/x-shellscript; charset=utf-8");
  setResponseHeader(event, "cache-control", "no-store");
  return `#!/bin/sh
# Installs the freighter CLI from ${origin}
set -eu
URL="${origin}/cli/freighter.mjs"
BIN="\${FREIGHTER_BIN:-\$HOME/.local/bin}"
LIB="\${FREIGHTER_LIB:-\$HOME/.local/share/freighter}"

command -v node >/dev/null 2>&1 || { echo "freighter needs Node.js 24 or newer: https://nodejs.org" >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "freighter needs Node.js 24 or newer (this is $(node -v))" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is needed to install freighter" >&2; exit 1; }

mkdir -p "$BIN" "$LIB"
curl -fsSL "$URL" -o "$LIB/cli.mjs.tmp"
mv "$LIB/cli.mjs.tmp" "$LIB/cli.mjs"
printf '#!/bin/sh\\nexec node "%s" "$@"\\n' "$LIB/cli.mjs" > "$BIN/freighter"
chmod +x "$BIN/freighter"

echo "Installed freighter in $BIN"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add it to your PATH:  export PATH=\\"$BIN:\\$PATH\\"" ;; esac
echo "Next: freighter login ${origin}"
`;
});
