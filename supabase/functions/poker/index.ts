// Poker table server for the ledger: No-Limit Hold'em cash games.
// Each table is one row in public.poker_tables. Clients can't read that table; the full state,
// including the deck and everyone's hole cards, only leaves here filtered per player by view().
// Amounts are whole cents. Timeouts and the next deal happen lazily whenever anyone asks for the state.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ledger-pass',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SEATS = 9;
const TURN_MS = 30000;
const NEXT_HAND_MS = 3500;
const SHOWDOWN_MS = 7000;
const LOG_MAX = 40;

// deno-lint-ignore no-explicit-any
type Any = any;

class GameError extends Error {}
function fail(msg: string): never { throw new GameError(msg); }

/* ---------- cards ---------- */
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const SUIT_SYM: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
function newDeck() { const d: string[] = []; for (const r of RANKS) for (const s of SUITS) d.push(r + s); return d; }
function cardTxt(c: string) { return (c[0] === 'T' ? '10' : c[0]) + SUIT_SYM[c[1]]; }

/* ---------- provably fair shuffle ---------- */
// Before a hand the table shows sha256(serverSeed), so the server is locked in. The deck is a Fisher–Yates
// shuffle of the fixed 2s,2h,2d,2c…As,Ah,Ad,Ac order, driven by the bytes of
// HMAC-SHA256(key = serverSeed, message = clientSeeds + ':' + handNo + ':' + counter), read as big-endian
// 32-bit numbers with rejection sampling so every position is equally likely. clientSeeds are the dealt
// players' own seeds joined with '|' in dealing order. The seed is revealed after the hand so anyone can
// rebuild the deck; play.js does exactly this in the browser.
function sha256(s: string) { return createHash('sha256').update(s).digest('hex'); }
function newSeed() { const seed = randomBytes(32).toString('hex'); return { seed, hash: sha256(seed) }; }
function cleanSeed(v: unknown) { return String(v || '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 64) || randomBytes(16).toString('hex'); }
function fairDeck(seed: string, client: string, no: number) {
  let counter = 0; let buf = new Uint8Array(0); let pos = 0;
  const next32 = () => {
    if (pos + 4 > buf.length) { buf = createHmac('sha256', seed).update(client + ':' + no + ':' + counter++).digest(); pos = 0; }
    const v = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
    pos += 4;
    return v;
  };
  const d = newDeck();
  for (let i = d.length - 1; i > 0; i--) {
    const n = i + 1; const lim = Math.floor(0x100000000 / n) * n;
    let v = next32();
    while (v >= lim) v = next32();
    const j = v % n;
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/* ---------- hand ranking ---------- */
const rv = (c: string) => RANKS.indexOf(c[0]) + 2;
function score5(cs: string[]): number[] {
  const v = cs.map(rv).sort((a, b) => b - a);
  const flush = cs.every((c) => c[1] === cs[0][1]);
  let straight = 0;
  if (new Set(v).size === 5) { if (v[0] - v[4] === 4) straight = v[0]; else if (v[0] === 14 && v[1] === 5) straight = 5; }
  const cnt = new Map<number, number>();
  v.forEach((x) => cnt.set(x, (cnt.get(x) || 0) + 1));
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const g = groups.map((x) => x[0]);
  if (straight && flush) return [8, straight];
  if (groups[0][1] === 4) return [7, ...g];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...g];
  if (flush) return [5, ...v];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, ...g];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...g];
  if (groups[0][1] === 2) return [1, ...g];
  return [0, ...v];
}
function cmp(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; }
  return 0;
}
function best7(cards: string[]) {
  let best: number[] | null = null;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const five = cards.filter((_, i) => i !== a && i !== b);
    const s = score5(five);
    if (!best || cmp(s, best) > 0) best = s;
  }
  return best!;
}
const PLURAL: Record<number, string> = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
const SINGLE: Record<number, string> = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
function describe(s: number[]) {
  switch (s[0]) {
    case 8: return s[1] === 14 ? 'Royal flush' : SINGLE[s[1]] + '-high straight flush';
    case 7: return 'Four ' + PLURAL[s[1]];
    case 6: return PLURAL[s[1]] + ' full of ' + PLURAL[s[2]];
    case 5: return SINGLE[s[1]] + '-high flush';
    case 4: return SINGLE[s[1]] + '-high straight';
    case 3: return 'Three ' + PLURAL[s[1]];
    case 2: return 'Two pair, ' + PLURAL[s[1]] + ' and ' + PLURAL[s[2]];
    case 1: return 'Pair of ' + PLURAL[s[1]];
    default: return SINGLE[s[1]] + ' high';
  }
}

/* ---------- helpers ---------- */
// Amounts in messages go out as {{cents}} so each table can show them as dollars or chips.
function money(c: number) { return '{{' + Math.round(c) + '}}'; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function log(st: Any, m: string) { st.log.push({ t: Date.now(), m }); if (st.log.length > LOG_MAX) st.log.splice(0, st.log.length - LOG_MAX); }
function nextIdx(from: number, pred: (i: number) => boolean) {
  for (let k = 1; k <= SEATS; k++) { const i = (((from + k) % SEATS) + SEATS) % SEATS; if (pred(i)) return i; }
  return -1;
}
function seatOf(st: Any, token: string) { return token ? st.seats.findIndex((s: Any) => s && s.token === token) : -1; }
function cents(v: unknown, what: string) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) fail(what + ' must be more than $0.');
  return n;
}
function eligible(st: Any, i: number) { const s = st.seats[i]; return !!s && s.status === 'active' && !s.leaving && s.stack > 0; }

