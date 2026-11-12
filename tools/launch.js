// Used by start.bat: starts achat in the background, with no window of its own,
// so it keeps running after the start window is closed. Everything it prints
// goes to data/achat-log.txt. Stop it with the "Stop achat" button in the dock,
// or with stop.bat.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const logFile = path.join(dataDir, 'achat-log.txt');
fs.mkdirSync(dataDir, { recursive: true });

// a fresh log for every start
const out = fs.openSync(logFile, 'w');
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  detached: true, // not tied to this window: closing it doesn't stop achat
  windowsHide: true,
  stdio: ['ignore', out, out],
});
child.unref();
// remember which process is achat, so stop.bat can always find and stop it
try {
  fs.writeFileSync(path.join(dataDir, 'achat.pid'), String(child.pid));
} catch {
  // stop.bat still finds achat by its port
}

const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
};

// wait until the app answers, then show the links
const started = Date.now();
let exited = false;
child.on('exit', () => (exited = true));
async function check() {
  const cfg = readConfig();
  const port = (cfg && cfg.port) || 7788;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/overlay`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return done(port, readConfig());
  } catch {
    // not up yet
  }
  if (exited || Date.now() - started > 20000) return failed();
  setTimeout(check, 300);
}

function done(port, cfg) {
  console.log('');
  console.log('  achat is running in the background.');
  console.log('  You can close this window: achat keeps running until you press');
  console.log('  "Stop achat" in the dock (Settings tab), run stop.bat, or restart the PC.');
  console.log('');
  console.log(`  OBS Browser Source (everything):  http://127.0.0.1:${port}/overlay?layer=all`);
  if (cfg && cfg.dockToken) console.log(`  OBS Custom Browser Dock (panel):  http://127.0.0.1:${port}/dock?token=${cfg.dockToken}`);
  console.log('');
  console.log('  The dock link contains your private token. Do not show it on stream.');
  console.log('');
  process.exit(0);
}

function failed() {
  console.log('');
  console.log('  achat did not start. What it said:');
  console.log('');
  try {
    const text = fs.readFileSync(logFile, 'utf8').trim();
    console.log(text ? text.split('\n').slice(-15).map((l) => `  ${l}`).join('\n') : '  (nothing)');
  } catch {
    console.log('  (no log)');
  }
  console.log('');
  process.exit(1);
}

check();
