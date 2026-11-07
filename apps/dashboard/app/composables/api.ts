export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Call the Freighter API (same-origin, cookie session). Errors carry the server's code and message. */
export async function api<T>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  try {
    return await $fetch<T>(`/api/v1${path}`, {
      method: (opts.method ?? "GET") as never,
      body: opts.body as never,
      query: opts.query,
      headers: { "x-requested-with": "freighter" },
    });
  } catch (e) {
    const err = e as { status?: number; statusCode?: number; data?: { error?: { code?: string; message?: string } }; message?: string };
    throw new ApiRequestError(err.status ?? err.statusCode ?? 0, err.data?.error?.code ?? "error", err.data?.error?.message ?? err.message ?? "request failed");
  }
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
