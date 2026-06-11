/**
 * nightroom — deploy.ts
 *
 * Pure CLI deployment script. No browser, no window.midnight, no Lace/1AM extension.
 * Based on the official Midnight ZK Loan tutorial (docs/tutorials/zk-loan/cli.mdx).
 *
 * Prerequisites:
 *   1. Local network running: cd ~/midnight-local-dev && npm start
 *   2. Contract compiled:     cd ~/nightroom && yarn compile
 *
 * Usage:
 *   DEPLOYER_MNEMONIC="word1 ... word24" yarn deploy
 */

import 'dotenv/config';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey as UnshieldedPublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as bip39 from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';

// ── Required for Midnight SDK's GraphQL subscriptions in Node.js ──────────────
// @ts-expect-error global WebSocket needed by Apollo/subscriptions
globalThis.WebSocket = WebSocket;

// ── Config ────────────────────────────────────────────────────────────────────

const NETWORK_ID = 'undeployed';

const ENDPOINTS = {
  indexer:     'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS:   'ws://127.0.0.1:8088/api/v4/graphql/ws',
  // NOTE: relayURL must use ws:// — the SDK converts http->ws internally,
  // but supply ws:// directly to be explicit.
  node:        'ws://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
} as const;

const currentDir = path.resolve(fileURLToPath(import.meta.url), '..');
const ZK_CONFIG_PATH = path.resolve(
  currentDir, '..', '..', 'contracts', 'managed', 'nightroom',
);

// ── Simple logger ─────────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => console.log(`[INFO]  ${msg}`),
  warn: (msg: string) => console.warn(`[WARN]  ${msg}`),
  ok:   (msg: string) => console.log(`[ OK ]  ${msg}`),
  err:  (msg: string) => console.error(`[ERR]  ${msg}`),
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface WalletContext {
  wallet:            WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey:      ledger.DustSecretKey;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
}

// ── Wallet initialization ─────────────────────────────────────────────────────

async function mnemonicToSeed(mnemonic: string): Promise<Buffer> {
  const words = mnemonic.trim().split(/\s+/).join(' ');
  if (!bip39.validateMnemonic(words, english)) {
    throw new Error('Invalid mnemonic phrase — check your 24 words.');
  }
  const seed = await bip39.mnemonicToSeed(words);
  return Buffer.from(seed);
}

async function initWalletWithSeed(seed: Buffer): Promise<WalletContext> {
  const hdResult = HDWallet.fromSeed(seed);
  if (hdResult.type !== 'seedOk') {
    throw new Error('HDWallet.fromSeed failed — invalid seed.');
  }

  const derivationResult = hdResult.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== 'keysDerived') {
    throw new Error('Key derivation failed.');
  }

  // Clear the HD wallet from memory after key extraction
  hdResult.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(
    derivationResult.keys[Roles.Zswap],
  );
  const dustSecretKey = ledger.DustSecretKey.fromSeed(
    derivationResult.keys[Roles.Dust],
  );
  const unshieldedKeystore = createKeystore(
    derivationResult.keys[Roles.NightExternal],
    NETWORK_ID as any,
  );

  // Build per-wallet configs (relayURL uses ws://)
  const relayURL = new URL(ENDPOINTS.node);
  const indexerClientConnection = {
    indexerHttpUrl: ENDPOINTS.indexer,
    indexerWsUrl:   ENDPOINTS.indexerWS,
  };

  const shieldedConfig = {
    networkId: NETWORK_ID,
    indexerClientConnection,
    provingServerUrl: new URL(ENDPOINTS.proofServer),
    relayURL,
  };

  const unshieldedConfig = {
    networkId: NETWORK_ID,
    indexerClientConnection,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };

  const dustConfig = {
    networkId: NETWORK_ID,
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    indexerClientConnection,
    provingServerUrl: new URL(ENDPOINTS.proofServer),
    relayURL,
  };

  // WalletFacade.init takes factory functions — constructor is private in v3+
  const unifiedConfig = { ...shieldedConfig, ...unshieldedConfig, ...dustConfig };

  const facade = await WalletFacade.init({
    configuration: unifiedConfig,
    shielded: () =>
      ShieldedWallet(shieldedConfig).startWithSecretKeys(shieldedSecretKeys),
    unshielded: () =>
      UnshieldedWallet(unshieldedConfig).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(unshieldedKeystore),
      ),
    dust: () =>
      DustWallet(dustConfig).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });

  // start() wires the shielded and dust key material into the facade
  await facade.start(shieldedSecretKeys, dustSecretKey);

  return { wallet: facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// ── Sync helpers ──────────────────────────────────────────────────────────────

function waitForSync(wallet: WalletFacade): Promise<void> {
  return Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap((s: any) => log.info(`Wallet sync — synced: ${s.isSynced}`)),
      Rx.filter((s: any) => s.isSynced),
    ),
  ).then(() => undefined);
}

async function checkBalance(wallet: WalletFacade): Promise<bigint> {
  const state: any = await Rx.firstValueFrom(wallet.state());
  const unshielded = state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n;
  const shielded   = state.shielded?.balances[ledger.nativeToken().raw]   ?? 0n;
  const dust       = state.dust?.balance(new Date()) ?? 0n;
  log.info(`Unshielded NIGHT: ${unshielded}`);
  log.info(`Shielded   NIGHT: ${shielded}`);
  log.info(`DUST (fees):       ${dust}`);
  return unshielded + shielded;
}

