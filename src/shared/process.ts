/**
 * Resolves with the reason the process should stop: a SIGINT/SIGTERM signal, or
 * the settlement of `stopped` (e.g. a background loop that ended). Keeps the
 * event loop alive until then.
 */
export function waitForShutdown(stopped?: Promise<string>): Promise<string> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
    const finish = (reason: string) => {
      clearInterval(keepAlive);
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve(reason);
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
    stopped?.then(finish, () => finish('background task failed'));
  });
}
