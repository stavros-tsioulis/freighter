import type { QueryClient } from "@tanstack/vue-query";
import type { Principal, Role } from "~/types";
import { roleAtLeast, sessionQuery } from "~/composables/queries";

declare module "#app" {
  interface PageMeta {
    /** Minimum role needed to open the page (default: any signed-in user). */
    role?: Role;
  }
}

export default defineNuxtRouteMiddleware(async (to) => {
  const client = useNuxtApp().$queryClient as QueryClient;
  let me: Principal | null = null;
  try {
    me = await client.fetchQuery(sessionQuery());
  } catch {
    me = null;
  }
  if (to.path === "/login") return me ? navigateTo("/") : undefined;
  if (!me) return navigateTo("/login");
  if (to.meta.role && !roleAtLeast(me.role, to.meta.role)) return navigateTo("/");
});
