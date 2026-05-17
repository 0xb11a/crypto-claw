# Squads V4 Multisig Account Fixture

## File: `multisig-account.b64`

### Source

**Option C — synthesized from SDK** (per handoff instructions, option C fallback after confirming Option A has no bundled fixtures and Option B devnet fetch is skipped in offline CI).

The fixture was generated on **2026-05-17** using `@sqds/multisig@2.1.4`'s own `Multisig.fromArgs()` + `serialize()` call. This proves the parser round-trips with the SDK's own writer — which is exactly the class of bug (wrong Borsh offsets) that the fixture guard is designed to catch.

Round-trip verified: `Multisig.fromAccountInfo({ data: buf }, 0)` returns the known values below.

### Known values

| Field | Value |
|---|---|
| `members.length` | 2 |
| `members[0]` | `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJ` |
| `members[1]` | `FuZKoM79bvpvMmGNrjbPs8CobYSxQBNQXzHhzFJHHPPe` |
| `threshold` | 2 |
| `transactionIndex` | 42 |
| `bump` | 255 |

### Serialized length

166 bytes (base64 encoded: 224 characters + newline).

### Discriminator

`[224, 116, 121, 186, 68, 161, 79, 236]` — the Squads V4 Multisig account discriminator, encoded as the first 8 bytes of the buffer.

### Regeneration

If `@sqds/multisig` is upgraded and the Borsh layout changes, regenerate with:

```js
const sqds = require('@sqds/multisig');
const { PublicKey } = require('@solana/web3.js');
const multisig = sqds.accounts.Multisig.fromArgs({
  createKey: new PublicKey('11111111111111111111111111111111'),
  configAuthority: new PublicKey('11111111111111111111111111111111'),
  threshold: 2,
  timeLock: 0,
  transactionIndex: BigInt(42),
  staleTransactionIndex: BigInt(0),
  rentCollector: null,
  bump: 255,
  members: [
    { key: new PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJ'), permissions: { mask: 7 } },
    { key: new PublicKey('FuZKoM79bvpvMmGNrjbPs8CobYSxQBNQXzHhzFJHHPPe'), permissions: { mask: 7 } },
  ],
});
const [buf] = multisig.serialize();
console.log(buf.toString('base64'));
```

Update this README with the new base64, byte count, and SDK version.
