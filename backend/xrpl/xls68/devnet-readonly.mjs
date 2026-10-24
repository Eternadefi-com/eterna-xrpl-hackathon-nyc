// READ-ONLY Devnet probe. Only the methods in READ_ONLY are ever sent; there is no submit, faucet or simulate path.
// Usage: node xls68/devnet-readonly.mjs [address ...]   — checks the snapshot still matches Devnet, and reports accounts.
import { SNAPSHOT, sponsorshipKeylet } from './xls68.mjs';

const URL_DEVNET = 'https://s.devnet.rippletest.net:51234';
const READ_ONLY = new Set(['server_definitions', 'server_info', 'feature', 'account_info', 'ledger_entry']);
async function rpc(method, params = {}) {
  if (!READ_ONLY.has(method)) throw new Error(`refusing non-read-only method ${method}`);
  const r = await fetch(URL_DEVNET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) });
  return (await r.json()).result;
}

const [defs, info, feature] = await Promise.all([rpc('server_definitions'), rpc('server_info'), rpc('feature', { feature: 'Sponsor' })]);
const out = {
  build_version: info.info.build_version, network_id: info.info.network_id, validated_ledger: info.info.validated_ledger,
  definitions_hash: defs.hash, snapshot_hash: SNAPSHOT._meta.definitions_hash, snapshot_matches: defs.hash === SNAPSHOT._meta.definitions_hash,
  sponsor_amendment: feature[SNAPSHOT._meta.amendments.Sponsor.hash] ?? feature,
  accounts: {},
};
const addrs = process.argv.slice(2);
for (const a of addrs) {
  const r = await rpc('account_info', { account: a, ledger_index: 'validated' });
  out.accounts[a] = r.account_data ?? { error: r.error };
}
if (addrs.length === 2) {
  const [sponsor, sponsee] = addrs;
  const r = await rpc('ledger_entry', { index: sponsorshipKeylet(sponsor, sponsee), ledger_index: 'validated' });
  out.sponsorship = r.node ?? { error: r.error };
}
console.log(JSON.stringify(out, null, 1));
