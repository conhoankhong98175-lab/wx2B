const api = require('./utils/api');

App({
  globalData: {
    authReady: false,
  },

  onLaunch() {
    api.restoreSession();
  },
});
