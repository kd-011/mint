// Capacitor reads this at `cap sync`. The app origin and the optional login
// gateway host come from the environment (build.sh loads them from the env file,
// see shell.env.example), so no deployment-specific host is committed.
const origin = process.env.MINT_APP_ORIGIN || '';
if (!/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(origin)) {
  throw new Error('MINT_APP_ORIGIN must be an https origin such as https://mint.example.com/ (set it in shell.env, then run ./build.sh)');
}
const appHost = origin.replace(/^https:\/\//, '').replace(/\/$/, '');
const authHost = (process.env.MINT_AUTH_HOST || '').trim();

module.exports = {
  appId: 'io.github.kd011.mint',
  appName: 'Mint',
  webDir: 'www',
  server: {
    url: origin.replace(/\/?$/, '/'),
    allowNavigation: authHost ? [appHost, authHost] : [appHost],
    errorPath: 'offline.html',
  },
  android: {
    backgroundColor: '#0b0d0c',
    allowMixedContent: false,
    appendUserAgent: 'MintApp',
  },
  plugins: {
    SystemBars: {
      insetsHandling: 'disable',
      style: 'DARK',
    },
  },
};
