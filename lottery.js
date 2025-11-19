// lottery.js
// Run by GitHub Actions every 3 hours.
// Reads incoming txs to FEE_ADDRESS, picks winners, sends prizes, and commits results.

import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import crypto from "crypto";

const FEE_ADDRESS = process.env.FEE_ADDRESS;
const PRIVATE_KEY_ENV = process.env.PRIVATE_KEY; // JSON array string

if (!FEE_ADDRESS || !PRIVATE_KEY_ENV) {
  console.error("Missing FEE_ADDRESS or PRIVATE_KEY env. Set them in GitHub Secrets.");
  process.exit(1);
}

const STATE_FILE = "state.json";
const RESULTS_FILE = "results.json";
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// helper load state (lastRoundEnd timestamp)
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastRoundEnd: 0, rounds: [] };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// helper load results
function loadResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  } catch {
    return { rounds: [] };
  }
}
function saveResults(r) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(r, null, 2));
}

// parse private key env (accept JSON array or base64)
function parseKey(keyEnv) {
  try {
    const maybeArray = JSON.parse(keyEnv);
    if (Array.isArray(maybeArray)) return Uint8Array.from(maybeArray);
  } catch {}
  // fallback: treat as base64
  try {
    return Uint8Array.from(Buffer.from(keyEnv, "base64"));
  } catch (e) {
    throw new Error("Unable to parse PRIVATE_KEY. Use JSON array (recommended).");
  }
}