function newState(name: string, sb: number, bb: number, buyIn: number, units = 'dollars') {
  return {
    name, sb, bb, buyIn, units, status: 'waiting', seats: Array(SEATS).fill(null), requests: [], ledger: {},
    button: -1, handNo: 0, hand: null, last: null, nextHandAt: null, log: [], sentToLedger: false, gameId: null,
    seedNext: newSeed(), fairLog: [],
  };
}

/* ---------- seating and chips ---------- */
function settleAdds(st: Any) {
  st.seats.forEach((s: Any, i: number) => {
    if (!s || !s.pendingAdd) return;
    const p = st.hand && st.hand.p[i];
    if (!p || p.folded) { s.stack += s.pendingAdd; s.pendingAdd = 0; }
  });
}
function approve(st: Any, r: Any) {
  if (r.kind === 'join') {
    if (st.seats[r.seat]) fail('Seat ' + (r.seat + 1) + ' is taken now.');
    if (st.seats.some((s: Any) => s && s.pid === r.pid)) fail(r.name + ' is already seated.');
    st.seats[r.seat] = { pid: r.pid, name: r.name, stack: 0, pendingAdd: r.amount, status: 'active', token: r.token, cseed: cleanSeed(r.cseed) };
    log(st, r.name + ' sits down with ' + money(r.amount) + '.');
  } else {
    const i = seatOf(st, r.token);
    if (i < 0) fail(r.name + ' has left the table.');
    st.seats[i].pendingAdd = (st.seats[i].pendingAdd || 0) + r.amount;
    log(st, r.name + ' rebuys for ' + money(r.amount) + '.');
  }
  const l = st.ledger[r.pid] || (st.ledger[r.pid] = { name: r.name, buyIns: [], cashOut: 0 });
  l.buyIns.push(r.amount);
  settleAdds(st);
}
function cashOut(st: Any, i: number) {
  const s = st.seats[i];
  s.stack += s.pendingAdd || 0;
  s.pendingAdd = 0;
  st.ledger[s.pid].cashOut += s.stack;
  log(st, s.name + ' leaves with ' + money(s.stack) + '.');
  st.seats[i] = null;
  st.requests = st.requests.filter((r: Any) => r.token !== s.token);
}
function leaveSeat(st: Any, i: number) {
  const p = st.hand && st.hand.p[i];
  if (p && !p.folded) st.seats[i].leaving = true;
  else cashOut(st, i);
}

/* ---------- the hand ---------- */
function startHand(st: Any, now: number, deck?: string[]) {
  const elig: number[] = [];
  for (let i = 0; i < SEATS; i++) if (eligible(st, i)) elig.push(i);
  if (elig.length < 2) return false;
  const isElig = (i: number) => elig.includes(i);
  const button = nextIdx(st.button >= 0 ? st.button : SEATS - 1, isElig);
  const sbSeat = elig.length === 2 ? button : nextIdx(button, isElig);
  const bbSeat = nextIdx(sbSeat, isElig);
  const order: number[] = [];
  let i = button;
  for (let k = 0; k < elig.length; k++) { i = nextIdx(i, isElig); order.push(i); }
  st.handNo++;
  // Use the seed whose hash was already on show, then commit to the next one.
  const committed = st.seedNext || newSeed();
  st.seedNext = newSeed();
  const fair = {
    seed: committed.seed, hash: committed.hash, order,
    client: order.map((s) => st.seats[s].cseed || '').join('|'), names: order.map((s) => st.seats[s].name),
  };
  const d = deck || fairDeck(fair.seed, fair.client, st.handNo);
  const holes: Record<number, string[]> = {};
  const p: Record<number, Any> = {};
  for (const s of order) {
    holes[s] = [d.pop()!, d.pop()!];
    p[s] = { bet: 0, total: 0, folded: false, allIn: false, acted: false, cyc: -1 };
  }
  st.button = button;
  st.nextHandAt = null;
  st.last = null;
  const h: Any = {
    no: st.handNo, deck: d, holes, board: [], street: 'preflop', button, sbSeat, bbSeat, fair,
    bb: st.bb, currentBet: 0, minRaise: st.bb, raises: 0, p, toAct: -1, deadline: 0,
  };
  st.hand = h;
  const post = (seat: number, amt: number) => {
    const s = st.seats[seat]; const x = Math.min(amt, s.stack);
    s.stack -= x; p[seat].bet += x; p[seat].total += x;
    if (s.stack === 0) p[seat].allIn = true;
  };
  post(sbSeat, st.sb);
  post(bbSeat, st.bb);
  h.currentBet = Math.max(p[sbSeat].bet, p[bbSeat].bet);
  log(st, 'Hand #' + st.handNo + '. ' + st.seats[button].name + ' has the button; blinds ' + money(st.sb) + '/' + money(st.bb) + '.');
  progress(st, now, bbSeat);
  return true;
}

