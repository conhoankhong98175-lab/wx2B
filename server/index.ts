import { serve, type ServerType } from '@hono/node-server';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp } from './app.ts';
import { config, type AppConfig } from './config.ts';
import { AppDatabase } from './database.ts';

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(overrides: Partial<AppConfig> = {}): Promise<RunningServer> {
  const appConfig: AppConfig = { ...config, ...overrides };
  const database = new AppDatabase(appConfig.dbPath, appConfig.appSecret);
  const app = createApp(database, appConfig);
  let server: ServerType;
  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: appConfig.host, port: appConfig.port }, () =>
      resolve(),
    );
    server.once('error', reject);
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    database.close();
  };
  return { url: `http://${appConfig.host}:${appConfig.port}`, close };
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (process.env.VITEST !== 'true' && import.meta.url === entryPath) {
  const running = await startServer();
  console.log(`店告服务已启动：${running.url}`);
  const shutdown = async (): Promise<void> => {
    await running.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
