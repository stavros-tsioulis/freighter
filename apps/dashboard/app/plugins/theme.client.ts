const KEY = "freighter-theme";

/** Apply the saved theme (or the OS preference) before the first paint of the app. */
export default defineNuxtPlugin(() => {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage unavailable */
  }
  const dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("app-dark", dark);
});
