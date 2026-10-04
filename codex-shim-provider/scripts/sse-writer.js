// A cancelled ReadableStream can close its controller without calling our close().
// Late app-server notifications must not throw out of the JSON-RPC reader.
// HTTP cancellation does not interrupt/delete the caller's upstream thread.
export function createSseWriter(controller) {
  const encoder = new TextEncoder();
  let closed = false;
  const invalidState = error => error?.code === 'ERR_INVALID_STATE' && error instanceof TypeError;
  return {
    get closed() { return closed; },
    cancel() { closed = true; },
    write(text) {
      if (closed) return false;
      try { controller.enqueue(encoder.encode(text)); return true; }
      catch (error) {
        if (!invalidState(error)) throw error;
        closed = true;
        return false;
      }
    },
    close() {
      if (closed) return false;
      closed = true; // before controller.close(), including reentrant callbacks
      try { controller.close(); return true; }
      catch (error) { if (!invalidState(error)) throw error; return false; }
    },
  };
}
