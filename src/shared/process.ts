/**
 * Resolves on the first SIGINT or SIGTERM. Keeps the event loop alive until then,
 * so the process does not exit while no other work is scheduled.
 */
export function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
    const onSignal = (signal: NodeJS.Signals) => {
      clearInterval(keepAlive);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(signal);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}
