// Master storyboard + timeline — ONE composition for every sponsor demonstration (engineering-owned structure;
// the designer owns the look in components/show-scene.js and styles/show.css).
// A scenario file (public/scenarios/<id>.json) fills the slots; it never adds or removes chapters. Every version tells
// the whole story on its own: problem → Eterna → the actual transaction → proof. Motion is a pure function of time,
// so the live presentation and the captured video render the exact same frames from the same evidence.

export const CHAPTERS = [
  { key: 'opening',     ms: 6000,  purpose: 'Who this is for, and the one-line promise' },
  { key: 'problem',     ms: 10000, purpose: 'Rose’s business problem, in her world' },
  { key: 'solution',    ms: 10000, purpose: 'How Eterna governs it: sign once, bounded authority' },
  { key: 'transaction', ms: 14000, purpose: 'The actual transaction, in the real Eterna UI' },
  { key: 'proof',       ms: 10000, purpose: 'Network, transaction hash, independent verification' },
  { key: 'outcome',     ms: 6000,  purpose: 'What Rose got (resource unlocked / fees and reserve sponsored)' },
  { key: 'closing',     ms: 6000,  purpose: 'Closing message and call to action' },
];

export const MOTION = { enterMs: 700, stepMs: 450, exitMs: 400 };       // defaults; the browser loads --motion-* from tokens.css

const REQUIRED = ['id', 'sponsor.name', 'sponsor.audience', 'scenario.title', 'scenario.problem', 'scenario.summary', 'capability.name', 'capability.oneLiner',
  'network.label', 'evidence.source', 'messages.opening', 'messages.closing', 'imagery.hero'];
const pick = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

/** Problems with a scenario file, as readable strings ([] = valid). Chapters are fixed by the master. */
export function validateScenario(s) {
  const errors = REQUIRED.filter((p) => pick(s, p) == null || pick(s, p) === '').map((p) => `missing ${p}`);
  if (s?.network && !['XRPL Mainnet', 'XRPL Devnet', 'XRPL Testnet'].includes(s.network.label)) errors.push(`unknown network.label ${s.network.label}`);
  for (const k of Object.keys(s?.narration ?? {})) if (!CHAPTERS.some((c) => c.key === k)) errors.push(`narration for unknown chapter ${k}`);
  for (const k of Object.keys(s?.durations ?? {})) if (!CHAPTERS.some((c) => c.key === k)) errors.push(`duration for unknown chapter ${k}`);
  for (const c of CHAPTERS) if (!s?.narration?.[c.key]) errors.push(`missing narration.${c.key}`);
  return errors;
}

/** Chapters with absolute start/end times; a scenario may lengthen a chapter to fit its narration, never reorder. */
export function timeline(s) {
  let at = 0;
  return CHAPTERS.map((c, i) => {
    const ms = Number(s?.durations?.[c.key] ?? c.ms), start = at; at += ms;
    return { ...c, i, ms, start, end: at };
  });
}
export const totalMs = (tl) => tl[tl.length - 1].end;

/** Where we are at time t: chapter index, ms into it, 0..1 progress. */
export function frameAt(tl, t) {
  const c = tl.find((x) => t < x.end) ?? tl[tl.length - 1];
  const local = Math.max(0, Math.min(t - c.start, c.ms));
  return { i: c.i, key: c.key, local, p: local / c.ms };
}

export const ease = (x) => 1 - (1 - x) ** 3;
/** 0..1 reveal for an element that enters `at` ms into its chapter. */
export const reveal = (local, at = 0, dur = MOTION.enterMs) => ease(Math.max(0, Math.min(1, (local - at) / dur)));
