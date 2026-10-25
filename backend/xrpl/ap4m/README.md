# ap4m/: Eterna on the real Mastercard AP4M hackathon kit (XRPL EVM Testnet)

> **Hackathon use only.** The AP4M kit says it is "for the Mastercard XRPL Hackathon only … must not be used outside of
> the hackathon context."
> - The kit files are **vendored unmodified into `vendor/kit/` by `vendor/fetch-kit.sh`**. The script checks the SHA-256
>   hashes in `vendor/MANIFEST.json`.
> - `vendor/kit/` is **git-ignored**. The kit files are not committed and must not be published to any public repository.
> - Only Eterna's own code, the manifest and a read-only public chain tape are committed.

Product 3 moves from the labelled local simulator (`commerce/adapters/ap4m-voucher.mjs`, still SIMULATED and unchanged)
to a **LIVE_CAPABLE** adapter on the real kit: `ap4m-kit`. It implements the same adapter contract, so the UI doesn't
change. To show it in the product list, add `ap4m/adapter.mjs` to `commerce/index.mjs` `ADAPTERS` and update
`conformance.test.mjs`. That is not done here, so the website's adapter list stays as it is.

| File | Role |
| --- | --- |
| `FINDINGS.md` | B1: APIs, contracts, events, EIP-712, auth flow, what is missing |
| `constants.mjs` | Network, contract addresses and code hashes, EIP-712 names and types, verbatim kit ABIs, endpoints (testnet only) |
| `voucher.mjs` | Voucher typed data and digest, claim-id derivation, x402 header codec and challenge reader, event parsers (pure) |
| `readers.mjs` | Read-only EVM readers: method allow-list, host allow-list, chain-id check, record and replay |
| `adapter.mjs` | `ap4m-kit` adapter: `challenge` (kit Merchant 402), `prepare` (exact unsigned voucher after PERMIT; on-chain cap check), `verify` (VoucherRedeemed, ClaimPaid, Transfer, SettlementRecorded from 2 readers) |
| `owner-voucher-signer.mjs` | Owner-side signer: signs only a permitted voucher and its x402 resource binding; refuses everything else |
| `governed-agent.mjs` | `governedPurchase` (402 → authorize → prepare → permit → kit `buyResource`) and `settleAndVerify` |
| `governed-merchant.mjs` | Eterna's listings served by the kit's own `createX402Merchant` (approval-gated) |
| `owner-cli.mjs` | Owner CLI: read-only `preflight`, `verify` and `refuse-demo`; gated `sign-in`, `request-channel`, `buy-and-settle` and `close` |
| `record-public-tape.mjs` | Read-only capture of one public third-party payment for parser tests |
| `RUNBOOK.md`, `EVIDENCE_MANIFEST.template.json`, `DEMO_5MIN.md` | Approval-gated steps, the evidence template, and the demo with submission text |

The governance engine needed one backward-compatible extension, in `commerce/governance.mjs` and `contract.mjs`:
- the asset `RLUSD-EVM` (18 decimals, bound to the token contract on `eip155:1449000`);
- an optional certificate `evmAgent`, with the refusal `WRONG_AGENT_WALLET`;
- `eip155:<chainId>` allowed as an adapter network.

## Tests

```
node --test ap4m/ap4m.test.mjs       # 12 tests (offline)
node --test commerce/ unified/       # 44 existing tests, unchanged and green
```

The tests use two kinds of data, never mixed:
- **REAL**: `fixtures/public-tape.json`, a third-party public payment captured read-only from 2 readers. It is used for the parser, digest, claim-id and verify tests. It is not Eterna's payment.
- **SYNTHETIC**: the `STUB_*` objects in `test-support.mjs`. They are used for the permit and refuse paths, and support no "real" claim.

Eterna's checks are **governance evidence**. They are not Mastercard KYA, PSP certification or AP4M approval.
