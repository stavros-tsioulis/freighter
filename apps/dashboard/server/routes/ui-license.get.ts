/**
 * The PrimeUI license key, read from the environment each time it is asked for. The app shell is prerendered at build
 * time, so a key set on the running service (a systemd `Environment=`, Railway's Variables tab) can't reach the page
 * through the runtime config; the page asks for it here before it starts. It isn't a secret from the browser: PrimeUI
 * checks it there, offline, so every visitor's browser gets it anyway.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, "cache-control", "no-store");
  return { license: process.env.PRIMEUI_LICENSE?.trim() ?? "" };
});
