'use strict';
// npm run backup [file.tgz]            saves everything in the data folder
// npm run backup -- --restore file.tgz  puts a backup back (stop the server first)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const args = process.argv.slice(2);
const restore = args.includes('--restore');
const file = path.resolve(args.find((a) => !a.startsWith('--')) || `hideout-backup-${new Date().toISOString().slice(0, 10)}.tgz`);

if (restore) {
  if (!fs.existsSync(file)) { console.error('No such file: ' + file); process.exit(1); }
  fs.mkdirSync(dataDir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', file, '-C', dataDir], { stdio: 'inherit' });
  process.exit(r.status || 0);
}
if (!fs.existsSync(dataDir)) { console.error('Nothing to back up yet: ' + dataDir); process.exit(1); }
const r = spawnSync('tar', ['-czf', file, '-C', dataDir, '.'], { stdio: 'inherit' });
if (r.status === 0) console.log(`Saved ${file}\nKeep it private: it holds everyone's accounts and encrypted history.`);
process.exit(r.status || 0);
