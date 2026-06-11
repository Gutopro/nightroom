import path                                        from 'node:path';
import { fileURLToPath }                           from 'node:url';
import { createInterface }                         from 'node:readline';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { WebSocket }                               from 'ws';
import * as ledger                                 from '@midnight-ntwrk/ledger-v8';
import { setNetworkId }                            from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, findDeployedContract }    from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract }                        from '@midnight-ntwrk/compact-js';
import { httpClientProofProvider }                 from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider }               from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider }               from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider }                    from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { WalletFacade }                            from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet }                              from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles }                         from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet }                          from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey as UnshieldedPublicKey,
  UnshieldedWallet,
}                                                  from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import * as bip39                                  from '@scure/bip39';
import { wordlist as english }                     from '@scure/bip39/wordlists/english.js';
import * as Rx                                     from 'rxjs';
import { Contract, pureCircuits }                  from '../../contracts/managed/nightroom/contract/index.js';
import {
  witnesses,
  createOwnerPrivateState,
  taxIdToBytes,
  generateNonce,
}                                                  from './witnesses.js';

(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;

const NETWORK_ID   = 'undeployed' as const;
const ENDPOINTS = {
  indexer:     'http://127.0.0.1:8088/api/v3/graphql',
  indexerWS:   'ws://127.0.0.1:8088/api/v3/graphql/ws',
  node:        'ws://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
} as const;

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const ZK_PATH     = path.resolve(__dirname, '../../contracts/managed/nightroom');
const STATE_STORE = 'nightroom-cli-state';
const DEPLOY_FILE = path.resolve(__dirname, '../../deployment.json');

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  blue:   (s: string) => `\x1b[34m${s}\x1b[0m`,
};
const bar  = () => console.log(C.dim('  ' + '─'.repeat(54)));
const gap  = () => console.log();

// ── Last-action status (persists between menu renders) ────────────────────────
type ActionStatus = { ok: boolean; msg: string } | null;
let lastAction: ActionStatus = null;

function setOk(msg: string)   { lastAction = { ok: true,  msg }; }
function setErr(msg: string)  { lastAction = { ok: false, msg }; }

function printStatus() {
  if (!lastAction) return;
  const icon = lastAction.ok ? C.green('  ✔') : C.red('  ✖');
  console.log(icon + '  ' + (lastAction.ok ? C.green(lastAction.msg) : C.red(lastAction.msg)));
  bar();
}

// ── Logging ───────────────────────────────────────────────────────────────────
const log = {
  info:    (msg: string) => console.log(C.cyan('  ℹ') + '  ' + msg),
  ok:      (msg: string) => console.log(C.green('  ✔') + '  ' + msg),
  warn:    (msg: string) => console.warn(C.yellow('  ⚠') + '  ' + msg),
  error:   (msg: string) => console.error(C.red('  ✖') + '  ' + msg),
  section: (msg: string) => { gap(); console.log(C.bold(C.blue('  ══  ' + msg + '  ══'))); bar(); },
};

// ── Input helpers ─────────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string, hint?: string): Promise<string> => {
  const h = hint ? C.dim(` (${hint})`) : '';
  return new Promise(r => rl.question('  ' + C.cyan('›') + ' ' + q + h + ' ', r));
};

async function askRequired(q: string, hint?: string): Promise<string> {
  while (true) {
    const v = (await ask(q, hint)).trim();
    if (v) return v;
    log.warn('This field is required.');
  }
}
async function askBigUint(q: string, max: bigint, hint?: string): Promise<bigint> {
  while (true) {
    try {
      const v = BigInt((await ask(q, hint)).trim());
      if (v >= 0n && v <= max) return v;
      log.warn(`Must be between 0 and ${max}.`);
    } catch { log.warn('Enter a valid integer.'); }
  }
}
async function askUnixTs(q: string): Promise<bigint> {
  while (true) {
    const raw = (await ask(q, 'unix seconds e.g. 1750000000')).trim();
    try {
      const v = BigInt(raw);
      if (v > 0n) {
        log.info(`  → ${new Date(Number(v) * 1000).toUTCString()}`);
        return v;
      }
    } catch { /* fall through */ }
    log.warn('Enter a valid unix timestamp.');
  }
}
async function confirm(q: string): Promise<boolean> {
  const v = (await ask(q, 'y / n')).trim().toLowerCase();
  return v === 'y' || v === 'yes';
}

