// Master presentation — page wiring (engineering-owned). One page for every scenario, two ways to run it:
//   /show.html?s=<scenario>              LIVE presenter: → / ← / space step chapters; each chapter animates, then holds
//   /show.html?s=<scenario>&autoplay=1   plays the whole timeline in real time (rehearsal, screen recording)
//   /show.html?s=<scenario>&film=1       FILM: no clock; window.__show.seek(ms) renders that exact frame (scripts/capture-show.mjs)
//   options: &aspect=9x16 (vertical) · &captions=0 · &theme=film
// Evidence is resolved from the same records the app shows (lib/evidence.js); on the engineering machine in Mainnet
// observe mode the presenter view refreshes it every 2.5 s, so a live purchase appears as it happens.
import { esc } from './lib/html.js';
import { timeline, totalMs, frameAt, validateScenario, MOTION } from './lib/master.js';
import { resolveEvidence } from './lib/evidence.js';
import { renderScene } from './components/show-scene.js';

const q = new URLSearchParams(location.search), $ = (s) => document.querySelector(s);
const get = (u) => fetch(u, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); });
const imageExists = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(true); i.onerror = () => ok(false); i.src = `/${src}`; });

let S, TL, EV, imageOk = false, t = 0;
const draw = () => {
  const f = frameAt(TL, t);
  $('#show').innerHTML = renderScene({ s: { ...S, imagery: { ...S.imagery, hero: `/${S.imagery.hero}` } }, ev: EV, f, n: TL.length, imageOk });
  document.body.dataset.chapter = f.key;
};

async function evidence(config, recorded) {
  const mainnet = config.mode === 'mainnet' ? await get('/api/preview/mainnet').catch(() => null) : null;
  return resolveEvidence(S, { recorded, mainnet });
}

async function boot() {
  const id = q.get('s') ?? 'mainnet-purchase';
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad scenario id');
  document.body.classList.toggle('show--vertical', q.get('aspect') === '9x16');
  document.body.classList.toggle('show--nocaptions', q.get('captions') === '0');
  if (q.get('theme') === 'film') document.documentElement.dataset.theme = 'film';
  S = await get(`/scenarios/${id}.json`);
  const errors = validateScenario(S);
  if (errors.length) throw new Error(`Scenario ${id} is invalid: ${errors.join('; ')}`);
  TL = timeline(S);
  // The app's components are sized in px; scale them with the frame so the presenter view matches the 1920 / 1080 video.
  const fit = () => { const w = $('#show').clientWidth; document.documentElement.style.setProperty('--ui-zoom', (w / (q.get('aspect') === '9x16' ? 700 : 1320)).toFixed(3)); };
  fit(); window.addEventListener('resize', fit);
  const [config, recorded] = await Promise.all([get('/api/preview/config'), get('/api/preview/recorded')]);
  [EV, imageOk] = await Promise.all([evidence(config, recorded), imageExists(S.imagery.hero)]);
  await document.fonts.ready;
  // Motion comes from the design tokens (tokens.css), so one change restyles the app, the presenter view and the video.
  const css = getComputedStyle(document.documentElement), ms = (n, d) => parseFloat(css.getPropertyValue(n)) || d;
  Object.assign(MOTION, { enterMs: ms('--motion-enter', MOTION.enterMs), stepMs: ms('--motion-step', MOTION.stepMs), exitMs: ms('--motion-exit', MOTION.exitMs) });

  if (q.get('film') === '1') {                                             // deterministic frames for the capture script
    window.__show = { ready: true, total: totalMs(TL), scenario: S.id, status: EV.status, finalReady: EV.status === 'VERIFIED' || EV.finalReady === true, chapters: TL.map(({ key, start, end }) => ({ key, start, end })),
      seek: (ms) => { t = ms; draw(); return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); } };
    draw(); return;
  }
  const auto = q.get('autoplay') === '1';
  let chapter = 0, started = performance.now(), lastT = -1, lastEV = null;
  const go = (d) => { chapter = Math.max(0, Math.min(TL.length - 1, chapter + d)); started = performance.now(); };
  window.addEventListener('keydown', (e) => { if (['ArrowRight', ' ', 'PageDown'].includes(e.key)) go(1); if (['ArrowLeft', 'PageUp'].includes(e.key)) go(-1); });
  $('#show').addEventListener('click', () => go(1));
  if (config.mode === 'mainnet') setInterval(async () => { EV = await evidence(config, recorded).catch(() => EV); }, 2500);
  const tick = (now) => {
    if (auto) { t = Math.min(now - started, totalMs(TL)); }
    else { const c = TL[chapter]; t = c.start + Math.min(now - started, c.ms - 1); }   // animate in, then hold for the presenter
    if (t !== lastT || EV !== lastEV) { draw(); lastT = t; lastEV = EV; }   // holding still = no re-render
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
boot().catch((e) => { $('#show').innerHTML = `<p class="show__loading">Could not load: ${esc(e.message)}</p>`; });
