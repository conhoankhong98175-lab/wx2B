const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

function resolveApplicationRoot(applicationPath) {
  return applicationPath.endsWith('.asar') ? `${applicationPath}.unpacked` : applicationPath;
}

function resolveServerEntryUrl(applicationPath) {
  const applicationRoot = resolveApplicationRoot(applicationPath);
  return pathToFileURL(join(applicationRoot, 'dist', 'server', 'index.mjs')).href;
}

module.exports = { resolveApplicationRoot, resolveServerEntryUrl };
