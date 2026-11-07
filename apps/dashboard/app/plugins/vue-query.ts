import { QueryCache, QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { ApiRequestError } from "~/composables/api";

export default defineNuxtPlugin((nuxtApp) => {
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError: (e) => {
        // A session that expired (or a revoked token) sends the user back to sign in.
        if (e instanceof ApiRequestError && e.status === 401 && useRoute().path !== "/login") void navigateTo("/login");
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: (count, e) => !(e instanceof ApiRequestError && e.status >= 400 && e.status < 500) && count < 2,
      },
    },
  });
  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient: client });
  return { provide: { queryClient: client } };
});