function act(st: Any, now: number, seat: number, type: string, amount?: unknown) {
  const h = st.hand;
  if (!h) fail('There is no hand in progress.');
  if (h.toAct !== seat) fail("It's not your turn.");
  const p = h.p[seat]; const s = st.seats[seat];
  const toCall = h.currentBet - p.bet;
  const put = (x: number) => { s.stack -= x; p.bet += x; p.total += x; if (s.stack === 0) p.allIn = true; };
  if (type === 'fold') {
    p.folded = true;
    log(st, s.name + ' folds.');
  } else if (type === 'check') {
    if (toCall > 0) fail("You can't check, there's a bet to call.");
    log(st, s.name + ' checks.');
  } else if (type === 'call') {
    if (toCall <= 0) fail('There is nothing to call.');
    const x = Math.min(toCall, s.stack); put(x);
    log(st, s.name + (p.allIn ? ' calls all-in for ' : ' calls ') + money(x) + '.');
  } else if (type === 'raise' || type === 'allin') {
    const maxTo = p.bet + s.stack;
    let to = type === 'allin' ? maxTo : Math.round(Number(amount));
    if (!Number.isFinite(to)) fail('Enter an amount.');
    if (to > maxTo) to = maxTo;
    if (to <= h.currentBet) {
      if (type !== 'allin') fail('A raise has to be more than the current bet.');
      const x = Math.min(toCall, s.stack); put(x);
      log(st, s.name + ' calls all-in for ' + money(x) + '.');
    } else {
      if (p.cyc === h.raises) fail('You can only call or fold here.');
      const minTo = h.currentBet + h.minRaise;
      if (to < minTo && to < maxTo) fail('The minimum raise is to ' + money(minTo) + '.');
      const wasBet = h.currentBet === 0;
      const inc = to - h.currentBet;
      if (inc >= h.minRaise) { h.minRaise = inc; h.raises++; }
      h.currentBet = to;
      put(to - p.bet);
      for (const k of Object.keys(h.p)) { const q = h.p[k]; if (Number(k) !== seat && !q.folded && !q.allIn) q.acted = false; }
      log(st, s.name + (p.allIn ? ' is all-in for ' : wasBet ? ' bets ' : ' raises to ') + money(to) + '.');
    }
  } else fail('Unknown action.');
  p.acted = true;
  p.cyc = h.raises;
  progress(st, now, seat);
}

function progress(st: Any, now: number, lastSeat: number) {
  const h = st.hand;
  const seats = Object.keys(h.p).map(Number);
  const live = seats.filter((i) => !h.p[i].folded);
  if (live.length === 1) return winByFold(st, now, live[0]);
  const canAct = live.filter((i) => !h.p[i].allIn);
  const need = canAct.filter((i) => !h.p[i].acted || h.p[i].bet < h.currentBet);
  let done = need.length === 0;
  if (!done && canAct.length === 1 && h.p[canAct[0]].bet >= h.currentBet) done = true;
  if (!done) {
    h.toAct = nextIdx(lastSeat, (i) => need.includes(i));
    h.deadline = now + TURN_MS;
    return;
  }
  if (h.street === 'river' || canAct.length <= 1) {
    while (h.board.length < 5) h.board.push(h.deck.pop());
    return showdown(st, now);
  }
  h.street = h.street === 'preflop' ? 'flop' : h.street === 'flop' ? 'turn' : 'river';
  for (let k = 0; k < (h.street === 'flop' ? 3 : 1); k++) h.board.push(h.deck.pop());
  for (const i of seats) { h.p[i].bet = 0; h.p[i].acted = false; }
  h.currentBet = 0;
  h.minRaise = h.bb;
  h.raises++;
  log(st, h.street[0].toUpperCase() + h.street.slice(1) + ': ' + h.board.map(cardTxt).join(' '));
  progress(st, now, h.button);
}

function winByFold(st: Any, now: number, w: number) {
  const h = st.hand;
  const pot = Object.values(h.p).reduce((a: number, q: Any) => a + q.total, 0);
  st.seats[w].stack += pot;
  st.last = { no: h.no, board: h.board, fold: true, shows: {}, winners: [{ seat: w, name: st.seats[w].name, amount: pot, desc: '' }] };
  log(st, st.seats[w].name + ' wins ' + money(pot) + '.');
  endHand(st, now, NEXT_HAND_MS);
}

