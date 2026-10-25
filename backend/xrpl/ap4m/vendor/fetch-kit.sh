#!/bin/sh
# Fetch the AP4M hackathon kit into ap4m/vendor/kit/ UNMODIFIED and verify each file against MANIFEST.json.
# Text download only: this script never runs, installs or imports the kit. vendor/kit/ is git-ignored (hackathon-only terms).
# Installing the SDK package (npm install) is a separate, owner-approved step in RUNBOOK.md (step 0).
set -eu
here=$(cd "$(dirname "$0")" && pwd); out="$here/kit"; mkdir -p "$out"
base=https://hackathon.ap4m.build/sdk
for f in AGENTS.md README.md ap4m-hackathon-sdk.js ap4m-x402.mjs example-x402-agent.mjs example-x402-merchant.mjs verify-receipt.mjs ap4m-sdk.tgz; do
  curl -fsS --max-time 30 "$base/$f" -o "$out/$f"
  want=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['files'][sys.argv[2]])" "$here/MANIFEST.json" "$f")
  got=$(shasum -a 256 "$out/$f" | cut -d' ' -f1)
  if [ "$want" != "$got" ]; then echo "HASH MISMATCH $f: kit changed upstream; re-inspect before use" >&2; exit 3; fi
  echo "ok $f"
done
rm -rf "$out/sdk-package" && mkdir -p "$out/sdk-package" && tar -xzf "$out/ap4m-sdk.tgz" -C "$out/sdk-package" --strip-components 1
echo "kit verified in $out (not installed, not executed)"
