// Safe extraction of a human-readable message from an unknown thrown value.
// `catch (err)` gives us `unknown`; in practice it's almost always Error,
// but node can surface strings, numbers, or anything else, in which case
// `(err as Error).message` is undefined and our WS replies become
// "list-sessions: undefined". Funnel everything through this helper.
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return String(err); } catch { return 'unknown error'; }
}
