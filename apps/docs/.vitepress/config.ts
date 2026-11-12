import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Freighter",
  description: "Deploy apps to your own Linux servers with systemd and HAProxy. No containers.",
  lang: "en",
  cleanUrls: true,
  lastUpdated: false,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }]],
  themeConfig: {
    logo: { src: "/logo.svg", alt: "" },
    search: { provider: "local" },
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Install", link: "/install/requirements", activeMatch: "/install/" },
      { text: "Deploy", link: "/deploy/first-app", activeMatch: "/deploy/" },
      { text: "Operate", link: "/operate/dashboard", activeMatch: "/operate/" },
      { text: "Reference", link: "/reference/app-yaml", activeMatch: "/reference/" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Introduction", link: "/guide/introduction" },
          { text: "How it works", link: "/guide/how-it-works" },
          { text: "Concepts", link: "/guide/concepts" },
          { text: "Try it locally", link: "/guide/try-it" },
        ],
      },
      {
        text: "Install",
        items: [
          { text: "Requirements", link: "/install/requirements" },
          { text: "Install with the script", link: "/install/script" },
          { text: "Set up the control server (manual)", link: "/install/control-server" },
          { text: "Run it on Railway", link: "/install/railway" },
          { text: "Connect HAProxy", link: "/install/haproxy" },
          { text: "Add a remote server", link: "/install/remote-server" },
        ],
      },
      {
        text: "Deploy",
        items: [
          { text: "Your first app", link: "/deploy/first-app" },
          { text: "Deploy from Git", link: "/deploy/git" },
          { text: "Deploy images", link: "/deploy/images" },
          { text: "Build in CI", link: "/deploy/ci" },
          { text: "Domains and HTTPS", link: "/deploy/domains" },
          { text: "Environment and secrets", link: "/deploy/secrets" },
          { text: "Connections", link: "/deploy/connections" },
          { text: "Volumes", link: "/deploy/volumes" },
          { text: "S3 storage", link: "/deploy/storage" },
          { text: "Health checks and rollbacks", link: "/deploy/rollbacks" },
        ],
      },
      {
        text: "Operate",
        items: [
          { text: "The dashboard", link: "/operate/dashboard" },
          { text: "Logs and metrics", link: "/operate/logs-metrics" },
          { text: "File explorer", link: "/operate/files" },
          { text: "Processes", link: "/operate/processes" },
          { text: "Server settings", link: "/operate/server-settings" },
          { text: "Users and tokens", link: "/operate/access" },
          { text: "Security model", link: "/operate/security" },
          { text: "Troubleshooting", link: "/operate/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "app.yaml", link: "/reference/app-yaml" },
          { text: "config.yaml", link: "/reference/config-yaml" },
          { text: "CLI", link: "/reference/cli" },
          { text: "HTTP API", link: "/reference/api" },
          { text: "Files and paths", link: "/reference/paths" },
        ],
      },
    ],
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },
  },
});
