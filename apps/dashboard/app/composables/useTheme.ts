const KEY = "freighter-theme";

export function useTheme() {
  const dark = useState("theme-dark", () => (import.meta.client ? document.documentElement.classList.contains("app-dark") : false));
  function toggle() {
    dark.value = !dark.value;
    document.documentElement.classList.toggle("app-dark", dark.value);
    try {
      localStorage.setItem(KEY, dark.value ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  }
  return { dark, toggle };
}
