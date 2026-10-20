#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createUIServer } from '../src/server.mjs';

export function parseArguments(args) {
  const options = { hub: 'http://127.0.0.1:8790', port: 0, open: false };
  const seen = new Set();
  for (let at = 0; at < args.length; at++) {
    const flag = args[at];
    if (['--help','-h'].includes(flag)) { options.help = true; continue; }
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`); seen.add(flag);
    if (flag === '--open') { options.open = true; continue; }
    if (!['--hub','--port','--bridge-path'].includes(flag) || !args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Unknown or missing option: ${flag}`);
    const value = args[++at];
    if (flag === '--port') { if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 65535) throw new Error('Invalid UI port.'); options.port = Number(value); }
    else options[flag === '--bridge-path' ? 'bridgePath' : 'hub'] = value;
  }
  return options;
}
export function openBrowser(url) {
  const [command,args] = process.platform === 'win32' ? ['rundll32.exe',['url.dll,FileProtocolHandler',url]]
    : process.platform === 'darwin' ? ['open',[url]] : ['xdg-open',[url]];
  const child = spawn(command,args,{ detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => process.stderr.write('Browser could not open automatically. Open the printed UI address.\n')); child.unref();
}
export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { process.stdout.write('World Hub UI — independent interface\n\n  world-hub-ui [--hub http://127.0.0.1:8790] [--port 0] [--bridge-path /bridge] [--open]\n\nStart World Hub separately. This UI never starts or owns the Hub process.\n'); return; }
  const ui = await createUIServer(options);
  process.stdout.write(JSON.stringify({ event: 'ui-ready', url: ui.url, hub: ui.hub, bridgePath: ui.bridgePath }) + '\n');
  let stopping = false; const stop = async () => { if (stopping) return; stopping = true; await ui.close(); process.stdout.write(JSON.stringify({ event: 'ui-stopped' }) + '\n'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (options.open) openBrowser(ui.url);
  return ui;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { process.stderr.write(`World Hub UI failed: ${error.message}\n`); process.exitCode = 1; });