function showdown(st: Any, now: number) {
  const h = st.hand;
  const all = Object.keys(h.p).map(Number);
  const live = all.filter((i) => !h.p[i].folded);
  const scores: Record<number, number[]> = {};
  for (const i of live) scores[i] = best7([...h.holes[i], ...h.board]);
  // Side pots: one layer per distinct contribution level; only live players who reached a level can win it.
  const levels = [...new Set(all.map((i) => h.p[i].total).filter((x) => x > 0))].sort((a, b) => a - b);
  const pots: { amt: number; elig: number[] }[] = [];
  let prev = 0;
  for (const L of levels) {
    let amt = 0;
    for (const i of all) amt += Math.max(0, Math.min(h.p[i].total, L) - prev);
    const elig = live.filter((i) => h.p[i].total >= L);
    const last = pots[pots.length - 1];
    if (!elig.length && last) last.amt += amt;
    else if (last && last.elig.join() === elig.join()) last.amt += amt;
    else pots.push({ amt, elig: elig.length ? elig : live });
    prev = L;
  }
  const won: Record<number, number> = {};
  const fromButton = (i: number) => (i - h.button + SEATS) % SEATS;
  for (const pot of pots) {
    let best: number[] | null = null; let winners: number[] = [];
    for (const i of pot.elig) {
      const c = best ? cmp(scores[i], best) : 1;
      if (c > 0) { best = scores[i]; winners = [i]; } else if (c === 0) winners.push(i);
    }
    winners.sort((a, b) => fromButton(a) - fromButton(b));
    const share = Math.floor(pot.amt / winners.length);
    let rem = pot.amt - share * winners.length;
    for (const i of winners) { let x = share; if (rem > 0) { x++; rem--; } won[i] = (won[i] || 0) + x; }
  }
  const shows: Record<number, Any> = {};
  for (const i of live) shows[i] = { pid: st.seats[i].pid, cards: h.holes[i], desc: describe(scores[i]) };
  const winners = Object.keys(won).map(Number).map((i) => ({ seat: i, name: st.seats[i].name, amount: won[i], desc: shows[i].desc }));
  for (const w of winners) { st.seats[w.seat].stack += w.amount; log(st, w.name + ' wins ' + money(w.amount) + ' with ' + w.desc.toLowerCase() + '.'); }
  st.last = { no: h.no, board: h.board, fold: false, shows, winners };
  endHand(st, now, SHOWDOWN_MS);
}

function endHand(st: Any, now: number, delay: number) {
  const h = st.hand;
  if (h.fair) {
    // Reveal this hand's seed, with what was actually dealt, so players can check the shuffle.
    const shown: Record<number, string[]> = {};
    if (st.last && st.last.no === h.no) for (const k of Object.keys(st.last.shows)) shown[Number(k)] = st.last.shows[k].cards;
    (st.fairLog || (st.fairLog = [])).push({ no: h.no, ...h.fair, board: h.board.slice(), shown });
    if (st.fairLog.length > 30) st.fairLog.splice(0, st.fairLog.length - 30);
  }
  st.hand = null;
  st.seats.forEach((s: Any, i: number) => { if (s && s.leaving) cashOut(st, i); });
  settleAdds(st);
  st.nextHandAt = st.status === 'running' ? now + delay : null;
}

// Moves the table along on the clock: auto-acts for players who timed out, sat out or left, and deals the next hand.
function tick(st: Any, now: number) {
  let changed = false;
  for (let guard = 0; guard < 30; guard++) {
    const h = st.hand;
    if (h) {
      const i = h.toAct; const s = st.seats[i];
      const timedOut = now >= h.deadline;
      if (s && (s.leaving || s.status === 'sitout' || timedOut)) {
        if (timedOut && !s.leaving && s.status !== 'sitout') { s.status = 'sitout'; log(st, s.name + ' ran out of time and is sitting out.'); }
        act(st, now, i, h.currentBet - h.p[i].bet > 0 ? 'fold' : 'check');
        changed = true;
        continue;
      }
      break;
    }
    if (st.status !== 'running') break;
    if (st.nextHandAt == null) {
      if (st.seats.filter((_: Any, i: number) => eligible(st, i)).length >= 2) { st.nextHandAt = now + 1500; changed = true; }
      break;
    }
    if (now >= st.nextHandAt) {
      changed = true;
      if (startHand(st, now)) continue;
      st.nextHandAt = null;
    }
    break;
  }
  return changed;
}

/* ---------- what each player gets to see ---------- */
function legalFor(st: Any, i: number) {
  const h = st.hand; const p = h.p[i]; const s = st.seats[i];
  const toCall = Math.max(0, h.currentBet - p.bet);
  const maxTo = p.bet + s.stack;
  return {
    toCall: Math.min(toCall, s.stack), canCheck: toCall === 0, canRaise: p.cyc !== h.raises && maxTo > h.currentBet,
    minTo: Math.min(h.currentBet + h.minRaise, maxTo), maxTo, myBet: p.bet, isBet: h.currentBet === 0,
  };
}
function view(id: string, st: Any, token: string, host: boolean, now: number, version: number) {
  const h = st.hand;
  const me = seatOf(st, token);
  const req = token ? st.requests.find((r: Any) => r.token === token && r.kind === 'join') : null;
  const seats = st.seats.map((s: Any, i: number) => {
    if (!s) return null;
    const p = h ? h.p[i] : null;
    let cards = null;
    if (h && p) cards = i === me ? h.holes[i] : p.folded ? null : ['', ''];
    else if (!h && st.last && st.last.shows[i] && st.last.shows[i].pid === s.pid) cards = st.last.shows[i].cards;
    return {
      seat: i, pid: s.pid, name: s.name, stack: s.stack, pendingAdd: s.pendingAdd || 0, status: s.status, leaving: !!s.leaving,
      inHand: !!p, folded: !!(p && p.folded), allIn: !!(p && p.allIn), bet: p ? p.bet : 0, cards,
    };
  });
  const hand = h ? {
    no: h.no, street: h.street, board: h.board, pot: Object.values(h.p).reduce((a: number, q: Any) => a + q.total, 0),
    currentBet: h.currentBet, toAct: h.toAct, deadline: h.deadline, button: h.button, sbSeat: h.sbSeat, bbSeat: h.bbSeat,
    hash: h.fair ? h.fair.hash : null, client: h.fair ? h.fair.client : null, names: h.fair ? h.fair.names : null,
  } : null;
  const ledger = Object.keys(st.ledger).map((pid) => {
    const l = st.ledger[pid];
    const i = st.seats.findIndex((s: Any) => s && s.pid === pid);
    const s = i >= 0 ? st.seats[i] : null;
    const boughtIn = l.buyIns.reduce((a: number, b: number) => a + b, 0);
    const chips = l.cashOut + (s ? s.stack + (s.pendingAdd || 0) : 0);
    return { pid, name: l.name, seat: i, boughtIn, chips, seated: !!s };
  });
  const last = st.last ? { no: st.last.no, board: st.last.board, fold: st.last.fold, winners: st.last.winners } : null;
  return {
    id, version, serverNow: now, name: st.name, sb: st.sb, bb: st.bb, buyIn: st.buyIn, units: st.units || 'dollars', status: st.status, handNo: st.handNo,
    button: h ? h.button : st.button, nextHandAt: st.nextHandAt, seats, hand, last, log: st.log.slice(-25), ledger,
    sentToLedger: st.sentToLedger, gameId: st.gameId,
    nextHash: st.seedNext ? st.seedNext.hash : null,
    fair: (st.fairLog || []).slice(-12).reverse(),
    me: {
      seat: me, request: req ? { seat: req.seat, amount: req.amount } : null, cseed: me >= 0 ? st.seats[me].cseed || '' : '',
      rebuyPending: !!token && st.requests.some((r: Any) => r.token === token && r.kind === 'rebuy'),
      legal: h && me >= 0 && h.toAct === me ? legalFor(st, me) : null,
    },
    isHost: host,
    requests: host ? st.requests.map((r: Any) => ({ id: r.id, kind: r.kind, name: r.name, seat: r.seat, amount: r.amount })) : [],
  };
}

