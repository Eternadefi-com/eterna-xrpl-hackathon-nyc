// Mastercard AP4M hackathon kit: the public facts Eterna's integration relies on. FOR THE XRPL COMMONS NYC / MASTERCARD
// XRPL HACKATHON ONLY: the kit "must not be used outside of the hackathon context".
//
// Provenance (read-only, 2026-10-24): GET https://hackathon.ap4m.build/public/config and /public/x402-context, and the
// kit's own source (/sdk/ap4m-hackathon-sdk.js, /sdk/ap4m-x402.mjs, /sdk/ap4m-sdk.tgz = @ap4m/sdk 0.10.1). The ABI
// strings below are copied verbatim from @ap4m/sdk dist/participant-requests.js and dist/pooled-escrow-vault.js; the
// test `kit conformance` re-reads the vendored kit text (when present) and fails if any of them drifts.
// XRPL EVM **Testnet** only (chain 1449000). There is no Mainnet value anywhere in this module, on purpose.

export const SERVICE_URL = 'https://hackathon.ap4m.build';
export const NETWORK = Object.freeze({
  caip2: 'eip155:1449000', chainId: 1449000n, name: 'XRPL EVM Testnet', gasToken: 'XRP',
  rpcUrl: 'https://rpc.testnet.xrplevm.org', explorerUrl: 'https://explorer.testnet.xrplevm.org',
  // second, independently operated read path: the Blockscout explorer's JSON-RPC facade (its own indexer database)
  explorerRpcUrl: 'https://explorer.testnet.xrplevm.org/api/eth-rpc',
  faucetUrl: 'https://faucet.testevm.ripple.com',
});
export const CONTRACTS = Object.freeze({
  participantRegistry: '0x4cF27435FE56161aa9b1cffdD87784aa68b7D1E8',
  paymentLedger: '0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91',
  pooledEscrowVault: '0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0',
  rlusdToken: '0x27b57a9D0b8d24EB97259c4E2279e45255e016f3',
});
/** Runtime code hashes read with eth_getCode on 2026-10-24 (block ~9226535). A change means a redeploy: stop and re-inspect. */
export const CODE_HASHES = Object.freeze({
  participantRegistry: '0x9ae8d15dd7fb7121ff4ab671af91462884f51a82f1fd69db174fad88b56b4fda',
  paymentLedger: '0xa0427467fb8adc54eaf579efa4d7af4bad25497a232f58667850d57b5dae20aa',
  pooledEscrowVault: '0x05df2985e62fff4988010db1bab0efd58330423eb2e2413f3ec7e770093a9e11',
  rlusdToken: '0x5b1a53438d7b0cc636773292a6600572b28f7db67079ede99f164f9110d10e38', // 212-byte proxy
});
export const DEPLOYMENT = Object.freeze({
  deploymentId: '0x1b008272f4dff2b403c7a2c9a32aafd6c609c96196a3407ef33fcf1a0975e3b3',
  payerPspId: '0x0c4b348ab956f7857398d44662cf18c4df241fb8b4befcc8f0c304119e74fc0a',
  vaultConfigurationId: '0x9da206a6ad13739a526c90dee2cf62422efc0fd985e1f232af4d34f946855b4d',
  environmentManifestDigest: '0x0ebaddb9abe66502618e5665edd04135407e77a99284a7918bc2bd416815965d',
  vaultDeploymentBlock: 9192133, confirmationBlocks: 1, x402ValidBefore: 1794765600,
});
/** The service's test PSPs (Mastercard-operated test identities in this hackathon deployment; not production PSPs). */
export const PSPS = Object.freeze([
  { pspId: 'mc-payer-psp', displayName: 'Mastercard Payer PSP', signer: '0x23f37318a8e396f99385b67005c8242d67c49563', generation: 1 },
  { pspId: 'mc-payee-psp', displayName: 'Mastercard Payee PSP', signer: '0xae9b83f33d393671b9cd39fbf6dd9d4830a3b4f9', generation: 1 },
]);
export const RLUSD_DECIMALS = 18;

