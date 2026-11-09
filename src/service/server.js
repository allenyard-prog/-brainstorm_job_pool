import { serviceConfig } from './config.js';
import { buildService } from './app.js';

let app;
async function main() {
  const config = serviceConfig();
  app = await buildService(config);
  const stop = () => app.close().catch(() => { process.exitCode = 1; });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await app.listen({ host: config.host, port: config.port });
  console.log(`Job automation API: ${config.origin}\nOpenAPI documentation: ${config.origin}/docs`);
}
main().catch(async error => { console.error(error.message); await app?.close(); process.exitCode = 1; });