/* ---------- storage ---------- */
async function loadTable(id: string) {
  const { data, error } = await admin.from('poker_tables').select('id,state,version').eq('id', String(id || '')).maybeSingle();
  if (error) throw error;
  if (!data) fail('That table no longer exists.');
  return data;
}
async function saveTable(row: Any, st: Any) {
  const { data, error } = await admin.from('poker_tables')
    .update({ state: st, version: row.version + 1, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('version', row.version).select('id');
  if (error) throw error;
  return data.length === 1;
}
async function broadcast(id: string) {
  try {
    await fetch(SUPABASE_URL + '/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic: 'poker-' + id, event: 'update', payload: {} }, { topic: 'poker-lobby', event: 'update', payload: {} }] }),
    });
  } catch (_) { /* clients also poll */ }
}
// Applies a change with optimistic locking, retrying if two people acted at the same moment.
async function mutate(id: string, host: boolean, token: string, fn: (st: Any, now: number) => Any) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await loadTable(id);
    const st = row.state; const now = Date.now();
    tick(st, now);
    const result = fn(st, now) || {};
    tick(st, now);
    if (await saveTable(row, st)) {
      await broadcast(id);
      return { ...view(id, st, token, host, now, row.version + 1), ...result };
    }
  }
  fail('The table was busy. Try again.');
}
async function readState(id: string, token: string, host: boolean) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await loadTable(id);
    const st = row.state; const now = Date.now();
    if (!tick(st, now)) return view(id, st, token, host, now, row.version);
    if (await saveTable(row, st)) { await broadcast(id); return view(id, st, token, host, now, row.version + 1); }
  }
  const row = await loadTable(id);
  return view(id, row.state, token, host, Date.now(), row.version);
}

/* ---------- access ---------- */
const passCache = new Map<string, number>();
async function keywordOk(req: Request) {
  const pass = (req.headers.get('x-ledger-pass') || '').toLowerCase();
  if (!pass) return false;
  if ((passCache.get(pass) || 0) > Date.now()) return true;
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false }, global: { headers: { 'x-ledger-pass': pass } } });
  const { data } = await client.rpc('has_viewer_pass');
  if (data === true) passCache.set(pass, Date.now() + 5 * 60 * 1000);
  return data === true;
}
async function isHost(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt === ANON_KEY) return false;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return false;
  const r = await admin.from('admins').select('user_id').eq('user_id', data.user.id).maybeSingle();
  return !!r.data;
}

