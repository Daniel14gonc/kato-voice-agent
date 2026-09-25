import WebSocket from 'ws';

/** How long to wait for a polite close before pulling the plug. */
const FORCE_CLOSE_MS = 3_000;

/**
 * Releases a WebSocket for good.
 *
 * Dropping the reference is not enough. A socket still CONNECTING ignores
 * `close()` until it opens, and one whose close handshake the server never
 * answers sits in CLOSING indefinitely — either way the provider still counts
 * it as a live session. That is how a few listen/cancel cycles were enough to
 * trip Soniox's org-wide concurrent-session limit with a 429.
 */
export function releaseSocket(
  ws: WebSocket | undefined,
  options: { farewell?: (ws: WebSocket) => void } = {},
): void {
  if (!ws) {
    return;
  }
  // Detach first: a late frame from a socket we are done with would otherwise
  // land in the next utterance.
  ws.removeAllListeners();
  // `ws` re-throws errors as an uncaught EventEmitter error when nothing is
  // listening, which would take the extension host down with it.
  ws.on('error', () => {});
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSED) {
    ws.terminate();
    return;
  }
  if (ws.readyState === WebSocket.OPEN && options.farewell) {
    try {
      options.farewell(ws);
    } catch {
      // the socket died between the readyState check and the send
    }
  }
  ws.close();
  const timer = setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      // already gone
    }
  }, FORCE_CLOSE_MS);
  // Never keep the host alive just to wait for someone else's hang-up.
  timer.unref?.();
  ws.on('close', () => clearTimeout(timer));
}