// ---- EIP-712 (from @ap4m/sdk dist/payment-ledger.js and dist/x402.js) ----------------------------------------------
export const VOUCHER_DOMAIN_NAME = 'AP4M Payment Ledger';
export const VOUCHER_DOMAIN_VERSION = '1';
export const VOUCHER_TYPES = Object.freeze({ Voucher: Object.freeze([{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint256' }]) });
export const RESOURCE_BINDING_DOMAIN_NAME = 'AP4M x402 Resource Binding';
export const RESOURCE_BINDING_DOMAIN_VERSION = '1';
export const RESOURCE_BINDING_TYPES = Object.freeze({ X402ResourceBinding: Object.freeze([{ name: 'resourceDigest', type: 'bytes32' }, { name: 'voucherDigest', type: 'bytes32' }]) });
export const PAYMENT_CLAIM_ID_TYPE = 'PaymentClaim(uint256 chainId,address ledger,bytes32 channelId,uint256 previousCumulativeAmount,uint256 cumulativeAmount,bytes32 voucherDigest)';
export const voucherDomain = (ledger = CONTRACTS.paymentLedger, chainId = NETWORK.chainId) => ({ name: VOUCHER_DOMAIN_NAME, version: VOUCHER_DOMAIN_VERSION, chainId, verifyingContract: ledger });
export const resourceBindingDomain = (ledger = CONTRACTS.paymentLedger, chainId = NETWORK.chainId) => ({ name: RESOURCE_BINDING_DOMAIN_NAME, version: RESOURCE_BINDING_DOMAIN_VERSION, chainId, verifyingContract: ledger });

// ---- ABIs (verbatim from the kit) ------------------------------------------------------------------------------------
export const LEDGER_ABI = Object.freeze([
  'function deploymentId() view returns (bytes32)',
  'function channels(bytes32 channelId) view returns (bytes32 allocationId,bytes32 merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,bytes32 merchantAttestationId,bytes32 merchantId,bytes32 latestVoucherDigest,uint256 cap,uint256 redeemed,address agent,uint64 allocationGeneration,uint8 status,address payout,uint64 merchantGeneration,address merchantPspSigner,uint64 merchantPspSignerGeneration,uint64 validAfter,uint64 validBefore)',
  'function claims(bytes32 claimId) view returns (bytes32 channelId,uint256 amount,bytes32 settlementDigest)',
  'function agentAllocations(bytes32 allocationId) view returns (bytes32 agentPspId,bytes32 agentParticipantIdHash,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 authorityAttestationId,address agent,uint256 cap,uint256 reserved,uint256 spent,uint64 validAfter,uint64 validBefore,uint64 generation,uint8 status)',
  'function availableAgentCapacity(bytes32 allocationId) view returns (uint256)',
  'function redeemVoucher((bytes32 channelId,uint256 cumulativeAmount) voucher,bytes agentSignature) returns (bytes32 claimId,uint256 amount,bytes32 digest)',
  'event SettlementRecorded(bytes32 indexed claimId,bytes32 indexed channelId,bytes32 indexed settlementDigest)',
  'event ChannelClosed(bytes32 indexed channelId,bytes32 indexed allocationId,bytes32 indexed finalCheckpointDigest,bytes32 finalVoucherDigest,uint64 merchantPspSignerGeneration,uint256 redeemed,uint256 unusedCapacityReleased)',
  'event ChannelOpened(bytes32 indexed channelId,bytes32 indexed allocationId,bytes32 indexed merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,uint64 allocationGeneration,address agent,bytes32 merchantId,bytes32 merchantAttestationId,uint64 merchantGeneration,address payout,uint256 cap,uint64 validAfter,uint64 validBefore,address merchantPspSigner,uint64 merchantPspSignerGeneration)',
  'event VoucherRedeemed(bytes32 indexed channelId,bytes32 indexed claimId,bytes32 indexed voucherDigest,bytes32 allocationId,address agent,bytes32 merchantId,address payout,address submitter,uint256 previousCumulativeAmount,uint256 cumulativeAmount,uint256 amount)',
]);
export const VAULT_ABI = Object.freeze([
  'event ClaimPaid(bytes32 indexed claimId,bytes32 indexed payoutId,bytes32 indexed channelId,address payout,uint256 amount,uint256 cumulativeDisbursed,uint64 paidAt)',
  'event PayoutBound(bytes32 indexed reservationId,bytes32 indexed payoutId,bytes32 indexed channelId,bytes32 operationId,bytes32 merchantPspId,bytes32 merchantId,address payout,uint256 cap,uint64 boundAt)',
]);
export const ERC20_ABI = Object.freeze(['event Transfer(address indexed from,address indexed to,uint256 value)',
  'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
/** Channel.status values used by the kit (status 1 = open, per ap4m-x402.mjs buyResource). */
export const CHANNEL_STATUS_OPEN = 1;

// ---- service endpoints (from the kit source; Bearer = session token from signIn) -----------------------------------------
export const ENDPOINTS = Object.freeze({
  publicConfig: 'GET /public/config', x402Context: 'GET /public/x402-context', merchants: 'GET /public/merchants',
  signInChallenge: 'POST /public/participant/challenge {teamName, wallet}', signInSession: 'POST /public/participant/session {challengeId, signature}',
  channelPrepare: 'POST /public/participant/channel-requests/prepare {cap_rlusd, merchant_id} (Bearer) -> {to, data}',
  channelRecord: 'POST /public/participant/channel-requests {tx_hash} (Bearer)', channels: 'GET /public/participant/channels (Bearer)',
  recordRedemption: 'POST /public/participant/record-redemption {tx_hash} (Bearer)', settle: 'POST /public/participant/settle {channel_id} (Bearer; 202 while confirming)',
  closeChallenge: 'GET /public/participant/close-channel-challenge?channel_id= (Bearer)', close: 'POST /public/participant/close-channel {agent_signature_r, agent_signature_vs, channel_id} (Bearer)',
  claimEvidence: 'GET /public/evidence/claims/<claimId>[/<settlementDigest>.json]', me: 'GET /public/participant/me (Bearer)',
});

// ---- Eterna's proposed wallets (addresses only; keys never in the repo) ---------------------------------------------------
export const PROPOSED = Object.freeze({
  agent: '0x8559285aa94E04C3a6F689546276A47Bd8Ea7e36', // Mastercard registration address; key at ~/eterna-private/mastercard-evm/evm.key (0600)
  agentKeyPath: '~/eterna-private/mastercard-evm/evm.key',
  merchantPayoutKeyDir: '~/eterna-private/ap4m-merchant-payout/', // PROPOSED, not created: owner generates; must differ from agent and funding
});
