#!/usr/bin/env node
// Video capture for the master presentation — zero dependencies (headless Chrome over the DevTools protocol + ffmpeg).
// Renders /show.html?film=1 frame by frame (window.__show.seek), so the video is exactly what the live presenter shows,
// from the same evidence. Writes <out>.mp4, <out>.srt (narration timed to the chapters, for the voiceover) and
// <out>.json (scenario, evidence status, transaction hash, chapter times).
//
//   node scripts/capture-show.mjs --scenario mainnet-purchase [--url http://127.0.0.1:3460] [--aspect 16x9|9x16]
//        [--fps 30] [--from 0] [--to <ms>] [--out ./out/mainnet-purchase] [--draft] [--captions 0] [--theme film]
//
// Final cuts refuse evidence that is not final (VERIFIED, or every required ledger part VERIFIED with the rest labelled) (a REHEARSAL or PENDING status is printed on every frame anyway);
// pass --draft for rehearsal renders. Needs Node ≥ 22 (global WebSocket), Google Chrome and ffmpeg.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] == null ? true : process.argv[i + 1]); };
if (!globalThis.WebSocket) { console.error('Needs Node ≥ 22 (or node --experimental-websocket).'); process.exit(2); }
const scenario = arg('scenario', 'mainnet-purchase'), base = arg('url', 'http://127.0.0.1:3460'), aspect = arg('aspect', '16x9');
const fps = Number(arg('fps', 30)), draft = arg('draft', false) === true, out = resolve(arg('out', `./out/${scenario}-${aspect}`));
const [W, H] = aspect === '9x16' ? [1080, 1920] : [1920, 1080];
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const profile = mkdtempSync(join(tmpdir(), 'eterna-capture-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cleanup = () => { chrome.kill(); rmSync(profile, { recursive: true, force: true }); };
process.on('exit', cleanup);

const port = await new Promise((ok, no) => {
  let s = ''; chrome.stderr.on('data', (d) => { s += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(s); if (m) ok(m[1]); });
  setTimeout(() => no(new Error('Chrome did not start')), 15000);
});
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
let seq = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((ok, no) => { const id = ++seq; waiting.set(id, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result))); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };

await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const q = new URLSearchParams({ s: scenario, film: '1', ...(aspect === '9x16' ? { aspect } : {}), ...(arg('captions') === '0' ? { captions: '0' } : {}), ...(arg('theme') ? { theme: arg('theme') } : {}) });
await cdp('Page.navigate', { url: `${base}/show.html?${q}` });
let info = null;
for (let i = 0; i < 100 && !info; i++) { await new Promise((r) => setTimeout(r, 200)); info = await evaluate('window.__show?.ready ? { total: __show.total, status: __show.status, finalReady: __show.finalReady, chapters: __show.chapters } : (document.querySelector(".show__loading")?.textContent?.startsWith("Could not") ? { error: document.querySelector(".show__loading").textContent } : null)').catch(() => null); }
if (!info || info.error) { console.error(info?.error ?? 'The presentation did not load.'); process.exit(1); }
if (!info.finalReady && !draft) { console.error(`Evidence is ${info.status}, not final. Final cuts need the scenario's own verified ledger evidence; use --draft for a rehearsal render.`); process.exit(1); }
const meta = await evaluate('fetch(`/scenarios/' + scenario + '.json`).then((r) => r.json())');

const from = Number(arg('from', 0)), to = Math.min(Number(arg('to', info.total)), info.total), frames = Math.ceil(((to - from) / 1000) * fps);
mkdirSync(dirname(out), { recursive: true });
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${out}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
const t0 = Date.now();
for (let k = 0; k < frames; k++) {
  await evaluate(`window.__show.seek(${from + (k * 1000) / fps})`);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
  if (k % fps === 0) process.stdout.write(`\r${scenario} ${aspect}: ${k}/${frames} frames`);
}
ff.stdin.end();
await new Promise((ok, no) => ff.on('close', (c) => (c === 0 ? ok() : no(new Error(`ffmpeg exited ${c}`)))));

const ts = (ms) => { const d = new Date(Math.max(0, ms - from)); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')},${String(d.getUTCMilliseconds()).padStart(3, '0')}`; };
const cues = info.chapters.filter((c) => c.end > from && c.start < to);
writeFileSync(`${out}.srt`, cues.map((c, n) => `${n + 1}\n${ts(Math.max(c.start, from))} --> ${ts(Math.min(c.end, to))}\n${meta.narration[c.key]}\n`).join('\n'));
const ev = await evaluate(`(${async () => { const { resolveEvidence } = await import('/lib/evidence.js'); const s = await (await fetch(location.pathname.replace('show.html', '') + 'scenarios/' + new URLSearchParams(location.search).get('s') + '.json')).json();
  const [c, r] = await Promise.all([fetch('/api/preview/config').then((x) => x.json()), fetch('/api/preview/recorded').then((x) => x.json())]);
  const m = c.mode === 'mainnet' ? await fetch('/api/preview/mainnet').then((x) => x.json()) : null; const e = await resolveEvidence(s, { recorded: r, mainnet: m });
  return { status: e.status, network: e.network, source: e.source, txHash: e.txHash ?? null, txUrl: e.txUrl ?? null, ledger: e.ledger ?? null, at: e.at ?? null }; }})()`);
writeFileSync(`${out}.json`, JSON.stringify({ scenario, version: meta.version, aspect, fps, frames, fromMs: from, toMs: to, renderedAt: new Date().toISOString(), draft, evidence: ev, chapters: cues }, null, 2));
console.log(`\n${out}.mp4 (${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s) · evidence ${ev.status}${ev.txHash ? ` · ${ev.txHash}` : ''}`);
cleanup(); process.exit(0);
