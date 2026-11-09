// All /api/** requests are handled by the @freighter/api h3 app (routes live under /v1 and /health), or, with
// FREIGHTER_API_URL set, forwarded to another Freighter's API.
export default defineEventHandler(async (event) => {
  const remote = remoteApiUrl();
  if (remote) return proxyToRemote(event, remote);
  const { api } = await useFreighter();
  return useBase("/api", api.app.handler)(event);
});
