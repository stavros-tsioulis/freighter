import Aura from "@primeuix/themes/aura";
import { definePreset } from "@primeuix/themes";
import tailwindcss from "@tailwindcss/vite";

// "Harbor": cool fog/ink neutrals with one cobalt accent reserved for actions and links.
// Green / amber / red stay semantic and are only used for status.
const cobalt = { 50: "#eef0fc", 100: "#dadff9", 200: "#b6c0f3", 300: "#95a3f0", 400: "#7183ea", 500: "#2e46c8", 600: "#2538a6", 700: "#1e2e86", 800: "#18246a", 900: "#121b50", 950: "#0b1133" };
const harbor = { 0: "#ffffff", 50: "#f4f6f7", 100: "#ebeef0", 200: "#dce1e5", 300: "#c3cbd2", 400: "#96a1ab", 500: "#6b7783", 600: "#505b66", 700: "#39434d", 800: "#232d37", 900: "#18212a", 950: "#0f161d" };

const Freighter = definePreset(Aura, {
  primitive: { borderRadius: { none: "0", xs: "2px", sm: "3px", md: "5px", lg: "8px", xl: "10px" } },
  semantic: {
    primary: cobalt,
    colorScheme: {
      light: {
        surface: harbor,
        primary: { color: "{primary.500}", contrastColor: "#ffffff", hoverColor: "{primary.600}", activeColor: "{primary.700}" },
        text: { color: "{surface.900}", mutedColor: "{surface.600}", hoverColor: "{surface.950}" },
        content: { borderColor: "{surface.200}" },
      },
      dark: {
        surface: harbor,
        primary: { color: "{primary.400}", contrastColor: "{surface.950}", hoverColor: "{primary.300}", activeColor: "{primary.200}" },
        text: { color: "#e3e8ed", mutedColor: "{surface.400}", hoverColor: "#ffffff" },
        content: { background: "{surface.900}", borderColor: "{surface.800}" },
        overlay: { modal: { background: "{surface.900}" }, popover: { background: "{surface.900}" }, select: { background: "{surface.900}" } },
      },
    },
  },
});

export default defineNuxtConfig({
  compatibilityDate: "2026-11-01",
  // The dashboard sits behind a login and talks to /api, so it is a plain SPA.
  ssr: false,
  devtools: { enabled: false },
  modules: ["@primevue/nuxt-module"],
  css: ["primeicons/primeicons.css", "~/assets/css/main.css"],
  vite: { plugins: [tailwindcss()] },
  primevue: {
    options: {
      theme: {
        preset: Freighter,
        options: {
          darkModeSelector: ".app-dark",
          cssLayer: { name: "primevue", order: "theme, base, primevue" },
        },
      },
    },
  },
  app: { head: { title: "Freighter", meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }] } },
  routeRules: {
    "/**": {
      headers: {
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
      },
    },
  },
});