/* ---------- requests ---------- */
async function handle(b: Any, host: boolean) {
  const op = String(b.op || '');
  const id = String(b.table || '');
  const token = String(b.token || '');
  const needHost = () => { if (!host) fail('Only the host can do that.'); };
  const mine = (st: Any) => { const i = seatOf(st, token); if (i < 0) fail("You're not seated at this table."); return i; };

  switch (op) {
    case 'selftest': return { results: selftest() };
    case 'list': {
      const { data, error } = await admin.from('poker_tables').select('id,state,created_at').order('created_at', { ascending: false }).limit(20);
      if (error) throw error;
      return {
        isHost: host,
        tables: data.map((r: Any) => ({
          id: r.id, name: r.state.name, status: r.state.status, sb: r.state.sb, bb: r.state.bb, buyIn: r.state.buyIn, units: r.state.units || 'dollars',
          seated: r.state.seats.filter(Boolean).length, sentToLedger: r.state.sentToLedger, createdAt: r.created_at,
        })),
      };
    }
    case 'create': {
      needHost();
      const name = String(b.name || '').trim().slice(0, 40) || 'Poker night';
      const sb = cents(b.sb, 'The small blind'); const bb = cents(b.bb, 'The big blind'); const buyIn = cents(b.buyIn, 'The buy-in');
      if (bb < sb) fail('The big blind has to be at least the small blind.');
      if (buyIn < bb) fail('The buy-in has to cover at least one big blind.');
      const tid = Math.random().toString(36).slice(2, 10);
      const st = newState(name, sb, bb, buyIn, b.units === 'chips' ? 'chips' : 'dollars');
      log(st, 'Table opened. Blinds ' + money(sb) + '/' + money(bb) + ', buy-in ' + money(buyIn) + '.');
      const { error } = await admin.from('poker_tables').insert({ id: tid, state: st });
      if (error) throw error;
      await broadcast(tid);
      return { id: tid };
    }
    case 'state': return await readState(id, token, host);
    case 'join': {
      const seat = Math.floor(Number(b.seat));
      if (!(seat >= 0 && seat < SEATS)) fail('Pick a seat.');
      let pid = String(b.pid || ''); let name = '';
      if (pid) {
        const r = await admin.from('players').select('id,name').eq('id', pid).maybeSingle();
        if (!r.data) fail('That player was not found.');
        name = r.data.name;
      } else {
        name = String(b.newName || '').trim().slice(0, 30);
        if (!name) fail('Pick your name or type a new one.');
        const all = await admin.from('players').select('id,name');
        const hit = (all.data || []).find((p: Any) => p.name.toLowerCase() === name.toLowerCase());
        if (hit) { pid = hit.id; name = hit.name; } else {
          pid = uid();
          const ins = await admin.from('players').insert({ id: pid, name, created_at: Date.now() });
          if (ins.error) throw ins.error;
        }
      }
      const newToken = crypto.randomUUID();
      return await mutate(id, host, newToken, (st) => {
        if (st.status === 'ended') fail('This game has ended.');
        if (st.seats[seat]) fail('That seat was just taken.');
        if (st.seats.some((s: Any) => s && s.pid === pid)) fail(name + ' is already at the table.');
        if (st.requests.some((r: Any) => r.pid === pid && r.kind === 'join')) fail(name + ' is already waiting to sit down.');
        const r = { id: uid(), kind: 'join', pid, name, seat, amount: st.buyIn, token: newToken, cseed: cleanSeed(b.cseed) };
        if (host) approve(st, r); else { st.requests.push(r); log(st, name + ' asks to sit down.'); }
        return { token: newToken };
      });
    }
    case 'cancel': return await mutate(id, host, token, (st) => { st.requests = st.requests.filter((r: Any) => r.token !== token); });
    case 'act': return await mutate(id, host, token, (st, now) => { act(st, now, mine(st), String(b.type || ''), b.amount); });
    case 'rebuy': return await mutate(id, host, token, (st) => {
      const i = mine(st); const s = st.seats[i];
      if (st.status === 'ended') fail('This game has ended.');
      if (st.requests.some((r: Any) => r.token === token && r.kind === 'rebuy')) fail('Your rebuy is already waiting for the host.');
      const r = { id: uid(), kind: 'rebuy', pid: s.pid, name: s.name, seat: i, amount: st.buyIn, token };
      if (host) approve(st, r); else { st.requests.push(r); log(st, s.name + ' asks to rebuy.'); }
    });
    case 'sitout': return await mutate(id, host, token, (st) => { const s = st.seats[mine(st)]; s.status = 'sitout'; log(st, s.name + ' is sitting out.'); });
    case 'back': return await mutate(id, host, token, (st) => { const s = st.seats[mine(st)]; s.status = 'active'; log(st, s.name + ' is back.'); });
    case 'leave': return await mutate(id, host, token, (st) => { leaveSeat(st, mine(st)); });
    // A player's own seed is mixed into every shuffle they're dealt into, from the next hand on.
    case 'cseed': return await mutate(id, host, token, (st) => { st.seats[mine(st)].cseed = cleanSeed(b.cseed); });

    case 'approve': case 'deny': {
      needHost();
      return await mutate(id, host, token, (st) => {
        const r = st.requests.find((x: Any) => x.id === b.req);
        if (!r) fail('That request has already been handled.');
        st.requests = st.requests.filter((x: Any) => x !== r);
        if (op === 'approve') approve(st, r);
      });
    }
    case 'start': needHost(); return await mutate(id, host, token, (st) => {
      if (st.status === 'ended') fail('This game has ended.');
      log(st, st.status === 'waiting' ? 'The game has started.' : 'The game is back on.');
      st.status = 'running';
    });
    case 'pause': needHost(); return await mutate(id, host, token, (st) => {
      if (st.status !== 'running') fail('The game is not running.');
      st.status = 'paused'; st.nextHandAt = null;
      log(st, 'The host paused the game. The current hand plays out first.');
    });
    case 'blinds': needHost(); return await mutate(id, host, token, (st) => {
      const sb = cents(b.sb, 'The small blind'); const bb = cents(b.bb, 'The big blind');
      if (bb < sb) fail('The big blind has to be at least the small blind.');
      st.sb = sb; st.bb = bb;
      log(st, 'Blinds are ' + money(sb) + '/' + money(bb) + ' from the next hand.');
    });
    case 'units': needHost(); return await mutate(id, host, token, (st) => {
      st.units = b.units === 'chips' ? 'chips' : 'dollars';
      log(st, st.units === 'chips' ? 'Amounts now show as chips (1¢ = 1 chip).' : 'Amounts now show in dollars.');
    });
    case 'kick': needHost(); return await mutate(id, host, token, (st) => {
      const i = Math.floor(Number(b.seat));
      if (!st.seats[i]) fail('That seat is empty.');
      leaveSeat(st, i);
    });
    case 'end': needHost(); return await mutate(id, host, token, (st) => {
      if (st.hand) fail('Finish the current hand first: pause, let it play out, then end the game.');
      st.seats.forEach((s: Any, i: number) => { if (s) cashOut(st, i); });
      st.requests = [];
      st.status = 'ended'; st.nextHandAt = null;
      log(st, 'The game is over.');
    });
    case 'sendLedger': {
      needHost();
      const row = await loadTable(id);
      const st = row.state;
      if (st.status !== 'ended') fail('End the game first.');
      if (st.sentToLedger) fail('This game is already in the ledger.');
      const entries: Record<string, Any> = {};
      for (const pid of Object.keys(st.ledger)) {
        const l = st.ledger[pid];
        if (l.buyIns.length) entries[pid] = { buyIns: l.buyIns.map((c: number) => c / 100), cashOut: l.cashOut / 100 };
      }
      if (!Object.keys(entries).length) fail('Nobody played, so there is nothing to send.');
      const gameId = 'pk' + id;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : new Date().toISOString().slice(0, 10);
      const ins = await admin.from('games').upsert(
        { id: gameId, date, title: st.name, buy_in: st.buyIn / 100, created_at: Date.now(), entries },
        { onConflict: 'id', ignoreDuplicates: true },
      );
      if (ins.error) throw ins.error;
      return await mutate(id, host, token, (s) => { s.sentToLedger = true; s.gameId = gameId; log(s, 'Results were added to the ledger.'); });
    }
    case 'delete': {
      needHost();
      const { error } = await admin.from('poker_tables').delete().eq('id', id);
      if (error) throw error;
      await broadcast(id);
      return { deleted: true };
    }
    default: fail('Unknown request.');
  }
}

