import { join } from 'node:path';
import { startProdServer } from 'vinext/server/prod-server';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}

const { server } = await startProdServer({
  host: process.env.HOST ?? '0.0.0.0',
  port,
  outDir: join(import.meta.dirname, 'dist'),
});

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 25_000).unref();
  });
}
