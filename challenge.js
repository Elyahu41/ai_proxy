// "Beat the AI" daily prediction challenge.
//
// Round timeline (all UTC):
//   day D            picks are open for round D (users pick Up/Down for 5 coins)
//   D+1 00:00        round D locks; lockPrices are snapshotted
//   D+2 00:00        round D is scored against endPrices (price 24h after the lock)
//
// The server is the only writer (Firebase Admin). Clients read Firestore directly and submit
// picks through POST /challenge/picks, so scores and the leaderboard can't be tampered with.
//
// Firestore layout:
//   challengeRounds/{roundId}                     round, prices, AI picks, results
//   challengeRounds/{roundId}/picks/{uid}         a user's picks (+ result once scored)
//   challengeStats/{uid}                          streaks and totals
//   challengeLeaderboards/{weekId}/entries/{id}   weekly totals for users and AI rivals

export const DAY = 24 * 60 * 60 * 1000;
export const PICKS_PER_ROUND = 5;

export const AI_RIVALS = [
  { key: "gpt", provider: "openai", model: "gpt-6-luna", name: "GPT-6 Luna" },
  { key: "gemini", provider: "gemini", model: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite" },
  { key: "claude", provider: "claude", model: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

const STABLECOINS = new Set([
  "USDT", "USDC", "DAI", "USDE", "FDUSD", "TUSD", "PYUSD", "USDS", "BUSD", "USD1", "USDD",
  "FRAX", "USDP", "GUSD", "LUSD", "RLUSD", "USDTB", "USD0", "EURC", "XAUT", "PAXG", "BSC-USD", "SUSDE", "WBTC",
  "STETH", "WSTETH", "WETH", "WEETH", "CBBTC", "LBTC", "SOLVBTC", "BUIDL",
]);

export function roundIdFor(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function roundStart(roundId) {
  return Date.parse(roundId + "T00:00:00Z");
}

export function shiftRound(roundId, days) {
  return roundIdFor(roundStart(roundId) + days * DAY);
}

/** ISO-8601 week id, e.g. "2026-W46" (weeks start on Monday). */
export function weekIdFor(roundId) {
  const d = new Date(roundStart(roundId));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday decides the ISO year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function seededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => { // mulberry32
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** BTC and ETH every day, plus 3 other large caps chosen deterministically from the date. */
export function pickCoins(coins, roundId) {
  const eligible = coins
    .filter(c => c && c.symbol && c.price > 0 && !STABLECOINS.has(String(c.symbol).toUpperCase()))
    .sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  const chosen = [];
  for (const sym of ["BTC", "ETH"]) {
    const c = eligible.find(x => x.symbol === sym);
    if (c) chosen.push(c);
  }
  const pool = eligible.filter(c => !chosen.includes(c)).slice(0, 40);
  const rand = seededRandom(roundId);
  while (chosen.length < PICKS_PER_ROUND && pool.length) {
    chosen.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return chosen.map(c => ({ symbol: c.symbol, name: c.name || c.symbol }));
}

/** "Elyahu Jacobi" -> "Elyahu J." ; no name -> "Trader 1a2b" (never shows emails). */
export function publicName(fullName, uid) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return `Trader ${String(uid).slice(0, 4)}`;
  if (parts.length === 1) return parts[0].slice(0, 20);
  return `${parts[0].slice(0, 20)} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export function parseAiPicks(text, symbols) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const picks = {};
  for (const sym of symbols) {
    const v = String(obj[sym] ?? obj[sym.toLowerCase()] ?? "").toLowerCase();
    if (v.startsWith("up") || v === "higher" || v === "bullish") picks[sym] = "up";
    else if (v.startsWith("down") || v === "lower" || v === "bearish") picks[sym] = "down";
    else return null;
  }
  return picks;
}

export function outcome(lockPrice, endPrice) {
  if (!(lockPrice > 0) || !(endPrice > 0)) return "void";
  if (endPrice > lockPrice) return "up";
  if (endPrice < lockPrice) return "down";
  return "flat";
}

/** Correct picks out of the coins that had a valid result. */
export function scorePicks(picks, results) {
  let correct = 0, total = 0;
  const perCoin = {};
  for (const [sym, res] of Object.entries(results)) {
    if (res === "void") continue;
    total++;
    const ok = picks?.[sym] === res;
    if (ok) correct++;
    perCoin[sym] = ok;
  }
  return { correct, total, perCoin };
}

/**
 * @param db         firebase-admin Firestore instance
 * @param FieldValue firebase-admin FieldValue (for increment)
 * @param fetchCoins async () => [{symbol, name, rank, price}]
 * @param askModel   async (provider, model, prompt) => text
 * @param now        () => millis
 */
export function createChallenge({ db, FieldValue, fetchCoins, askModel, now = () => Date.now(), log = console }) {
  let running = null;

  async function sync() {
    if (running) return running; // one sync at a time
    running = doSync().finally(() => { running = null; });
    return running;
  }

  async function doSync() {
    const t = now();
    const todayId = roundIdFor(t);
    let coinsCache = null;
    const coins = async () => (coinsCache ??= await fetchCoins());
    const priceMap = async () => Object.fromEntries((await coins()).map(c => [c.symbol, Number(c.price)]));

    // 1) Make sure today's round exists
    const todayRef = db.doc(`challengeRounds/${todayId}`);
    if (!(await todayRef.get()).exists) {
      await createRound(todayId, await coins(), todayRef);
    }

    // 2) Lock rounds whose pick window has ended
    const open = await db.collection("challengeRounds").where("status", "==", "open").get();
    for (const doc of open.docs) {
      if (t < doc.data().lockAt) continue;
      const prices = await priceMap();
      await db.runTransaction(async tx => {
        const fresh = await tx.get(doc.ref);
        if (fresh.data().status !== "open") return;
        const lockPrices = {};
        for (const c of fresh.data().coins) lockPrices[c.symbol] = prices[c.symbol] ?? null;
        tx.update(doc.ref, { status: "live", lockPrices, lockedAt: t });
      });
    }

    // 3) Score rounds 24h after they locked
    const live = await db.collection("challengeRounds").where("status", "==", "live").get();
    for (const doc of live.docs) {
      if (t < doc.data().resolveAt) continue;
      await resolveRound(doc.ref, await priceMap(), t);
    }
    return { today: todayId };
  }

  async function createRound(roundId, coinList, ref) {
    const coins = pickCoins(coinList, roundId);
    const startPrices = {};
    for (const c of coins) startPrices[c.symbol] = Number(coinList.find(x => x.symbol === c.symbol)?.price) || null;
    const start = roundStart(roundId);
    const lockAt = start + DAY;
    const resolveAt = start + 2 * DAY;
    const symbols = coins.map(c => c.symbol);

    const prompt =
      "You are a professional crypto market analyst taking part in a prediction game. " +
      `For each coin, predict whether its USD price at ${new Date(resolveAt).toISOString()} will be higher (up) or lower (down) ` +
      `than at ${new Date(lockAt).toISOString()}. Coins: ${symbols.join(", ")}. ` +
      `Current prices (USD): ${symbols.map(s => `${s}=${startPrices[s]}`).join(", ")}. ` +
      'Respond with ONLY a JSON object, no markdown, e.g. {"BTC":"up","ETH":"down"}.';

    const aiPicks = {};
    await Promise.all(AI_RIVALS.map(async rival => {
      try {
        const picks = parseAiPicks(await askModel(rival.provider, rival.model, prompt), symbols);
        if (picks) aiPicks[rival.key] = { name: rival.name, model: rival.model, picks };
        else log.warn?.(`challenge: ${rival.key} gave unusable picks`);
      } catch (e) {
        log.warn?.(`challenge: ${rival.key} failed: ${e.message}`);
      }
    }));

    try {
      await ref.create({
        roundId, coins, startPrices, aiPicks,
        status: "open", createdAt: now(), lockAt, resolveAt,
        lockPrices: null, endPrices: null, results: null, aiResults: null,
        weekId: weekIdFor(roundId),
      });
    } catch (e) {
      if (!/already exists/i.test(e.message) && e.code !== 6) throw e; // created by a parallel request
    }
  }

  async function resolveRound(ref, prices, t) {
    let round = null;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const r = snap.data();
      if (r.status !== "live") return;
      const endPrices = {}, results = {};
      for (const c of r.coins) {
        endPrices[c.symbol] = prices[c.symbol] ?? null;
        results[c.symbol] = outcome(r.lockPrices?.[c.symbol], endPrices[c.symbol]);
      }
      const aiResults = {};
      for (const [key, ai] of Object.entries(r.aiPicks || {})) {
        const s = scorePicks(ai.picks, results);
        aiResults[key] = { name: ai.name, correct: s.correct, total: s.total };
        tx.set(db.doc(`challengeLeaderboards/${r.weekId}/entries/ai_${key}`), {
          displayName: ai.name, isAi: true,
          correct: FieldValue.increment(s.correct), total: FieldValue.increment(s.total),
          played: FieldValue.increment(1), updatedAt: t,
        }, { merge: true });
      }
      tx.update(ref, { status: "final", endPrices, results, aiResults, resolvedAt: t });
      round = { ...r, endPrices, results, aiResults };
    });
    if (!round) return; // someone else resolved it

    const bestAi = Math.max(0, ...Object.values(round.aiResults).map(a => a.correct));
    const picks = await ref.collection("picks").get();
    for (const doc of picks.docs) {
      const p = doc.data();
      if (p.result) continue; // already scored
      const s = scorePicks(p.picks, round.results);
      const batch = db.batch();
      batch.update(doc.ref, { result: { ...s, bestAi, beatAllAi: s.correct > bestAi, scoredAt: t } });
      batch.set(db.doc(`challengeStats/${p.uid}`), {
        totalCorrect: FieldValue.increment(s.correct),
        totalPicks: FieldValue.increment(s.total),
        roundsScored: FieldValue.increment(1),
        perfectRounds: FieldValue.increment(s.total > 0 && s.correct === s.total ? 1 : 0),
        aiBeaten: FieldValue.increment(s.correct > bestAi ? 1 : 0),
        lastResultRound: round.roundId,
      }, { merge: true });
      batch.set(db.doc(`challengeLeaderboards/${round.weekId}/entries/${p.uid}`), {
        displayName: p.displayName, isAi: false,
        correct: FieldValue.increment(s.correct), total: FieldValue.increment(s.total),
        played: FieldValue.increment(1), updatedAt: t,
      }, { merge: true });
      await batch.commit();
    }
  }

  /** picks = {BTC: "up", ETH: "down", ...}. Throws Error with .status for bad input. */
  async function submitPicks({ uid, displayName, roundId, picks }) {
    const t = now();
    const todayId = roundIdFor(t);
    const fail = (status, code) => Object.assign(new Error(code), { status, code });
    if (roundId !== todayId) throw fail(409, "round_closed");

    const roundRef = db.doc(`challengeRounds/${roundId}`);
    const pickRef = db.doc(`challengeRounds/${roundId}/picks/${uid}`);
    const statsRef = db.doc(`challengeStats/${uid}`);

    return db.runTransaction(async tx => {
      const roundSnap = await tx.get(roundRef);
      if (!roundSnap.exists) throw fail(404, "round_not_found");
      const round = roundSnap.data();
      if (round.status !== "open" || t >= round.lockAt) throw fail(409, "round_closed");

      const clean = {};
      for (const c of round.coins) {
        const v = picks?.[c.symbol];
        if (v !== "up" && v !== "down") throw fail(400, "invalid_picks");
        clean[c.symbol] = v;
      }

      const pickSnap = await tx.get(pickRef);
      const statsSnap = await tx.get(statsRef);
      const stats = statsSnap.exists ? statsSnap.data() : {};
      let streak = stats.currentStreak || 0;
      let best = stats.bestStreak || 0;

      if (!pickSnap.exists) {
        // Streak = consecutive days with picks
        if (stats.lastRoundPlayed === shiftRound(roundId, -1)) streak += 1;
        else if (stats.lastRoundPlayed !== roundId) streak = 1;
        best = Math.max(best, streak);
        tx.set(statsRef, {
          displayName, currentStreak: streak, bestStreak: best, lastRoundPlayed: roundId,
          roundsPlayed: FieldValue.increment(1),
        }, { merge: true });
        tx.set(pickRef, { uid, displayName, picks: clean, submittedAt: t, updatedAt: t, result: null });
      } else {
        tx.update(pickRef, { picks: clean, updatedAt: t, displayName });
      }
      return { ok: true, streak, bestStreak: best, firstSubmission: !pickSnap.exists };
    });
  }

  return { sync, submitPicks };
}