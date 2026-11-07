// All /api/** requests are handled by the @freighter/api h3 app (routes live under /v1 and /health).
export default defineEventHandler(async (event) => {
  const { api } = await useFreighter();
  return useBase("/api", api.app.handler)(event);
});