async function registerDust(ctx: WalletContext): Promise<void> {
  const state: any = await Rx.firstValueFrom(
    ctx.wallet.state().pipe(Rx.filter((s: any) => s.isSynced)),
  );

  const unregistered = (state.unshielded?.availableCoins ?? []).filter(
    (coin: any) => coin.meta.registeredForDustGeneration === false,
  );

  if (unregistered.length === 0) {
    log.info('No unregistered Night UTXOs — skipping dust registration.');
    return;
  }

  log.info(`Registering ${unregistered.length} NIGHT UTXO(s) for dust generation…`);

  const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
    unregistered,
    ctx.unshieldedKeystore.getPublicKey(),
    (payload: any) => ctx.unshieldedKeystore.signData(payload),
  );
  const finalizedTx = await ctx.wallet.finalizeRecipe(recipe);
  const txId = await ctx.wallet.submitTransaction(finalizedTx);
  log.ok(`Dust registration submitted — tx: ${txId}`);

  // Wait for dust to appear
  await Rx.firstValueFrom(
    ctx.wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap((s: any) => log.info(`Dust balance: ${s.dust?.balance(new Date()) ?? 0n}`)),
      Rx.filter((s: any) => (s.dust?.balance(new Date()) ?? 0n) > 0n),
    ),
  );
  log.ok('Dust registration complete!');
}

// ── Providers ─────────────────────────────────────────────────────────────────

function buildProviders(ctx: WalletContext) {
  setNetworkId(NETWORK_ID);

  const zkConfigProvider = new NodeZkConfigProvider('/home/guto/nightroom/contracts/managed/nightroom') as any;

  const walletAndMidnight = {
    getCoinPublicKey:       () => ctx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => ctx.shieldedSecretKeys.encryptionPublicKey,

    async balanceTx(tx: any, ttl?: Date) {
      const txTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: txTtl },
      );
      return ctx.wallet.finalizeRecipe(recipe);
    },

    async submitTx(tx: any) {
      return ctx.wallet.submitTransaction(tx);
    },
  };

  return {
    walletProvider:    walletAndMidnight,
    midnightProvider:  walletAndMidnight,
    publicDataProvider: indexerPublicDataProvider(ENDPOINTS.indexer, ENDPOINTS.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(ENDPOINTS.proofServer, zkConfigProvider),
    privateStateProvider: levelPrivateStateProvider({
      dbPath: './.nightroom-private-state',
      accountId: ctx.shieldedSecretKeys.coinPublicKey.toString(),
      privateStoragePasswordProvider: () => Promise.resolve('nightroom-deploy-dev-password-32chars'),
    }),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) {
    log.err('DEPLOYER_MNEMONIC env var is not set.');
    process.exit(1);
  }

  const ownerTaxId = process.env.OWNER_TAX_ID ?? 'DEV_PLACEHOLDER';
  if (!process.env.OWNER_TAX_ID) {
    log.warn('OWNER_TAX_ID not set — using dev placeholder.');
  }

  let ctx: WalletContext | undefined;

  try {
    // 1. Derive keys from mnemonic
    log.info('Deriving keys from mnemonic…');
    const seed = await mnemonicToSeed(mnemonic);
    ctx = await initWalletWithSeed(seed);

    log.info(
      `Wallet address (unshielded): ${ctx.unshieldedKeystore.getBech32Address().asString()}`,
    );

    // 2. Sync
    log.info('Syncing wallet with local node…');
    await waitForSync(ctx.wallet);

    // 3. Check balance
    const balance = await checkBalance(ctx.wallet);
    if (balance === 0n) {
      log.err(
        'Wallet has no NIGHT. Fund it via midnight-local-dev menu option 2, then re-run.',
      );
      process.exit(1);
    }

    // 4. Register NIGHT for DUST (required for tx fees)
    await registerDust(ctx);

    // 5. Build providers
    log.info('Building contract providers…');
    const providers = buildProviders(ctx);

    // 6. Deploy
    log.info('Deploying nightroom contract…');

    // Import your compiled contract — adjust the import path as needed
    const Nightroom = await import('../../contracts/managed/nightroom/contract/index.js' as any);
    // Pad ownerTaxId to 32 bytes
    const ownerTaxIdBytes = new Uint8Array(32);
    const encoded = new TextEncoder().encode(ownerTaxId);
    ownerTaxIdBytes.set(encoded.slice(0, 32));
    const witnesses = {
      owner_tax_id: () => ownerTaxIdBytes,
      guest_secret: () => new Uint8Array(32),
      current_timestamp: () => Math.floor(Date.now() / 1000),
    };
    const contractInstance = new Nightroom.Contract(witnesses);
    const compiled = CompiledContract.make('Nightroom', Nightroom.Contract)
      .pipe(CompiledContract.withWitnesses(witnesses), CompiledContract.withCompiledFileAssets(ZK_CONFIG_PATH)) as any;
    const deployed = await deployContract(providers as any, {
      compiledContract: compiled,
      privateStateId: 'nightroomPrivateState',
      initialPrivateState: { ownerTaxId },
      args: [false, new Uint8Array(32)] as any,
    });

    log.ok(
      `Contract deployed at: ${deployed.deployTxData.public.contractAddress}`,
    );
    log.ok(
      `Deployment tx: ${deployed.deployTxData.public.txId} (block ${deployed.deployTxData.public.blockHeight})`,
    );

    // Persist address for CLI use
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      'deployed-address.txt',
      deployed.deployTxData.public.contractAddress,
      'utf8',
    );
    log.ok('Address saved to deployed-address.txt');

  } catch (err: any) {
    log.err(`Deployment failed. ${err}`);
    console.error(err);
    process.exit(1);
  } finally {
    if (ctx) {
      try { await ctx.wallet.stop(); } catch { /* ignore */ }
    }
  }
}

main();