/* ---------- self-checks (op: selftest) ---------- */
function selftest() {
  const out: string[] = [];
  const t = (name: string, ok: boolean) => out.push((ok ? 'ok   ' : 'FAIL ') + name);
  const S = (s: string) => best7(s.split(' '));
  t('royal flush beats four of a kind', cmp(S('As Ks Qs Js Ts 2d 3c'), S('Ad Ac Ah As Kd 2d 3c')) > 0);
  t('wheel is a five-high straight', S('Ah 2d 3c 4s 5h Kd Qc').join() === '4,5');
  t('six-high straight beats the wheel', cmp(S('2d 3c 4s 5h 6d Kd Ah'), S('Ah 2d 3c 4s 5h Kd Qc')) > 0);
  t('flush beats straight', cmp(S('2h 7h 9h Jh Kh 3c 4d'), S('9c Td Js Qh Kc 2d 3d')) > 0);
  t('full house uses the best trips', describe(S('Kd Kc Ks 9h 9d 9c 2s')) === 'Kings full of Nines');
  t('two pair kicker decides', cmp(S('Ah Ad Kh Kd Qc 2s 3s'), S('Ah Ad Kh Kd Jc 2s 3s')) > 0);
  t('board two pair plays: tie', cmp(S('2h 2d 9c 9s Ts Th Ac'), S('3h 3d 9c 9s Ts Th Ac')) === 0);
  t('pair kicker decides', cmp(S('Ah Ad Kc 7s 5d 3c 2h'), S('Ah Ad Qc 7s 5d 3c 2h')) > 0);
  t('three pair picks the top two', describe(S('Ah Ad Kh Kd Qc Qs 2s')) === 'Two pair, Aces and Kings');

  // Side pots: A (10) and B (30) all-in, C calls. A has aces, B kings, C nothing.
  const now = 1_000_000;
  const mk = (stacks: number[]) => {
    const st: Any = newState('test', 25, 50, 5000); st.status = 'running';
    stacks.forEach((x, i) => {
      if (!x) return;
      const n = 'ABCDEFGHI'[i];
      st.seats[i] = { pid: n, name: n, stack: x, pendingAdd: 0, status: 'active', token: 't' + n };
      st.ledger[n] = { name: n, buyIns: [x], cashOut: 0 };
    });
    return st;
  };
  const rig = (st: Any, holes: Record<number, string[]>, board: string[]) => { st.hand.holes = holes; st.hand.deck = [...board].reverse(); };
  let st = mk([1000, 3000, 5000]);
  startHand(st, now);
  rig(st, { 0: ['Ah', 'Ad'], 1: ['Kh', 'Kd'], 2: ['7c', '2d'] }, ['3s', '8h', '9c', 'Jd', '4s']);
  t('3-handed: button is seat 1, seat 1 acts first', st.hand.button === 0 && st.hand.toAct === 0);
  act(st, now, 0, 'allin'); act(st, now, 1, 'allin'); act(st, now, 2, 'call');
  t('side pots: A 3000, B 4000, C 2000', st.seats[0].stack === 3000 && st.seats[1].stack === 4000 && st.seats[2].stack === 2000);
  t('chips are conserved', st.seats.reduce((a: number, s: Any) => a + (s ? s.stack : 0), 0) === 9000);

  // Heads-up: button posts the small blind and acts first preflop, last after.
  st = mk([5000, 5000]);
  startHand(st, now);
  t('heads-up: button is small blind and acts first', st.hand.sbSeat === st.hand.button && st.hand.toAct === st.hand.button);
  const btn = st.hand.button; const other = st.hand.bbSeat;
  act(st, now, btn, 'call'); act(st, now, other, 'check');
  t('heads-up: big blind acts first after the flop', st.hand.street === 'flop' && st.hand.toAct === other);
  let threw = false;
  try { act(st, now, other, 'raise', 20); } catch (_) { threw = true; }
  t('a bet below the big blind is refused', threw);
  act(st, now, other, 'raise', 100); act(st, now, btn, 'raise', 300);
  threw = false;
  try { act(st, now, other, 'raise', 350); } catch (_) { threw = true; }
  t('a re-raise smaller than the last raise is refused', threw);
  act(st, now, other, 'fold');
  t('fold gives the pot to the raiser', st.hand === null && st.seats[btn].stack === 5000 + 50 + 100);

  // Split pot: the board plays for both.
  st = mk([5000, 5000]);
  st.sb = 25; st.bb = 25;
  startHand(st, now);
  rig(st, { [st.hand.button]: ['2c', '3d'], [st.hand.bbSeat]: ['2d', '3c'] }, ['Ts', 'Js', 'Qd', 'Kh', 'Ac']);
  act(st, now, st.hand.button, 'raise', 75); act(st, now, st.hand.bbSeat, 'call');
  for (let k = 0; k < 3; k++) { act(st, now, st.hand.toAct, 'check'); act(st, now, st.hand.toAct, 'check'); }
  t('split pot: both players get their chips back', st.seats[0].stack === 5000 && st.seats[1].stack === 5000);

  // Timeouts: a player who runs out of time checks if they can, otherwise folds, and sits out.
  st = mk([5000, 5000, 5000]);
  startHand(st, now);
  const slow = st.hand.toAct;
  tick(st, now + TURN_MS + 1);
  t('timeout folds facing a bet and sits the player out', st.hand.p[slow].folded && st.seats[slow].status === 'sitout');

  // A short all-in doesn't reopen raising for someone who already acted.
  st = mk([5000, 5000, 120]);
  startHand(st, now);
  rig(st, { 0: ['2c', '7d'], 1: ['3c', '8d'], 2: ['4c', '9d'] }, ['Ks', 'Qs', '5h', '6h', 'Jc']);
  act(st, now, 0, 'raise', 100);
  act(st, now, 1, 'call');
  act(st, now, 2, 'allin');
  const legal0 = legalFor(st, 0);
  t('short all-in: earlier raiser may only call or fold', st.hand.toAct === 0 && !legal0.canRaise && legal0.toCall === 20);

  // Fair shuffle: deterministic for the same seeds, a real permutation, different per hand and per client seed.
  const d1 = fairDeck('abc', 'x|y', 1);
  t('fair shuffle: same seeds give the same deck', d1.join() === fairDeck('abc', 'x|y', 1).join());
  t('fair shuffle: deck is all 52 cards once', new Set(d1).size === 52 && d1.length === 52);
  t('fair shuffle: hand number changes the deck', d1.join() !== fairDeck('abc', 'x|y', 2).join());
  t('fair shuffle: a player seed changes the deck', d1.join() !== fairDeck('abc', 'x|z', 1).join());
  // No bias: over 5,200 shuffles each card should be on top about 100 times.
  const top: Record<string, number> = {};
  for (let k = 0; k < 5200; k++) { const d = fairDeck('bias-' + k, 'c', 1); top[d[51]] = (top[d[51]] || 0) + 1; }
  const counts = Object.values(top);
  t('fair shuffle: every card reaches the top evenly (' + Math.min(...counts) + '–' + Math.max(...counts) + ' of ~100)', counts.length === 52 && Math.min(...counts) > 55 && Math.max(...counts) < 150);
  // A dealt hand can be rebuilt from its revealed seed, and the seed matches the hash shown beforehand.
  st = mk([5000, 5000, 5000]);
  st.seats[0].cseed = 'aa'; st.seats[1].cseed = 'bb'; st.seats[2].cseed = 'cc';
  const shownHash = st.seedNext.hash;
  startHand(st, now);
  const f = st.hand.fair;
  const rebuilt = fairDeck(f.seed, f.client, st.hand.no);
  const ok = f.order.every((s: number) => { const c = [rebuilt.pop(), rebuilt.pop()]; return c.join() === st.hand.holes[s].join(); });
  t('fair shuffle: hand uses the hash shown before it', f.hash === shownHash && sha256(f.seed) === f.hash && st.seedNext.hash !== shownHash);
  t('fair shuffle: dealt cards rebuild from the seed', ok && f.client === 'bb|cc|aa');
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    if (!(await keywordOk(req))) return json({ error: 'Enter the keyword first.' }, 401);
    const body = await req.json().catch(() => ({}));
    return json(await handle(body, await isHost(req)));
  } catch (e) {
    if (e instanceof GameError) return json({ error: e.message });
    console.error(e);
    return json({ error: 'Something went wrong on the table server.' }, 500);
  }
});
