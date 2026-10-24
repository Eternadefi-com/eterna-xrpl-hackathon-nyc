// One Eterna application, four payment capabilities, one governance engine.
import paychan from './adapters/xrp-paychan.mjs';
import rlusd from './adapters/rlusd.mjs';
import sponsored from './adapters/xls68-sponsored.mjs';
import ap4m from './adapters/ap4m-voucher.mjs';
export { createGovernance, buildMissionCertificate, approveCertificate, verifyCertificate, certificateDigest, STATES, REFUSALS } from './governance.mjs';
export { assertAdapter, unmetProof } from './contract.mjs';
export const ADAPTERS = Object.freeze([paychan, rlusd, sponsored, ap4m]);
