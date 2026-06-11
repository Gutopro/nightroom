import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger, Witnesses } from '../../contracts/managed/contract/index.js';
import { randomBytes } from 'node:crypto';

export type NightroomPrivateState = {
  ownerTaxId:  Uint8Array;
  guestSecret: Uint8Array;
};

export function createOwnerPrivateState(taxId: Uint8Array): NightroomPrivateState {
  if (taxId.length !== 32) throw new Error('Tax ID must be exactly 32 bytes');
  return { ownerTaxId: taxId, guestSecret: new Uint8Array(32) };
}

export function createGuestPrivateState(): NightroomPrivateState {
  return { ownerTaxId: new Uint8Array(32), guestSecret: randomBytes(32) };
}

export function taxIdToBytes(taxId: string): Uint8Array {
  const encoded = new TextEncoder().encode(taxId);
  const result  = new Uint8Array(32);
  result.set(encoded.slice(0, 32));
  return result;
}

export function generateNonce(): Uint8Array {
  return randomBytes(32);
}

export const witnesses: Witnesses<NightroomPrivateState> = {

  owner_tax_id(
    context: WitnessContext<Ledger, NightroomPrivateState>
  ): [NightroomPrivateState, Uint8Array] {
    return [context.privateState, context.privateState.ownerTaxId];
  },

  guest_secret(
    context: WitnessContext<Ledger, NightroomPrivateState>
  ): [NightroomPrivateState, Uint8Array] {
    return [context.privateState, context.privateState.guestSecret];
  },

  current_timestamp(
    context: WitnessContext<Ledger, NightroomPrivateState>
  ): [NightroomPrivateState, bigint] {
    return [context.privateState, BigInt(Math.floor(Date.now() / 1000))];
  },

};