// ── Wallet bootstrap ──────────────────────────────────────────────────────────
async function buildWallet(mnemonic: string) {
  log.info('Validating mnemonic...');
  if (!bip39.validateMnemonic(mnemonic.trim(), english))
    throw new Error('Invalid mnemonic — check your 24 words.');

  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic.trim()));
  const hdResult = HDWallet.fromSeed(seed);
  if (hdResult.type !== 'seedOk') throw new Error('HDWallet seed error.');

  const derivation = hdResult.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derivation.type !== 'keysDerived') throw new Error('Key derivation failed.');
  hdResult.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivation.keys[Roles.Zswap]);
  const dustSecretKey      = ledger.DustSecretKey.fromSeed(derivation.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derivation.keys[Roles.NightExternal], NETWORK_ID as any);

  const relay = new URL(ENDPOINTS.node);
  const indexer = { indexerHttpUrl: ENDPOINTS.indexer, indexerWsUrl: ENDPOINTS.indexerWS };
  const shCfg  = { networkId: NETWORK_ID, indexerClientConnection: indexer, provingServerUrl: new URL(ENDPOINTS.proofServer), relayURL: relay };
  const unCfg  = { networkId: NETWORK_ID, indexerClientConnection: indexer, txHistoryStorage: new InMemoryTransactionHistoryStorage() };
  const duCfg  = { networkId: NETWORK_ID, costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 }, indexerClientConnection: indexer, provingServerUrl: new URL(ENDPOINTS.proofServer), relayURL: relay };
  const uniCfg = { ...shCfg, ...unCfg, ...duCfg };

  log.info('Initialising wallet...');
  const facade = await WalletFacade.init({
    configuration: uniCfg,
    shielded:   () => ShieldedWallet(shCfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: () => UnshieldedWallet(unCfg).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(unshieldedKeystore)),
    dust:       () => DustWallet(duCfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);

  log.info('Syncing with network...');
  await Rx.firstValueFrom(facade.state().pipe(Rx.filter((s: any) => s.isSynced)));
  log.ok('Wallet ready.');
  return { facade, shieldedSecretKeys, dustSecretKey };
}

function buildProviders(wallet: WalletFacade, shieldedSecretKeys: any, dustSecretKey: any) {
  const wp = {
    getCoinPublicKey:       () => shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys, dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return wallet.finalizeRecipe(recipe);
    },
    async submitTransaction(tx: any) { return wallet.submitTransaction(tx); },
    async submitTx(tx: any) { return wallet.submitTransaction(tx); },
  };
  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: 'midnight-level-db',
      privateStateStoreName: STATE_STORE,
      accountId: 'nightroom-owner-account',
      privateStoragePasswordProvider: () => Promise.resolve('nightroom-cli-dev-password-32chars'),
    }),
    zkConfigProvider:   new NodeZkConfigProvider(ZK_PATH),
    proofProvider:      httpClientProofProvider(ENDPOINTS.proofServer, new NodeZkConfigProvider(ZK_PATH)),
    publicDataProvider: indexerPublicDataProvider(ENDPOINTS.indexer, ENDPOINTS.indexerWS),
    walletProvider:     wp,
    midnightProvider:   wp,
  };
}

function makeCompiled() {
  return CompiledContract.make('Nightroom', Contract)
    .pipe(CompiledContract.withWitnesses(witnesses), CompiledContract.withCompiledFileAssets(ZK_PATH)) as any;
}

