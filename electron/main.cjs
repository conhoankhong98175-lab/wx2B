const { app, BrowserWindow, safeStorage, shell, session } = require('electron');
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { resolveApplicationRoot, resolveServerEntryUrl } = require('./paths.cjs');
const { getOrCreateLocalSecret } = require('./secret.cjs');

let mainWindow = null;
let runningServer = null;

function getPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function createWindow() {
  const smokeTest = process.argv.includes('--smoke-test');
  const smokeScreenshot = process.argv.includes('--smoke-screenshot');
  const userDataPath = app.getPath('userData');
  const databasePath = join(userDataPath, 'data', 'diangao.db');
  const port = await getPort();
  const secret = getOrCreateLocalSecret(userDataPath, { databasePath, safeStorage });
  process.env.NODE_ENV = 'production';
  process.env.DIANGAO_MODE = 'desktop';
  process.env.APP_SECRET = secret;

  const applicationPath = app.getAppPath();
  const applicationRoot = resolveApplicationRoot(applicationPath);
  const serverModule = await import(resolveServerEntryUrl(applicationPath));
  runningServer = await serverModule.startServer({
    mode: 'desktop',
    isProduction: true,
    host: '127.0.0.1',
    port,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    dbPath: databasePath,
    appSecret: secret,
    pdfFontPath: join(applicationRoot, 'assets', 'fonts', 'NotoSansCJKsc-Regular.otf'),
    webRoot: join(applicationRoot, 'dist', 'web'),
    corsOrigins: [],
  });

  const localOrigin = `http://127.0.0.1:${port}`;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    show: false,
    backgroundColor: '#f3f4f0',
    title: '店告报价助手',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      webSecurity: true,
    },
  });
  mainWindow.removeMenu();
  if (!smokeTest && !smokeScreenshot) mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== localOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  await mainWindow.loadURL(localOrigin);
  if (smokeTest || smokeScreenshot) {
    const health = await globalThis.fetch(`${localOrigin}/api/health`);
    if (!health.ok) throw new Error(`Desktop health check failed: ${health.status}`);
    const login = await globalThis.fetch(`${localOrigin}/api/auth/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Desktop smoke test' }),
    });
    if (!login.ok) throw new Error(`Desktop local login failed: ${login.status}`);
    const loginBody = await login.json();
    const authorization = `Bearer ${loginBody.token}`;
    const catalogResponse = await globalThis.fetch(`${localOrigin}/api/catalog`, {
      headers: { authorization },
    });
    if (!catalogResponse.ok)
      throw new Error(`Desktop catalog check failed: ${catalogResponse.status}`);
    const catalog = await catalogResponse.json();
    const product = catalog.products.find((item) => item.formulaType === 'FIXED');
    if (!product) throw new Error('Desktop smoke test catalog has no fixed-price product');
    const validUntil = new Date();
    validUntil.setUTCDate(validUntil.getUTCDate() + 30);
    const quoteResponse = await globalThis.fetch(`${localOrigin}/api/quotes`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        customerName: '桌面发行烟测',
        customerContact: '',
        projectName: '中文路径与 PDF 验证',
        lines: [
          {
            id: randomUUID(),
            productId: product.id,
            quantity: '1',
            addOns: [],
            description: '',
          },
        ],
        orderAddOns: [],
        discountType: 'NONE',
        discountValue: '0',
        manualAdjustment: '0',
        adjustmentReason: '',
        taxMode: 'NONE',
        taxRate: '0',
        roundingMode: 'CENT',
        validUntil: validUntil.toISOString().slice(0, 10),
        deliveryPeriod: '',
        notes: '',
        terms: '',
      }),
    });
    if (!quoteResponse.ok) throw new Error(`Desktop quote check failed: ${quoteResponse.status}`);
    const quote = await quoteResponse.json();
    const publishResponse = await globalThis.fetch(
      `${localOrigin}/api/quotes/${quote.id}/publish`,
      {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmDemoPrices: true,
          confirmBelowCost: true,
          expectedCalculationHash: quote.calculationHash,
          expectedDraftRevision: quote.draftRevision,
        }),
      },
    );
    if (!publishResponse.ok)
      throw new Error(`Desktop publish check failed: ${publishResponse.status}`);
    const pdfResponse = await globalThis.fetch(
      `${localOrigin}/api/documents/${quote.id}/versions/1/pdf`,
      { headers: { authorization } },
    );
    if (
      !pdfResponse.ok ||
      !pdfResponse.headers.get('content-type')?.startsWith('application/pdf') ||
      (await pdfResponse.arrayBuffer()).byteLength < 1000
    ) {
      throw new Error(`Desktop PDF check failed: ${pdfResponse.status}`);
    }
    if (smokeScreenshot) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1800));
      const image = await mainWindow.webContents.capturePage();
      writeFileSync(join(process.cwd(), 'desktop-smoke.png'), image.toPNG());
    }
    await runningServer.close();
    runningServer = null;
    app.exit(0);
  }
}

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      await createWindow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (process.argv.includes('--smoke-test') || process.argv.includes('--smoke-screenshot')) {
        process.stderr.write(`Desktop smoke test failed: ${message}\n`);
        app.exit(1);
        return;
      }
      const { dialog } = require('electron');
      dialog.showErrorBox('店告启动失败', message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!runningServer) return;
    event.preventDefault();
    const server = runningServer;
    runningServer = null;
    server.close().finally(() => app.exit(0));
  });
}
