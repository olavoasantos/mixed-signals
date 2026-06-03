/**
 * Browser entry script for a Web Worker environment.
 *
 * Implements the eval side-channel and echoes data-channel messages.
 */

// Eval side-channel — listen for { __type__: 'eval' } on the global scope
self.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.__type__ === "eval") {
    const { code, args, __id__ } = data;
    try {
      const fn = new Function("args", `return (${code})(...args)`);
      const result = fn(args || []);
      if (result && typeof result === "object" && typeof result.then === "function") {
        result.then(
          (r: unknown) => self.postMessage({ __type__: "evalResult", __id__, result: r }),
          (e: Error) => self.postMessage({ __type__: "evalResult", __id__, error: e.message }),
        );
      } else {
        self.postMessage({ __type__: "evalResult", __id__, result });
      }
    } catch (e: any) {
      self.postMessage({ __type__: "evalResult", __id__, error: e.message });
    }
    return;
  }

  // Data channel: echo messages back
  if (data.__type__ === "echo") {
    self.postMessage({
      __type__: "echo-reply",
      payload: data.payload,
      source: "worker",
    });
  }
});
