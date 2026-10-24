// Private key + mission-state storage under ~/eterna-private/unified-devnet (dir 0700, files 0600).
// Seeds are generated locally and never printed; only public addresses / keys leave this module.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const { Wallet } = require('ethers');

export const DIR = process.env.UNIFIED_DEVNET_DIR ?? join(homedir(), 'eterna-private', 'unified-devnet');
const ensureDir = () => { mkdirSync(DIR, { recursive: true, mode: 0o700 }); chmodSync(DIR, 0o700); };
const write = (name, obj, flag = 'w') => {
  ensureDir();
  const p = join(DIR, name), tmp = `${p}.tmp`;
  if (flag === 'wx') { writeFileSync(p, JSON.stringify(obj, null, 1), { mode: 0o600, flag: 'wx' }); return; }
  writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, p);
};

/** XRPL Devnet key for a role (eterna | rose | seller | agent | rogue). Created once (wx), then reused. */
export function xrplKey(role) {
  const p = join(DIR, `${role}.xrpl.json`);
  if (!existsSync(p)) {
    const seed = keypairs.generateSeed({ algorithm: 'ed25519' });
    const { publicKey } = keypairs.deriveKeypair(seed);
    write(`${role}.xrpl.json`, { role, network: 'XRPL Devnet ONLY', algorithm: 'ed25519', address: keypairs.deriveAddress(publicKey), publicKey, seed }, 'wx');
  }
  const k = JSON.parse(readFileSync(p, 'utf8'));
  return { role, address: k.address, publicKey: k.publicKey, seed: k.seed }; // seed stays in memory only
}
/** The agent's simulator voucher key (EVM-style secp256k1). Never a real chain key. */
export function simulatorWallet() {
  const p = join(DIR, 'agent.voucher-sim.json');
  if (!existsSync(p)) { const w = Wallet.createRandom(); write('agent.voucher-sim.json', { purpose: 'Eterna AP4M simulator voucher key; not a real chain key', address: w.address, privateKey: w.privateKey }, 'wx'); }
  return new Wallet(JSON.parse(readFileSync(p, 'utf8')).privateKey);
}

export const STATE_FILE = join(DIR, 'mission-state.json');
export const loadState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
export const saveState = (s) => write('mission-state.json', s);
