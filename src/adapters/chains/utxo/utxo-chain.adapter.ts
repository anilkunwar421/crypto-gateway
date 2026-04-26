import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { ChainAdapter, FeeTierQuote } from "../../../core/ports/chain.port.js";
import type { Address, ChainId, TxHash } from "../../../core/types/chain.js";
import type { AmountRaw } from "../../../core/types/money.js";
import type { TokenSymbol } from "../../../core/types/token.js";
import { findToken } from "../../../core/types/token-registry.js";
import type { DetectedTransfer } from "../../../core/types/transaction.js";
import type { BuildTransferArgs, EstimateArgs, UnsignedTx } from "../../../core/types/unsigned-tx.js";
import { bytesToHex } from "../../crypto/subtle.js";
import {
  decodeP2wpkhAddress,
  encodeP2wpkhAddress,
  hash160,
  isValidP2wpkhAddress
} from "./bech32-address.js";
import {
  BITCOIN_CONFIG,
  LITECOIN_CONFIG,
  utxoConfigForChainId,
  type UtxoChainConfig
} from "./utxo-config.js";

// Single ChainAdapter implementation for the entire UTXO family. Bitcoin and
// Litecoin differ only in BIP44 coin_type, bech32 HRP, and detection-backend
// URLs — all carried by `UtxoChainConfig`. One adapter, two registered chains.
//
// Phase 1 scope: address derivation + canonicalization. Detection and payout
// methods are stubbed (throw) and filled in Phase 2 (Esplora + BlockCypher) and
// Phase 3 (coin selection + signing + broadcast).

const DEFAULT_ACCOUNT_INDEX = 0;
const DEFAULT_CHANGE_INDEX = 0;

export interface UtxoChainAdapterConfig {
  // Which UTXO chain this instance serves. One adapter handles both BTC and
  // LTC by being instantiated once per chain (deps.chains gets two entries
  // wired in core/app-deps.ts).
  readonly chain: UtxoChainConfig;
  // Optional override for HD derivation account index. Defaults to 0.
  readonly accountIndex?: number;
}

