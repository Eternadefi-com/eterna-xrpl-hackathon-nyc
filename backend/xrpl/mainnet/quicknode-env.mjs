// Loads the operator's Quicknode XRPL Mainnet endpoint (contains an API token) from a private file into the environment.
// File: ~/eterna-private/quicknode/xrpl-mainnet.url (0600). Import this first in operator scripts; never log the URL.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
const f = `${homedir()}/eterna-private/quicknode/xrpl-mainnet.url`;
if (!process.env.QUICKNODE_XRPL_MAINNET_URL && existsSync(f)) process.env.QUICKNODE_XRPL_MAINNET_URL = readFileSync(f, 'utf8').trim();
export const quicknodeConfigured = Boolean(process.env.QUICKNODE_XRPL_MAINNET_URL);
