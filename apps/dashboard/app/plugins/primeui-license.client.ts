import { registerLicense } from "@primeui/license-manager";

const KEY = "freighter-primeui-license";

/**
 * Hand PrimeVue its license key, from the `PRIMEUI_LICENSE` environment variable of the running dashboard. This has to
 * run before PrimeVue starts (it checks the key once, at start-up), hence `enforce: "pre"` and waiting for the answer.
 * The last key is kept in the browser so the app still starts offline (it is a PWA).
 */
export default defineNuxtPlugin({
  name: "primeui-license",
  enforce: "pre",
  async setup() {
    let license = "";
    try {
      const res = await fetch("/ui-license", { cache: "no-store", signal: AbortSignal.timeout(2500) });
      if (res.ok) license = String(((await res.json()) as { license?: unknown }).license ?? "").trim();
      try {
        if (license) localStorage.setItem(KEY, license);
        else localStorage.removeItem(KEY);
      } catch {
        /* storage unavailable */
      }
    } catch {
      try {
        license = localStorage.getItem(KEY) ?? "";
      } catch {
        /* storage unavailable */
      }
    }
    if (license) registerLicense({ primeui: license });
  },
});