async function run() {
  console.log("Starting lottery run...");
  const state = loadState();
  const results = loadResults();

  const since = state.lastRoundEnd || 0;
  const now = Math.floor(Date.now() / 1000);

  console.log("lastRoundEnd:", since, "now:", now);

  // get signatures sent to FEE_ADDRESS
  const feePubkey = new PublicKey(FEE_ADDRESS);
  const sigs = await connection.getSignaturesForAddress(feePubkey, { limit: 1000 });
  // filter by blockTime within (since, now]
  const recent = sigs.filter(s => s.blockTime && s.blockTime > since && s.blockTime <= now);

  console.log("Total recent signatures to fee address:", recent.length);

  // collect unique senders who sent exactly 0.01 SOL (10_000_000 lamports)
  const TICKET_LAMPORTS = 10_000_000; // 0.01 * 1e9
  const participants = new Set();

  for (const s of recent) {
    try {
      const tx = await connection.getTransaction(s.signature, { commitment: "confirmed" });
      if (!tx || !tx.transaction) continue;

      // parse postBalances / preBalances to find transfer to fee address
      // we inspect parsed transaction message to find transfers
      const message = tx.transaction.message;
      // find all inner instructions / parsed instructions to check SystemProgram transfer
      // simpler: loop accountKeys and look at meta preBalance/postBalance differences
      const meta = tx.meta;
      if (!meta) continue;

      // find index of fee address in accountKeys
      const idx = message.accountKeys.findIndex(a => a.toBase58() === FEE_ADDRESS);
      if (idx === -1) continue;

      const pre = meta.preBalances[idx];
      const post = meta.postBalances[idx];
      const received = post - pre;
      // If exactly TICKET_LAMPORTS (allow small difference? require >=TICKET_LAMPORTS)
      if (received >= TICKET_LAMPORTS) {
        // get sender: the first signer of the tx (fee payer or signer)
        const signerKey = message.accountKeys.find((ak, i) => message.isAccountSigner ? false : false);
        // better: use tx.transaction.signatures[0] original signer pubkey mapping
        // Use meta as source: look for account with decreased balance equal to or larger than ticket
        // We'll find any account whose pre - post >= TICKET_LAMPORTS and is signer
        let sender = null;
        for (let i = 0; i < message.accountKeys.length; i++) {
          const preBal = meta.preBalances[i];
          const postBal = meta.postBalances[i];
          if (preBal - postBal >= TICKET_LAMPORTS && tx.transaction.signatures.includes(message.accountKeys[i].toBase58()) ) {
            sender = message.accountKeys[i].toBase58();
            break;
          }
        }
        // fallback: use tx.transaction.signatures mapping - the first signature correspond to fee payer accountKeys[0]
        if (!sender) {
          // assume fee payer is accountKeys[0]
          sender = message.accountKeys[0].toBase58();
        }
        if (sender) participants.add(sender);
      }
    } catch (err) {
      console.warn("Error fetching tx", s.signature, err?.message || err);
    }
  }

  const players = Array.from(participants);
  console.log("Unique participants this round:", players.length);

  // If no participants, update lastRoundEnd and exit (still commit)
  const round = {
    start: since,
    end: now,
    timestamp: now,
    playersCount: players.length,
    players,
    winners: []
  };

  if (players.length === 0) {
    console.log("No players this round. Updating state only.");
    state.lastRoundEnd = now;
    saveState(state);
    // commit state/results later
    await commitAndPushFiles([STATE_FILE, RESULTS_FILE], "lottery: update state - no players");
    return;
  }

  // pick 2 distinct winners using secure randomness
  function pickTwo(arr) {
    if (arr.length === 1) return [arr[0], arr[0]];
    const buf = crypto.randomBytes(8);
    const r1 = buf.readUInt32BE(0);
    const r2 = buf.readUInt32BE(4);
    const i1 = r1 % arr.length;
    let i2 = r2 % arr.length;
    if (i2 === i1) i2 = (i2 + 1) % arr.length;
    return [arr[i1], arr[i2]];
  }

  const [winner1, winner2] = pickTwo(players);
  round.winners = [winner1, winner2];

  // compute pot
  const potLamports = players.length * TICKET_LAMPORTS;
  const wLam = Math.floor(potLamports * 0.35); // 35% each
  const ownerLam = potLamports - wLam - wLam; // remainder (30%)
  console.log("Pot lamports:", potLamports, "winnerLam:", wLam, "ownerLam:", ownerLam);

  // prepare signer keypair
  const sk = parseKey(PRIVATE_KEY_ENV);
  const signer = Keypair.fromSecretKey(sk);

  // send transfer to winner1, winner2 (sequentially)
  async function sendLamports(dest, lamports) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: new PublicKey(dest),
        lamports
      })
    );
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
    tx.sign(signer);
    const raw = tx.serialize();
    const sig = await connection.sendRawTransaction(raw);
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  try {
    const sig1 = await sendLamports(winner1, wLam);
    const sig2 = await sendLamports(winner2, wLam);
    console.log("Sent winners:", sig1, sig2);
    round.transferSignatures = { winner1: sig1, winner2: sig2 };
  } catch (err) {
    console.error("Error sending prizes:", err);
    // don't exit — still record failure
    round.error = String(err?.message || err);
  }

  // record round
  results.rounds.push(round);
  state.rounds = (state.rounds || []);
  state.lastRoundEnd = now;
  saveResults(results);
  saveState(state);

  // commit state & results
  await commitAndPushFiles([STATE_FILE, RESULTS_FILE], `lottery: round ${now} - players ${players.length}`);

  console.log("Lottery run finished.");
}

// helper commit & push via git (using GITHUB_TOKEN)
async function commitAndPushFiles(files, message) {
  try {
    // use child_process to run git commands
    const { execSync } = await import("child_process");
    execSync("git config user.email \"actions@github.com\"");
    execSync("git config user.name \"github-actions\"");
    execSync("git add " + files.join(" "));
    execSync(`git commit -m "${message}" || echo "no changes to commit"`);
    execSync("git push origin HEAD");
    console.log("Committed files:", files);
  } catch (err) {
    console.warn("Git commit/push failed:", err?.message || err);
  }
}

// parseKey as before (accept JSON array or base64)
function parseKey(keyEnv) {
  try {
    const maybeArray = JSON.parse(keyEnv);
    if (Array.isArray(maybeArray)) return Uint8Array.from(maybeArray);
  } catch {}
  try {
    return Uint8Array.from(Buffer.from(keyEnv, "base64"));
  } catch (e) {
    throw new Error("Unable to parse PRIVATE_KEY. Use JSON array (recommended).");
  }
}

// run main
run().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
