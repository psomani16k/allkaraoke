// Container entrypoint: configures the built Worker from env vars and serves it with `wrangler dev`.
// Without Cloudflare Realtime credentials it also starts the stand-in SFU from tests/fake-sfu, the
// same one `pnpm start` uses, so remote mics and online mode work fully self-hosted.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';

const BUILD_DIR = '/app/build';
const PORT = process.env.PORT ?? '3010';
const SFU_PORT = process.env.FAKE_SFU_PORT ?? '3480';
const DATA_DIR = process.env.DATA_DIR ?? '/data';

// Worker secrets/vars that may be passed in from the environment
const PASSTHROUGH_VARS = [
  'ADMIN_PANEL_PASSWORD',
  'UNVERIFIED_SONGS_ADMIN_TOKEN',
  'REALTIME_APP_ID',
  'REALTIME_APP_TOKEN',
  'REALTIME_API_URL',
  'REALTIME_TURN_KEY_ID',
  'REALTIME_TURN_API_TOKEN',
  'ONLINE_TURN_URLS',
  'ONLINE_TURN_USERNAME',
  'ONLINE_TURN_CREDENTIAL',
  'ONLINE_STUN_URLS',
];

// The Cloudflare Vite plugin writes the Worker and its generated wrangler.json to build/<worker-name>/
const workerDir = readdirSync(BUILD_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'client')
  .map((entry) => path.join(BUILD_DIR, entry.name))
  .find((dir) => existsSync(path.join(dir, 'wrangler.json')));
if (!workerDir) {
  console.error(`No built Worker found in ${BUILD_DIR}`);
  process.exit(1);
}
const configPath = path.join(workerDir, 'wrangler.json');

const vars = Object.fromEntries(PASSTHROUGH_VARS.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
const useFakeSfu = !(vars.REALTIME_APP_ID && vars.REALTIME_APP_TOKEN);
if (useFakeSfu) {
  Object.assign(vars, {
    REALTIME_APP_ID: 'fake-sfu',
    REALTIME_APP_TOKEN: 'fake-sfu',
    REALTIME_API_URL: `http://127.0.0.1:${SFU_PORT}/v1`,
  });
}

// wrangler dev reads secrets from the .dev.vars next to the config
writeFileSync(
  path.join(workerDir, '.dev.vars'),
  Object.entries(vars)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join('\n') + '\n',
);

// Off the Cloudflare edge there is no CF-Connecting-IP, so every client shares one rate-limit bucket.
// The dev server drops this limiter for the fake SFU for the same reason; there is no bill to protect.
if (useFakeSfu) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.ratelimits = (config.ratelimits ?? []).filter(({ name }) => name !== 'REALTIME_SIGNALING_RATE_LIMITER');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

const children = new Set();
let shuttingDown = false;

const run = (command, args, env = {}) => {
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) {
      if (children.size === 0) process.exit(0);
      return;
    }
    console.error(`${command} exited (${signal ?? code}), stopping container`);
    shutdown(code || 1);
  });
  return child;
};

const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 10_000).unref();
  if (children.size === 0) process.exit(code);
};
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

const isListening = (port) =>
  new Promise((resolve) => {
    const socket = connect({ port: Number(port), host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

if (useFakeSfu) {
  console.log(`No Cloudflare Realtime credentials, starting the stand-in SFU on :${SFU_PORT}`);
  run(process.execPath, ['/opt/runtime/fake-sfu/server.mts'], { FAKE_SFU_PORT: SFU_PORT });
  const startedAt = Date.now();
  while (!(await isListening(SFU_PORT))) {
    if (Date.now() - startedAt > 15_000) {
      console.error('Stand-in SFU did not start');
      shutdown(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} else {
  console.log('Using Cloudflare Realtime for remote mics and online mode');
}

run('wrangler', [
  'dev',
  '--config',
  configPath,
  '--ip',
  '0.0.0.0',
  '--port',
  PORT,
  '--persist-to',
  DATA_DIR,
  '--show-interactive-dev-session=false',
]);
