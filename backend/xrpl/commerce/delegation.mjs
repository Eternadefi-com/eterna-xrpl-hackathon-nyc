// XLS-75 delegation as a SUPPORTING module any rail can use for "the agent signs on Rose's behalf". It is not a rail.
// Builders come from unified/tx.mjs (the DelegateSet port of buildNyDelegateSet @ 97b9193). The compatibility rule lives
// here: a delegated transaction may be fee-sponsored but never reserve-sponsored (rippled 3.4.1 Transactor.cpp
// checkSponsor: spfSponsorReserve + Delegate -> temINVALID).
import { buildSponsoredDelegateSet, checkMission } from '../unified/tx.mjs';
import { FLAGS } from '../xls68/xls68.mjs';
import { fail } from '../unified/common.mjs';

const SPF = FLAGS.SponsorFlags;
export { buildSponsoredDelegateSet as buildDelegationGrant };

/** Refuse a delegated tx that combines Delegate with reserve sponsorship (or any other rippled-rejected form). */
export function assertDelegationCompatible(tx) {
  if (tx.Delegate !== undefined && tx.SponsorFlags !== undefined && (tx.SponsorFlags & SPF.spfSponsorReserve)) throw fail('temINVALID', 'reserve sponsorship cannot be combined with Delegate');
  return checkMission(tx);
}
/** Make any unsigned tx a delegated one: the agent (delegate) will sign for `tx.Account`. */
export function delegateTx(tx, { delegate }) {
  if (delegate === tx.Account) throw fail('temBAD_SIGNER', 'Delegate equals Account');
  return assertDelegationCompatible({ ...tx, Delegate: delegate });
}
/** Read-only: does `account` currently delegate a Payment-only permission to `authorize`? (one reader) */
export async function readDelegationGrant(reader, { account, authorize }) {
  const node = (await reader.request('ledger_entry', { delegate: { account, authorize }, ledger_index: 'validated' }))?.node;
  const perms = (node?.Permissions ?? []).map((p) => p.Permission.PermissionValue);
  return { exists: node?.LedgerEntryType === 'Delegate', account: node?.Account, authorize: node?.Authorize, permissions: perms,
    paymentOnly: perms.length === 1 && (perms[0] === 'Payment' || perms[0] === 1), sponsor: node?.Sponsor ?? null };
}
