import { win32 } from 'node:path';

export function validateDevToolsPort(value) {
  if (value === '') return '';
  if (!/^\d+$/.test(value)) return '开发者工具服务端口必须是整数';
  const port = Number(value);
  if (port < 1024 || port > 65535) return '开发者工具服务端口必须在 1024 到 65535 之间';
  return '';
}

export function validateCliTimeout(value) {
  if (!/^\d+$/.test(value)) return '开发者工具 CLI 超时必须是整数毫秒数';
  const timeout = Number(value);
  if (timeout < 1_000 || timeout > 1_800_000) {
    return '开发者工具 CLI 超时必须在 1000 到 1800000 毫秒之间';
  }
  return '';
}

export function withDevToolsPort(args, port) {
  return port ? [...args, '--port', port] : args;
}

export function resolveDevToolsInvocation(cliPath, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(cliPath)) {
    return { command: cliPath, prefixArgs: [] };
  }
  const directory = win32.dirname(cliPath);
  return {
    command: win32.resolve(directory, 'node.exe'),
    prefixArgs: [win32.resolve(directory, 'cli.js')],
  };
}
