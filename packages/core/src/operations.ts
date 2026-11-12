/**
 * Long operations (a deploy, a build, a pull) can be asked to stop. Each registers under the id the control plane gave
 * it (the deployment's id); `cancelOperation` fires its signal, and the places that can stop cleanly look at it: the
 * commands being run are killed, and the steps check it between phases. The moment a release is being switched in
 * (units, HAProxy) is never interrupted; waiting for the new release to become healthy is, and rolls back.
 */
export class CanceledError extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledError";
  }
}

const running = new Map<string, AbortController>();

export function beginOperation(id: string | undefined): { signal: AbortSignal | undefined; end: () => void; /** Turn what a killed command threw into `canceled`. */ settle: (e: unknown) => unknown } {
  if (!id) return { signal: undefined, end: () => {}, settle: (e) => e };
  const ctl = new AbortController();
  running.set(id, ctl);
  return {
    signal: ctl.signal,
    end: () => void (running.get(id) === ctl && running.delete(id)),
    settle: (e) => (ctl.signal.aborted && !(e instanceof CanceledError) ? new CanceledError() : e),
  };
}

/** Ask the operation to stop. False when none by that id is running here. */
export function cancelOperation(id: string): boolean {
  const ctl = running.get(id);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

/** Throw if the operation was asked to stop. */
export function stopIfCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CanceledError();
}
