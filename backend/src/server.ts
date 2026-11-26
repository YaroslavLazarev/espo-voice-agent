import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { buildApp } from './app.ts';

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
// Serve the production frontend build when it exists (Docker); `npm run dev` uses Vite instead.
const frontendDist = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
const app = await buildApp(config, existsSync(frontendDist) ? { staticDir: frontendDist } : {});

const shutdown = (): void => {
  void app.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
