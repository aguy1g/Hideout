'use strict';
// npm run share: starts Hideout and a free Cloudflare quick tunnel, then prints the link to send your friends.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const port = process.env.PORT || '3000';
const open = process.argv.includes('--open');
const code = process.env.SIGNUP_CODE || (open ? '' : crypto.randomBytes(5).toString('hex'));

const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error(`
cloudflared isn't installed (or isn't on your PATH).
Install it, then run this again:
  Mac:      brew install cloudflared
  Windows:  winget install Cloudflare.cloudflared
  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
`);
  process.exit(1);
}

const env = { ...process.env, PORT: port, TRUST_PROXY: '1', SIGNUP_CODE: code };
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'inherit', 'inherit'] });
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });

let shown = false;
const onData = (buf) => {
  const m = !shown && /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
  if (!m) return;
  shown = true;
  console.log(`
============================================================
  Share this link with your friends:

    ${m[0]}${code ? '/#code=' + code : ''}

  ${code ? `New accounts need this invite code: ${code}\n  (the link above already fills it in; people with an account don't need it)` : 'Anyone with the link can create an account (started with --open).'}
  The link changes every time you run this. Press Ctrl+C to stop.
============================================================
`);
};
tunnel.stdout.on('data', onData);
tunnel.stderr.on('data', onData);

const stop = () => { server.kill('SIGTERM'); tunnel.kill('SIGTERM'); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', () => { tunnel.kill(); process.exit(); });
tunnel.on('exit', () => { server.kill(); process.exit(); });