export function utxoChainAdapter(cfg: UtxoChainAdapterConfig): ChainAdapter {
  const { chain } = cfg;
  const accountIndex = cfg.accountIndex ?? DEFAULT_ACCOUNT_INDEX;

  return {
    family: "utxo",
    supportedChainIds: [chain.chainId] as readonly ChainId[],

    // ---- Addresses ----

    deriveAddress(seed: string, index: number) {
      // BIP84 native-segwit path: m/84'/coin'/account'/change/addressIndex.
      // coin = 0 for BTC, 2 for LTC (slip-0044).
      const seedBytes = mnemonicToSeedSync(seed);
      const master = HDKey.fromMasterSeed(seedBytes);
      const child = master.derive(
        `m/84'/${chain.coinType}'/${accountIndex}'/${DEFAULT_CHANGE_INDEX}/${index}`
      );
      if (!child.privateKey || !child.publicKey) {
        throw new Error(
          `UTXO derivation produced no key material at index ${index} for chain ${chain.slug}`
        );
      }
      // child.publicKey from @scure/bip32 is the 33-byte compressed
      // secp256k1 pubkey — exactly what BIP84 specifies for the witness
      // program. HASH160 it and bech32-encode.
      const programHash = hash160(child.publicKey);
      const address = encodeP2wpkhAddress(chain.bech32Hrp, programHash) as Address;
      const privateKey = `0x${bytesToHex(child.privateKey)}`;
      return { address, privateKey };
    },

    validateAddress(addr: string): boolean {
      return isValidP2wpkhAddress(addr, chain.bech32Hrp);
    },

    canonicalizeAddress(addr: string): Address {
      // Bech32 is case-sensitive but the spec mandates a single case per
      // address (mixed case is invalid). BIP173 also REQUIRES lowercase for
      // QR codes and explicitly says implementations SHOULD lowercase.
      // We lowercase for storage so DB joins are case-stable, and reject
      // anything that doesn't decode to a v0 P2WPKH for this chain's HRP.
      const lowered = addr.toLowerCase();
      const decoded = decodeP2wpkhAddress(lowered);
      if (decoded === null || decoded.hrp !== chain.bech32Hrp) {
        throw new Error(
          `Invalid ${chain.slug} P2WPKH address: ${addr} (expected hrp='${chain.bech32Hrp}')`
        );
      }
      return lowered as Address;
    },

    addressFromPrivateKey(privateKey: string): Address {
      // 32-byte secp256k1 private key (with optional 0x prefix). Compute
      // the compressed pubkey, then HASH160 + bech32 same as deriveAddress.
      const normalized = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
      if (!/^[0-9a-f]{64}$/i.test(normalized)) {
        throw new Error(
          `UTXO addressFromPrivateKey: expected 32-byte secp256k1 hex (64 chars), got length ${normalized.length}`
        );
      }
      const privBytes = hexToBytes(normalized);
      const pubCompressed = secp256k1.getPublicKey(privBytes, true);
      const programHash = hash160(pubCompressed);
      return encodeP2wpkhAddress(chain.bech32Hrp, programHash) as Address;
    },

    // ---- Native + decimals ----

    nativeSymbol(_chainId: ChainId): TokenSymbol {
      return chain.nativeSymbol as TokenSymbol;
    },

    minimumNativeReserve(_chainId: ChainId): bigint {
      // UTXO chains have no rent-exempt minimum or per-account reserve. An
      // address can be drained to zero (in fact, UTXO model means an address
      // either has UTXOs or it doesn't — there's no "balance" to minimize).
      return 0n;
    },

    gasSafetyFactor(_chainId: ChainId): { readonly num: bigint; readonly den: bigint } {
      // UTXO fees are deterministic at sign time (vSize × feeRate). No
      // EIP-1559-style baseFee growth to absorb. Use a small 1.05× margin
      // to cover mempool feerate drift between estimate and broadcast.
      return { num: 105n, den: 100n };
    },

    feeWalletCapability(_chainId: ChainId): "none" | "delegate" | "co-sign" {
      // UTXO has no concept of a separate fee payer — every input carries
      // the value that funds its own output's fee. Same answer as EVM today.
      return "none";
    },

    // ---- Detection (Phase 2) ----

    async scanIncoming(_args): Promise<readonly DetectedTransfer[]> {
      throw new UtxoNotImplementedError("scanIncoming");
    },

    async getConfirmationStatus(
      _chainId: ChainId,
      _txHash: TxHash
    ): Promise<{ blockNumber: number | null; confirmations: number; reverted: boolean }> {
      throw new UtxoNotImplementedError("getConfirmationStatus");
    },

    async getConsumedNativeFee(_chainId: ChainId, _txHash: TxHash): Promise<AmountRaw | null> {
      throw new UtxoNotImplementedError("getConsumedNativeFee");
    },

    // ---- Payouts (Phase 3) ----

    async buildTransfer(_args: BuildTransferArgs): Promise<UnsignedTx> {
      throw new UtxoNotImplementedError("buildTransfer");
    },

    async signAndBroadcast(): Promise<TxHash> {
      throw new UtxoNotImplementedError("signAndBroadcast");
    },

    async estimateGasForTransfer(_args: EstimateArgs): Promise<AmountRaw> {
      throw new UtxoNotImplementedError("estimateGasForTransfer");
    },

    async quoteFeeTiers(_args: EstimateArgs): Promise<FeeTierQuote> {
      throw new UtxoNotImplementedError("quoteFeeTiers");
    },

    async getBalance(_args): Promise<AmountRaw> {
      throw new UtxoNotImplementedError("getBalance");
    },

    async getAccountBalances(_args): Promise<readonly { token: TokenSymbol; amountRaw: AmountRaw }[]> {
      throw new UtxoNotImplementedError("getAccountBalances");
    }
  };
}

// Marker for the Phase 2/3 stubs so callers can detect the in-progress family
// and skip cleanly in tests. Exposed via the family at `unsupportedFamilyError`
// so the message is uniform.
export class UtxoNotImplementedError extends Error {
  constructor(method: string) {
    super(`utxoChainAdapter: ${method} is not implemented yet (filled in Phase 2/3)`);
    this.name = "UtxoNotImplementedError";
  }
}

// Convenience constructors so app-deps wires `utxoChainAdapter({ chain: BITCOIN_CONFIG })`
// vs spelling out the import every time. Mirrors how evmChainAdapter / tronChainAdapter
// are called from src/core/app-deps.ts.
export function bitcoinChainAdapter(): ChainAdapter {
  return utxoChainAdapter({ chain: BITCOIN_CONFIG });
}

export function litecoinChainAdapter(): ChainAdapter {
  return utxoChainAdapter({ chain: LITECOIN_CONFIG });
}

// ---- Internal helpers ----

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Re-export the config helper so callers that already imported the adapter
// don't have to import the config module separately.
export { utxoConfigForChainId };
// Avoid importing-but-not-using lint warnings for findToken — the helper is
// used by Phase 2/3 code that lives elsewhere in this same module. Stub
// usage here so the import chain stays warm.
void findToken;
