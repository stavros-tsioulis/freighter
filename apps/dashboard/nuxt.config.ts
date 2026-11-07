import Aura from "@primeuix/themes/aura";
import { definePreset } from "@primeuix/themes";
import tailwindcss from "@tailwindcss/vite";

// Steel-blue neutrals with a single deep-teal accent; status colours stay semantic (green / amber / red).
const Freighter = definePreset(Aura, {
  semantic: {
    primary: { 50: "{cyan.50}", 100: "{cyan.100}", 200: "{cyan.200}", 300: "{cyan.300}", 400: "{cyan.400}", 500: "{cyan.600}", 600: "{cyan.700}", 700: "{cyan.800}", 800: "{cyan.900}", 900: "{cyan.950}", 950: "{cyan.950}" },
    colorScheme: {
      light: { surface: { 0: "#ffffff", 50: "{slate.50}", 100: "{slate.100}", 200: "{slate.200}", 300: "{slate.300}", 400: "{slate.400}", 500: "{slate.500}", 600: "{slate.600}", 700: "{slate.700}", 800: "{slate.800}", 900: "{slate.900}", 950: "{slate.950}" } },
      dark: { surface: { 0: "#ffffff", 50: "{slate.50}", 100: "{slate.100}", 200: "{slate.200}", 300: "{slate.300}", 400: "{slate.400}", 500: "{slate.500}", 600: "{slate.600}", 700: "{slate.700}", 800: "{slate.800}", 900: "{slate.900}", 950: "{slate.950}" } },
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