function savedAddress(): string | null {
  if (!existsSync(DEPLOY_FILE)) return null;
  try { return JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')).contractAddress ?? null; } catch { return null; }
}

function savedOwnerNonce(): Uint8Array | null {
  if (!existsSync(DEPLOY_FILE)) return null;
  try {
    const hex = JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')).ownerNonce;
    if (!hex) return null;
    return Buffer.from(hex, 'hex');
  } catch { return null; }
}

// Tracks the address of the currently connected contract for getLedger
let currentAddress: string | null = null;

// ── Ledger helpers ────────────────────────────────────────────────────────────
async function getLedger(dc: any, providers: ReturnType<typeof buildProviders>): Promise<any> {
  const addr = dc?.deployTxData?.public?.contractAddress ?? currentAddress;
  if (!addr) throw new Error('No contract address — connect to a contract first.');

  const contractState: any = await Rx.firstValueFrom(
    providers.publicDataProvider.contractStateObservable(addr, { type: 'latest' })
  );
  if (!contractState) throw new Error(
    `No on-chain state for ${addr.slice(0,16)}… — is the indexer running?`
  );

  const stateArr: any[] = contractState.data.state.asArray();

  // Owner: stateArr[0].asCell().value = [is_verified: Uint8Array, commitment: Uint8Array]
  const ownerFields: Uint8Array[] = stateArr[0].asCell().value;
  const isVerified = ownerFields[0]?.length > 0 && ownerFields[0][0] !== 0;
  const commitment = ownerFields[1] ?? new Uint8Array(32);

  // Rooms: stateArr[1].asMap() → StateMap with .keys() → Uint8Array[], .get(key) → cell
  const roomsMap = new Map<number, any>();
  const stateMap = stateArr[1].asMap();
  const roomKeys: Uint8Array[] = stateMap.keys();

  const leBytes = (b: Uint8Array | undefined) => {
    if (!b || b.length === 0) return 0n;
    let v = 0n;
    for (let i = 0; i < b.length; i++) v |= BigInt(b[i]) << BigInt(i * 8);
    return v;
  };

  for (const key of roomKeys) {
    // Key is { value: [{"0": N, "1": M, ...}], alignment: [...] }
    // Extract the room ID from the first value object
    const keyObj = (key as any).value?.[0] ?? {};
    let roomId = 0;
    if (keyObj instanceof Uint8Array) {
      // fallback: little-endian bytes
      for (let i = 0; i < keyObj.length; i++) roomId |= keyObj[i] << (i * 8);
    } else {
      // object with numeric string keys — little-endian byte values
      const byteKeys = Object.keys(keyObj).sort((a,b) => Number(a)-Number(b));
      for (let i = 0; i < byteKeys.length; i++) roomId |= (keyObj[byteKeys[i]] << (i * 8));
    }
    const roomVal = stateMap.get(key);
    const fields: Uint8Array[] = roomVal.asCell().value;
    roomsMap.set(roomId, {
      room_number:        leBytes(fields[0]),
      price_per_night:    leBytes(fields[1]),
      description:        new TextDecoder().decode(fields[2]).replace(/\x00+$/, ''),
      status:             Number(leBytes(fields[3])),
      has_booking:        Array.isArray(fields[4]) ? fields[4].some((b: number) => b !== 0) : (fields[4]?.[0] !== 0 && fields[4]?.length > 0 && fields[4]?.[0] === 1),
      booking_commitment: fields[5],
      check_in_date:      leBytes(fields[6]),
      check_out_date:     leBytes(fields[7]),
      checkout_status:    Number(leBytes(fields[8])),
      caution_fee:        leBytes(fields[9]),
      caution_escrowed:   leBytes(fields[10]),
      booking_escrowed:   leBytes(fields[11]),
      total_nights:       leBytes(fields[12]),
      damage_claim_count: leBytes(fields[13]),
    });
  }

  const countFields: Uint8Array[] = stateArr[2].asCell().value;
  const roomCount = Number(leBytes(countFields?.[0] ?? new Uint8Array(2)));

  return { owner: { isVerified, commitment }, rooms: roomsMap, roomCount };
}

async function getRooms(dc: any, providers: ReturnType<typeof buildProviders>): Promise<Map<number, any>> {
  const state = await getLedger(dc, providers);
  const rooms = state?.rooms;
  if (!rooms) return new Map();
  if (typeof rooms.entries === 'function') return new Map([...rooms.entries()].map(([k,v]: any) => [Number(k), v]));
  return new Map(Object.entries(rooms).map(([k,v]) => [Number(k), v]));
}

function roomStatusLabel(s: number) {
  return s === 0 ? C.green('Available') : C.yellow('Booked');
}
function checkoutStatusLabel(s: number) {
  return s === 0 ? C.dim('None') : s === 1 ? C.yellow('Guest confirmed') : C.green('Complete');
}

function printRoom(id: number, r: any) {
  const rows: [string, string][] = [
    ['Room number',      String(r.room_number)],
    ['Status',           roomStatusLabel(Number(r.status))],
    ['Price / night',    String(r.price_per_night) + ' units'],
    ['Caution fee',      String(r.caution_fee) + ' units'],
    ['Has booking',      r.has_booking ? C.yellow('Yes') : 'No'],
    ['Check-in',         r.check_in_date && r.check_in_date !== 0n ? new Date(Number(r.check_in_date)*1000).toUTCString() : '—'],
    ['Check-out',        r.check_out_date && r.check_out_date !== 0n ? new Date(Number(r.check_out_date)*1000).toUTCString() : '—'],
    ['Total nights',     String(r.total_nights)],
    ['Checkout status',  checkoutStatusLabel(Number(r.checkout_status))],
    ['Caution escrowed', String(r.caution_escrowed) + ' units'],
    ['Booking escrowed', String(r.booking_escrowed) + ' units'],
    ['Damage claims',    String(r.damage_claim_count)],
  ];
  console.log(C.bold(`\n  Room ${id}`));
  for (const [k, v] of rows)
    console.log(`    ${C.dim(k.padEnd(18))} ${v}`);
}

// ── Contract actions ──────────────────────────────────────────────────────────
async function doDeploy(providers: ReturnType<typeof buildProviders>, ownerTaxIdStr: string) {
  log.section('Deploy Contract');
  const taxId = taxIdToBytes(ownerTaxIdStr);
  const nonce = generateNonce();
  // Compute the real verification commitment so is_verified stays true
  const commitment = pureCircuits.compute_verification_commitment(taxId, nonce);
  const privateState = createOwnerPrivateState(taxId);

  log.info(`Owner tax ID : ${ownerTaxIdStr}`);
  log.info(`Commitment   : ${Buffer.from(commitment as any).toString('hex').slice(0, 16)}…`);
  if (!await confirm('Deploy now?')) { log.warn('Aborted.'); return null; }

  log.info('Submitting deploy transaction (may take ~60 s for proof generation)...');
  const deployed = await deployContract(providers as any, {
    compiledContract: makeCompiled(),
    privateStateId:   'nightroomPrivateState',
    initialPrivateState: privateState,
    args: [true, commitment] as any,   // is_verified = true
  });
  const addr = deployed.deployTxData.public.contractAddress;
  log.ok(`Deployed at: ${C.bold(addr)}`);
  // Save nonce so owner circuits can reuse it for identity proof
  writeFileSync(DEPLOY_FILE, JSON.stringify({
    network: NETWORK_ID,
    contractAddress: addr,
    ownerTaxId: ownerTaxIdStr,
    ownerNonce: Buffer.from(nonce).toString('hex'),
    deployedAt: new Date().toISOString(),
  }, null, 2));
  log.ok('Saved to deployment.json');
  currentAddress = addr;
  setOk(`Contract deployed: ${addr.slice(0, 16)}…`);
  return deployed;
}

async function doJoin(providers: ReturnType<typeof buildProviders>, address: string, ownerTaxIdStr: string) {
  log.info(`Connecting to ${C.bold(address)}...`);
  const taxId = taxIdToBytes(ownerTaxIdStr);
  const result = await findDeployedContract(providers as any, {
    contractAddress: address,
    compiledContract: makeCompiled(),
    privateStateId:  'nightroomPrivateState',
    initialPrivateState: createOwnerPrivateState(taxId),
  });
  // The SDK wraps the handle — unwrap if needed
  const dc = (result as any).deployedContractReceipt ?? (result as any).contract ?? result;
  if (process.env.DEBUG) {
    console.log('[DEBUG] DC keys:', Object.keys(dc ?? {}));
    console.log('[DEBUG] DC proto keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(dc ?? {})));
  }
  currentAddress = address;
  log.ok('Connected.');
  return dc;
}

// ── Sub-menus ─────────────────────────────────────────────────────────────────
async function submenuOwner(dc: any, ownerTaxIdStr: string, providers: ReturnType<typeof buildProviders>) {
  log.section('Owner Actions');
  console.log(`
  ${C.cyan('1')}  List a room
  ${C.cyan('2')}  Cancel a booking
  ${C.cyan('3')}  Confirm checkout   ${C.dim('(after guest confirmed)')}
  ${C.cyan('4')}  Force checkout     ${C.dim('(48 h grace expired)')}
  ${C.cyan('0')}  ← Back
`);
  const ch = (await ask('Choose')).trim();
  switch (ch) {
    case '1': await actionListRoom(dc, ownerTaxIdStr, providers); break;
    case '2': await actionOwnerCancel(dc, ownerTaxIdStr, providers); break;
    case '3': await actionOwnerCheckout(dc, ownerTaxIdStr, providers); break;
    case '4': await actionForceCheckout(dc, ownerTaxIdStr, providers); break;
    case '0': break;
    default: log.warn('Unknown option.');
  }
}

async function submenuGuest(dc: any, providers: ReturnType<typeof buildProviders>) {
  const rooms = await getRooms(dc, providers);
  if (rooms.size === 0) {
    log.warn('No rooms have been listed yet. Ask the owner to list a room first.');
    setErr('No rooms available — listing required before booking.');
    return;
  }
  log.section('Guest Actions');
  console.log(`
  ${C.cyan('1')}  Book a room
  ${C.cyan('2')}  Cancel my booking
  ${C.cyan('3')}  Confirm I have checked out
  ${C.cyan('0')}  ← Back
`);
  const ch = (await ask('Choose')).trim();
  switch (ch) {
    case '1': await actionBookRoom(dc, rooms, providers); break;
    case '2': await actionGuestCancel(dc, providers); break;
    case '3': await actionGuestCheckout(dc, providers); break;
    case '0': break;
    default: log.warn('Unknown option.');
  }
}

async function submenuInfo(dc: any, providers: ReturnType<typeof buildProviders>) {
  log.section('Info');
  console.log(`
  ${C.cyan('1')}  View a specific room
  ${C.cyan('2')}  List all rooms
  ${C.cyan('0')}  ← Back
`);
  const ch = (await ask('Choose')).trim();
  switch (ch) {
    case '1': await actionViewRoom(dc, providers); break;
    case '2': await actionViewAll(dc, providers); break;
    case '0': break;
    default: log.warn('Unknown option.');
  }
}

// ── Individual actions ────────────────────────────────────────────────────────
async function actionListRoom(dc: any, ownerTaxIdStr: string, providers: ReturnType<typeof buildProviders>) {
  log.section('List a Room');
  log.info(`You are listing as: ${C.bold(ownerTaxIdStr)}`);
  bar();
  const roomNumber = await askBigUint('Room number', 255n, '1–255');
  const price      = await askBigUint('Price per night (units)', 18446744073709551615n, 'e.g. 1000000');
  const desc       = await askRequired('Description', 'e.g. Sea view double room');
  const caution    = await askBigUint('Caution / deposit fee (units)', 18446744073709551615n, 'e.g. 50000');
  const nonce = savedOwnerNonce() ?? generateNonce();
  gap();
  log.info(`Room #${roomNumber}  |  Price: ${price}  |  Caution: ${caution}`);
  log.info(`Description: "${desc}"`);
  if (!await confirm('Submit?')) { log.warn('Cancelled.'); return; }
  log.info('Generating proof and submitting (this can take ~60 s)...');
  const tx = await dc.callTx.list_room(roomNumber, price, desc, caution, nonce);
  const txId = tx.public?.txId ?? '(pending)';
  log.ok(`Room listed! TxID: ${txId}`);
  setOk(`Room #${roomNumber} listed successfully.`);
}

async function actionBookRoom(dc: any, rooms: Map<number, any>, providers: ReturnType<typeof buildProviders>) {
  log.section('Book a Room');
  // Show available rooms first
  const available = [...rooms.entries()].filter(([,r]) => Number(r.status) === 0);
  if (available.length === 0) {
    log.warn('All listed rooms are currently booked. Nothing available to book.');
    setErr('No available rooms to book.');
    return;
  }
  console.log(C.bold('\n  Available rooms:'));
  for (const [id, r] of available)
    console.log(`    ${C.cyan(String(id).padEnd(4))} Room #${r.room_number}  —  ${r.price_per_night} units/night`);
  gap();
  const roomId  = await askBigUint('Room ID to book', 4294967295n);
  if (!rooms.has(Number(roomId))) { log.warn(`Room ${roomId} not found.`); setErr(`Room ${roomId} does not exist.`); return; }
  if (Number(rooms.get(Number(roomId))!.status) !== 0) { log.warn('That room is already booked.'); setErr('Room is already booked.'); return; }
  const checkIn  = await askUnixTs('Check-in date');
  const checkOut = await askUnixTs('Check-out date');
  if (checkOut <= checkIn) { log.error('Check-out must be after check-in.'); return; }
  const nights  = await askBigUint('Number of nights', 65535n);
  const room    = rooms.get(Number(roomId))!;
  const expected = room.price_per_night * nights;
  log.info(`Expected total: ${expected} units (${nights} × ${room.price_per_night})`);
  log.info(`Caution fee: ${room.caution_fee} units (escrowed separately by contract)`);
  const payment = await askBigUint('Total payment (units)', 340282366920938463463374607431768211455n, `expected ${expected}`);
  gap();
  if (!await confirm('Submit booking?')) { log.warn('Cancelled.'); return; }
  log.info('Generating proof and submitting...');
  const tx = await dc.callTx.book_room(roomId, checkIn, checkOut, nights, payment);
  log.ok(`Room booked! TxID: ${tx.public?.txId ?? '(pending)'}`);
  setOk(`Room ${roomId} booked for ${nights} night(s).`);
}

async function actionGuestCancel(dc: any, providers: ReturnType<typeof buildProviders>) {
  log.section('Cancel My Booking');
  const rooms = await getRooms(dc, providers);
  const booked = [...rooms.entries()].filter(([,r]) => Number(r.status) !== 0 && r.has_booking);
  if (booked.length === 0) { log.warn('No active bookings found.'); setErr('No bookings to cancel.'); return; }
  console.log(C.bold('\n  Your bookings:'));
  for (const [id, r] of booked)
    console.log(`    ${C.cyan(String(id).padEnd(4))} Room #${r.room_number}`);
  gap();
  const roomId      = await askBigUint('Room ID to cancel', 4294967295n);
  const nightsStayed = await askBigUint('Nights already stayed', 65535n, '0 if none');
  log.warn(`This will cancel booking for room ${roomId}.`);
  if (!await confirm('Confirm cancel?')) { log.warn('Aborted.'); return; }
  log.info('Generating proof and submitting...');
  const tx = await dc.callTx.guest_cancel_booking(roomId, nightsStayed);
  log.ok(`Booking cancelled. TxID: ${tx.public?.txId ?? '(pending)'}`);
  setOk(`Booking for room ${roomId} cancelled.`);
}

async function actionOwnerCancel(dc: any, ownerTaxIdStr: string, providers: ReturnType<typeof buildProviders>) {
  log.section('Owner Cancel Booking');
  log.info(`Acting as owner: ${C.bold(ownerTaxIdStr)}`);
  const rooms = await getRooms(dc, providers);
  const booked = [...rooms.entries()].filter(([,r]) => Number(r.status) !== 0);
  if (booked.length === 0) { log.warn('No active bookings to cancel.'); setErr('No active bookings found.'); return; }
  console.log(C.bold('\n  Active bookings:'));
  for (const [id, r] of booked)
    console.log(`    ${C.cyan(String(id).padEnd(4))} Room #${r.room_number}`);
  gap();
  const roomId       = await askBigUint('Room ID to cancel', 4294967295n);
  const nightsStayed = await askBigUint('Nights already stayed', 65535n, '0 if none');
  const nonce = savedOwnerNonce() ?? generateNonce();
  log.warn(`This overrides the guest's booking on room ${roomId}.`);
  if (!await confirm('Confirm cancel?')) { log.warn('Aborted.'); return; }
  log.info('Generating proof and submitting...');
  const tx = await dc.callTx.owner_cancel_booking(roomId, nightsStayed, nonce);
  log.ok(`Booking cancelled. TxID: ${tx.public?.txId ?? '(pending)'}`);
  setOk(`Booking for room ${roomId} cancelled by owner.`);
}

async function actionGuestCheckout(dc: any, providers: ReturnType<typeof buildProviders>) {
  log.section('Confirm Checkout (Guest)');
  log.info('The check-out date must have passed before calling this.');
  const rooms = await getRooms(dc, providers);
  const booked = [...rooms.entries()].filter(([,r]) => r.has_booking && Number(r.checkout_status) === 0);
  if (booked.length === 0) { log.warn('No rooms awaiting your checkout confirmation.'); setErr('Nothing to confirm.'); return; }
  console.log(C.bold('\n  Rooms pending guest checkout:'));
  for (const [id, r] of booked)
    console.log(`    ${C.cyan(String(id).padEnd(4))} Room #${r.room_number}  check-out: ${new Date(Number(r.check_out_date)*1000).toUTCString()}`);
  gap();
  const roomId = await askBigUint('Room ID', 4294967295n);
  if (!await confirm(`Confirm you have vacated room ${roomId}?`)) { log.warn('Aborted.'); return; }
  log.info('Generating proof and submitting...');
  const tx = await dc.callTx.guest_confirm_checkout(roomId);
  log.ok(`Checkout confirmed. TxID: ${tx.public?.txId ?? '(pending)'}`);
  setOk(`Checkout confirmed for room ${roomId}.`);
}

async function actionOwnerCheckout(dc: any, ownerTaxIdStr: string, providers: ReturnType<typeof buildProviders>) {
  log.section('Confirm Checkout (Owner)');
  log.info(`Acting as owner: ${C.bold(ownerTaxIdStr)}`);
  log.info('Guest must have confirmed checkout first (step 7).');
  const rooms = await getRooms(dc, providers);
  const ready = [...rooms.entries()].filter(([,r]) => Number(r.checkout_status) === 1);
  if (ready.length === 0) { log.warn('No rooms where guest has confirmed checkout yet.'); setErr('Guest checkout not confirmed yet.'); return; }
  console.log(C.bold('\n  Rooms awaiting owner confirmation:'));
  for (const [id, r] of ready)
    console.log(`    ${C.cyan(String(id).padEnd(4))} Room #${r.room_number}`);
  gap();
  const roomId    = await askBigUint('Room ID', 4294967295n);
  const room      = rooms.get(Number(roomId));
  const curDamage = room ? Number(room.damage_claim_count) : 0;
  log.info(`Current damage claim count: ${curDamage}`);
  const newDamage = await askBigUint('New damage count', 65535n, `same (${curDamage}) or ${curDamage + 1} if damage`);
  const nonce = savedOwnerNonce() ?? generateNonce();
  if (!await confirm('Finalise checkout?')) { log.warn('Aborted.'); return; }
  log.info('Generating proof and submitting...');
  const tx = await dc.callTx.owner_confirm_checkout(roomId, newDamage, nonce);
  log.ok(`Checkout complete. TxID: ${tx.public?.txId ?? '(pending)'}`);
  setOk(`Room ${roomId} checkout finalised.`);
}

async function actionForceCheckout(dc: any, ownerTaxIdStr: string, providers: ReturnType<typeof buildProviders>) {
  log.section('Force Checkout (Owner)');
  log.info('Use this only when the guest has not confirmed after the 48 h grace period.');
  log.info(`Acting as owner: ${C.bold(ownerTaxIdStr)}`);
  const rooms = await getRooms(dc, providers);
  const ghosts = [...rooms.entries()].filter(([,r]) => r.has_booking);
  if (ghosts.length === 0) { log.warn('No booked rooms found.'); setErr('No bookings for force checkout.'); return; }
  for (const [id, r] of ghosts)
    console.log(`    ${C.cyan(String(id).padEnd(4))} Room #${r.room_number}  check-out was: ${r.check_out_date ? new Date(Number(r.check_out_date)*1000).toUTCString() : '?'}`);
  gap();
  const roomId    = await askBigUint('Room ID', 4294967295n);
  const room      = rooms.get(Number(roomId));
  const curDamage = room ? Number(room.damage_claim_count) : 0;
  const newDamage = await askBigUint('New damage count', 65535n, `${curDamage} or ${curDamage + 1}`);
  const nonce = savedOwnerNonce() ?? generateNonce();
  log.warn('This bypasses guest confirmation. Only use after grace period.');
  if (!await confirm('Force checkout?')) { log.warn('Aborted.'); return; }
  log.info('Generating proof and submitting...');
  const tx = await dc.callTx.owner_force_checkout(roomId, newDamage, nonce);
  log.ok(`Force checkout done. TxID: ${tx.public?.txId ?? '(pending)'}`);
  setOk(`Room ${roomId} force-checked out.`);
}

async function actionViewRoom(dc: any, providers: ReturnType<typeof buildProviders>) {
  const rooms = await getRooms(dc, providers);
  if (rooms.size === 0) { log.warn('No rooms listed yet.'); setErr('No rooms to view.'); return; }
  console.log(C.bold('\n  Listed rooms:'));
  for (const [id] of rooms) console.log(`    ${C.cyan(String(id))}`);
  gap();
  const roomId = await askBigUint('Room ID to inspect', 4294967295n);
  const room   = rooms.get(Number(roomId));
  if (!room) { log.warn(`Room ${roomId} not found.`); setErr(`Room ${roomId} does not exist.`); return; }
  printRoom(Number(roomId), room);
}

async function actionViewAll(dc: any, providers: ReturnType<typeof buildProviders>) {
  const rooms = await getRooms(dc, providers);
  if (rooms.size === 0) { log.warn('No rooms listed yet.'); setErr('No rooms to display.'); return; }
  log.info(`${rooms.size} room(s) on ledger:`);
  for (const [id, r] of rooms) { printRoom(id, r); bar(); }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  setNetworkId(NETWORK_ID);
  const mnemonic = process.env.DEPLOYER_MNEMONIC ?? process.argv[2];
  if (!mnemonic) { console.error('Set DEPLOYER_MNEMONIC env var.'); process.exit(1); }
  const ownerTaxIdStr = process.env.OWNER_TAX_ID ?? 'DEV-OWNER-000000000000000000000000000';

  console.clear();
  console.log(C.bold(C.blue('\n  ╔══════════════════════════════════╗')));
  console.log(C.bold(C.blue('  ║      nightroom  🌙                ║')));
  console.log(C.bold(C.blue('  ║      Midnight undeployed net      ║')));
  console.log(C.bold(C.blue('  ╚══════════════════════════════════╝\n')));

  let wallet: WalletFacade | undefined;
  let dc: any = null;

  try {
    const { facade, shieldedSecretKeys, dustSecretKey } = await buildWallet(mnemonic);
    wallet = facade;
    const providers = buildProviders(wallet, shieldedSecretKeys, dustSecretKey);

    const saved = savedAddress();
    if (saved) {
      log.info(`Found deployment.json — auto-connecting to ${C.bold(saved)}`);
      try {
        dc = await doJoin(providers, saved, ownerTaxIdStr);
        setOk(`Auto-connected to ${saved.slice(0,16)}…`);
      } catch (e: any) {
        log.warn(`Auto-connect failed: ${e?.message}`);
        setErr('Auto-connect failed. Use Setup → Connect manually.');
      }
    }

    while (true) {
      gap();
      bar();
      printStatus();
      const contractLine = dc
        ? C.green('  ✔ Connected: ') + C.dim(savedAddress() ?? '(in memory)')
        : C.yellow('  ⚠ No contract — use Setup first');
      console.log(contractLine);
      bar();
      console.log(`
  ${C.bold('1')}  Setup          ${C.dim('deploy / connect to contract')}
  ${C.bold('2')}  Owner actions  ${C.dim('list rooms, cancel, checkout')}
  ${C.bold('3')}  Guest actions  ${C.dim('book, cancel, checkout')}
  ${C.bold('4')}  Info           ${C.dim('view room state')}
  ${C.bold('5')}  Exit
`);
      const ch = (await ask('Main menu')).trim();

      if (['2','3','4'].includes(ch) && !dc) {
        log.warn('No contract connected. Go to Setup (option 1) first.');
        setErr('Connect to a contract before using this option.');
        continue;
      }

      try {
        switch (ch) {
          case '1': {
            log.section('Setup');
            console.log(`\n  ${C.cyan('1')}  Deploy new contract\n  ${C.cyan('2')}  Connect to existing contract\n  ${C.cyan('0')}  ← Back\n`);
            const sub = (await ask('Choose')).trim();
            if (sub === '1') {
              const d = await doDeploy(providers, ownerTaxIdStr);
              if (d) {
                // After deploy, connect to the live handle via findDeployedContract
                const addr2 = savedAddress();
                if (addr2) {
                  try { dc = await doJoin(providers, addr2, ownerTaxIdStr); }
                  catch { dc = (d as any).deployedContractReceipt ?? (d as any).contract ?? d; }
                }
              }
            }
            else if (sub === '2') {
              const addr = await askRequired('Contract address', 'hex string');
              dc = await doJoin(providers, addr, ownerTaxIdStr);
              setOk(`Connected to ${addr.slice(0,16)}…`);
            }
            break;
          }
          case '2': await submenuOwner(dc, ownerTaxIdStr, providers); break;
          case '3': await submenuGuest(dc, providers); break;
          case '4': await submenuInfo(dc, providers); break;
          case '5': case 'q': case 'exit':
            log.info('Shutting down...');
            rl.close();
            try { await (wallet as any).stop(); } catch { /* */ }
            process.exit(0);
          default: log.warn(`Unknown option "${ch}".`);
        }
      } catch (err: any) {
        gap();
        log.error(`${err?.message ?? err}`);
        setErr(err?.message?.slice(0, 80) ?? 'Unknown error');
        if (process.env.DEBUG) console.error(err);
        log.info('You can try again from the menu.');
      }
    }
  } catch (err: any) {
    log.error(`Fatal: ${err?.message ?? err}`);
    if (process.env.DEBUG) console.error(err);
    rl.close();
    try { await (wallet as any)?.stop(); } catch { /* */ }
    process.exit(1);
  }
}

main();
