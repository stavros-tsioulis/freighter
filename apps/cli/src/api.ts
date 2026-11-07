export const conn = {
  url: { type: "string", description: "API base URL (or $FREIGHTER_URL)" },
  token: { type: "string", description: "API token (or $FREIGHTER_TOKEN)" },
} as const;

export function client(args: { url?: string; token?: string }) {
  const base = (args.url ?? process.env.FREIGHTER_URL ?? "").replace(/\/+$/, "");
  const token = args.token ?? process.env.FREIGHTER_TOKEN;
  if (!base) throw new Error("no API URL: pass --url or set FREIGHTER_URL");
  if (!token) throw new Error("no API token: pass --token or set FREIGHTER_TOKEN");
  return async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!res.ok) throw new Error(`${res.status}: ${json.error?.message ?? res.statusText}`);
    return json;
  };
}


/** Resolve an imported key's name (or id) to its id. */
export async function keyId(call: ReturnType<typeof client>, nameOrId: string): Promise<string> {
  const { keys } = await call<{ keys: { id: string; name: string }[] }>("/ssh-keys");
  const k = keys.find((x) => x.name === nameOrId || x.id === nameOrId);
  if (!k) throw new Error(`no imported SSH key named "${nameOrId}" (see \`freighter ssh-key list\`)`);
  return k.id;
}
