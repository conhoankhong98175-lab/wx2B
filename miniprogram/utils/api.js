const config = require('../config');

const TOKEN_KEY = 'diangao_access_token';
let loginPromise = null;

function restoreSession() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({ success: resolve, fail: reject });
  });
}

function rawRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const token = options.public ? '' : restoreSession();
    wx.request({
      url: `${config.apiBaseUrl}/api${path}`,
      method: options.method || 'GET',
      data: options.data,
      timeout: options.timeout || 15000,
      header: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.header || {}),
      },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        const error = new Error(
          response.data?.error?.message || `请求失败（${response.statusCode}）`,
        );
        error.code = response.data?.error?.code || 'REQUEST_FAILED';
        error.status = response.statusCode;
        error.details = response.data?.error?.details;
        if (response.statusCode === 401) wx.removeStorageSync(TOKEN_KEY);
        reject(error);
      },
      fail(error) {
        reject(new Error(error.errMsg || '网络连接失败'));
      },
    });
  });
}

async function ensureLogin() {
  if (restoreSession()) return restoreSession();
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const result = await wxLogin();
    if (!result.code) throw new Error('微信登录未返回有效凭证');
    const response = await rawRequest('/auth/wechat', {
      method: 'POST',
      data: { code: result.code },
      public: true,
    });
    wx.setStorageSync(TOKEN_KEY, response.token);
    return response.token;
  })();
  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

async function request(path, options = {}) {
  if (!options.public) await ensureLogin();
  return rawRequest(path, options);
}

function requestId(prefix) {
  const random = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

async function download(path, options = {}) {
  if (!options.public) await ensureLogin();
  const token = options.public ? '' : restoreSession();
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: `${config.apiBaseUrl}/api${path}`,
      timeout: 60000,
      header: token ? { authorization: `Bearer ${token}` } : {},
      success(response) {
        if (response.statusCode === 200) resolve(response.tempFilePath);
        else reject(new Error(`文件下载失败（${response.statusCode}）`));
      },
      fail: reject,
    });
  });
}

module.exports = { request, rawRequest, ensureLogin, restoreSession, requestId, download };
