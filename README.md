# nightroom 🌙

A privacy-preserving room rental protocol on [Midnight Network](https://midnight.network). Owners list rooms, guests book them — with ZK proofs ensuring identity verification without exposing sensitive data on-chain.

## Privacy design

**Owner identity** uses a verification_commitment = hash("booking:owner:" + nonce + tax_id) stored at deploy time. The owner proves identity on every transaction by passing the correct nonce. The tax ID never touches the ledger.

**Guest identity** uses a booking_commitment = hash("booking:guest:" + room_id + secret) stored at booking time. Only the original booker can cancel or confirm checkout. The guest secret never appears on-chain.

## Contract circuits

| Circuit | Who | What |
|---|---|---|
| list_room | Owner | List a room with price and caution fee |
| book_room | Guest | Book an available room |
| guest_cancel_booking | Guest | Cancel and get refund |
| owner_cancel_booking | Owner | Cancel a guest booking |
| guest_confirm_checkout | Guest | Confirm vacating the room |
| owner_confirm_checkout | Owner | Finalise checkout after guest confirms |
| owner_force_checkout | Owner | Force checkout after 48h grace period |

## Project structure

    nightroom/
    ├── contracts/
    │   ├── nightroom.compact        # Compact smart contract source
    │   └── managed/nightroom/       # Compiled artifacts (gitignored)
    ├── api/
    │   └── src/
    │       ├── deploy.ts            # One-shot deploy script
    │       ├── cli.ts               # Interactive CLI
    │       └── witnesses.ts         # Private state and witness definitions
    ├── frontend/                    # Web UI (in progress)
    ├── docker-compose.yml           # Proof server
    └── package.json

## Prerequisites

- Node.js 20+, Yarn, Docker
- Running Midnight undeployed network (indexer on :8088, node on :9944, proof server on :6300)

## Quick start

Start the proof server with yarn proof-server:start, then compile the contract with yarn compile.

Deploy the contract:

    DEPLOYER_MNEMONIC="your 24 words" OWNER_TAX_ID="your-tax-id" yarn deploy

Run the interactive CLI:

    DEPLOYER_MNEMONIC="your 24 words" OWNER_TAX_ID="your-tax-id" yarn cli

The CLI auto-connects to the last deployed contract and presents a hierarchical menu covering all contract interactions — list rooms, book, cancel, checkout, and view state.

## Security notes

deployment.json is gitignored and contains the owner nonce required to prove owner identity on every transaction. Back it up securely outside the repo. The private state DB password in the CLI is a dev placeholder — replace privateStoragePasswordProvider with a proper secrets manager for production. The project targets the undeployed local network; for testnet update NETWORK_ID and ENDPOINTS in api/src/deploy.ts and api/src/cli.ts.

## License

MIT
