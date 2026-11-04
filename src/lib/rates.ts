/* ============================================================================
   EPROSTA — CLIENT RATES (what THIS account pays)
   ----------------------------------------------------------------------------
   The table of charges answers "what does a Response Steward cost". It cannot
   answer "what does a Response Steward cost THE JOCKEY CLUB", and that is the
   number on the quote. Until now the answer lived in an email thread, a signed
   framework nobody had scanned, and one manager's memory — so the same role was
   quoted at three prices in a month and the one the client queried was the one
   that had been right.

   Two mechanisms, deliberately unequal in weight:

     A RATE CARD is a blanket position on the published table — Standard,
     Preferred, Premium (see `RATE_CARDS`). It is a factor, applied to whatever
     the table says on the day a line is priced, so it cannot fall behind an
     April rate rise. Every account has one; `null` on the record means Standard.

     A CLIENT PRICE is one agreed number, for one charge line, for one account.
     It beats the card. This is where "we hold SIA at £22.50 for the Jockey Club
     and nothing else moved" goes, and it is the thing a card mathematically
     cannot express.

   WHY THE PRICE LIST IS ABSOLUTE AND THE CARD IS NOT
   -------------------------------------------------
   They are different kinds of promise. A card is a relationship — "you get our
   framework rate" — and should follow the published card upward. A client price
   is a NUMBER someone signed: £22.50 means £22.50, and quietly indexing it to a
   rate rise would be a price increase nobody agreed to. So a card floats and an
   agreed price is held, which is also how each side would describe it if you
   asked them.

   The consequence is that an agreed price ages. `staleAgreements()` finds the
   ones that have fallen below cost or below the margin floor, because the
   failure mode of a held price is not that it is wrong on the day — it is that
   nobody looks at it again for three years.

   WHAT THIS MODULE WILL NOT DO
   ----------------------------
   It never touches a line that has already been priced. `LineItem.snap` freezes
   the rate onto the job, and an agreement signed today does not re-price a
   quote sent last month — the same rule the charge versions exist to enforce,
   applied to the second thing that can change a price. Moving an existing line
   onto a new agreement is `repriceLine`: explicit, audited, one line at a time.
   ========================================================================== */

import {
  CHARGES, CLIENTS, DEFAULT_CARD, NOW, RATE_CARDS, charge as chargeById,
  client as clientById, rateAt, rateCard, scaleTiers,
} from '@/data/db';
import type { ChargeKind, ChargeUnit, ClientPrice, RateCard, ResolvedRate } from '@/data/types';
import { money, round2 } from './format';
import * as ROLES from './roles';
import * as HISTORY from './clienthistory';
import * as WAGES from './wages';
import type { WageFrameworkId } from './wages';

const KEY = 'eprosta.rates.v1';

/* ------------------------------------------------------------------ store */

const listeners = new Set<() => void>();
let version = 0;

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = (): number => version;
function emit(): void {
  version += 1;
  listeners.forEach((fn) => fn());
}

/** Which wage frameworks an account is set up for, and which a new job starts on. */
export interface ClientFrameworks {
  enabled: WageFrameworkId[];
  default: WageFrameworkId;
}

interface Journal {
  v: 1;
  /** clientId -> chargeId -> the agreed price. These are NLW prices — every
      journal written before wage frameworks shipped is exactly that. */
  prices: Record<string, Record<string, ClientPrice>>;
  /** clientId -> RLW/LLW -> chargeId -> the agreed price under that framework.
      Kept apart from `prices` so an old journal loads untouched. */
  framed: Record<string, Partial<Record<WageFrameworkId, Record<string, ClientPrice>>>>;
  /** clientId -> the frameworks set up on the account. Absent = NLW only. */
  frameworks: Record<string, ClientFrameworks>;
}

const empty = (): Journal => ({ v: 1, prices: {}, framed: {}, frameworks: {} });

function load(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Journal | null;
    if (!raw || raw.v !== 1 || !raw.prices) return empty();
    return { v: 1, prices: raw.prices, framed: raw.framed || {}, frameworks: raw.frameworks || {} };
  } catch {
    return empty();
  }
}

let JOURNAL: Journal = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(JOURNAL));
  } catch {
    /* private mode — degrades to in-memory */
  }
  emit();
}

/* --------------------------------------------------------------- seeding */
/*
   Three agreements EP already has in writing, so the screen is not empty on a
   first run and the demo shows the thing the module exists for: an account
   whose card says one number and whose signed schedule says another.
*/

const SEED: ClientPrice[] = [
  { clientId: 'c-12', chargeId: 'ch-st-sia', charge: 22.5, at: '2026-01-14T10:00:00',
    by: 'Colin Braithwaite', note: 'Raceday stewarding framework, schedule 2 — held to Jan 2027.' },
  { clientId: 'c-12', chargeId: 'ch-st-event', charge: 17.25, at: '2026-01-14T10:00:00',
    by: 'Colin Braithwaite', note: 'Raceday stewarding framework, schedule 2.' },
  { clientId: 'c-24', chargeId: 'ch-st-sia', charge: 23.0, at: '2026-02-02T09:30:00',
    by: 'Colin Braithwaite', note: 'Matched to the Jockey Club rate at renewal.' },
  { clientId: 'c-19', chargeId: 'ch-kit-radio', charge: 6.25, at: '2025-11-20T14:00:00',
    by: 'Dawn Cartwright', note: 'MSA appendix C — radios at a fixed day rate across all sites.' },
];

(function seed() {
  let touched = false;
  SEED.forEach((p) => {
    if (!clientById(p.clientId) || !chargeById(p.chargeId)) return;
    const forClient = (JOURNAL.prices[p.clientId] ||= {});
    // Only where the operator has not already set one. A seeded agreement is a
    // starting position, never something that overwrites a real decision.
    if (forClient[p.chargeId] === undefined) {
      forClient[p.chargeId] = { ...p };
      touched = true;
    }
  });
  /* Three accounts that pay above the statutory floor, so the framework
     controls have something to show: the All England Club in London, a
     council on the real Living Wage, and a festival promoter that runs both
     kinds of site. Only where nobody has set the account up already. */
  const FW_SEED: Record<string, ClientFrameworks> = {
    'c-6': { enabled: ['nlw', 'llw'], default: 'llw' },
    'c-22': { enabled: ['nlw', 'rlw'], default: 'rlw' },
    'c-19': { enabled: ['nlw', 'rlw', 'llw'], default: 'nlw' },
  };
  Object.entries(FW_SEED).forEach(([id, fw]) => {
    if (!clientById(id) || JOURNAL.frameworks[id]) return;
    JOURNAL.frameworks[id] = { enabled: [...fw.enabled], default: fw.default };
    touched = true;
  });
  if (touched) persist();
})();

/* ------------------------------------------------------ wage frameworks */

const orderFw = (ids: WageFrameworkId[]): WageFrameworkId[] =>
  WAGES.FRAMEWORKS.map((f) => f.id).filter((id) => id === 'nlw' || ids.includes(id));

/** The frameworks this account can be quoted under. NLW is always one of them. */
export function clientFrameworks(clientId: string | null | undefined): WageFrameworkId[] {
  const set = clientId ? JOURNAL.frameworks[clientId] : null;
  return orderFw(set ? set.enabled.filter(WAGES.isFramework) : []);
}

/** The framework a new job for this account starts on. */
export function defaultFramework(clientId: string | null | undefined): WageFrameworkId {
  const set = clientId ? JOURNAL.frameworks[clientId] : null;
  const d = set?.default;
  return d && clientFrameworks(clientId).includes(d) ? d : WAGES.DEFAULT_FRAMEWORK;
}

/** How many accounts are set up for a framework — for the table of charges. */
export const accountsOnFramework = (id: WageFrameworkId): number =>
  CLIENTS.filter((c) => clientFrameworks(c.id).includes(id)).length;

export function setFrameworksBlocker(clientId: string): string | null {
  if (!ROLES.can('clients.rates')) return ROLES.denial('clients.rates') || 'You cannot change client rates.';
  if (!clientById(clientId)) return 'No such client.';
  return null;
}

/**
 * Set which frameworks the account is quoted under. Switching one OFF leaves
 * any job already priced under it alone — that job was sold at that rate — and
 * keeps the prices agreed under it, so switching it back on restores them.
 */
export function setClientFrameworks(
  clientId: string,
  enabled: WageFrameworkId[],
  def: WageFrameworkId,
): Result {
  const blocker = setFrameworksBlocker(clientId);
  if (blocker) return { ok: false, reason: blocker };
  const list = orderFw(enabled.filter(WAGES.isFramework));
  const d = list.includes(def) ? def : 'nlw';
  const before = clientFrameworks(clientId);
  const beforeDef = defaultFramework(clientId);
  JOURNAL.frameworks[clientId] = { enabled: list, default: d };
  persist();
  const name = (ids: WageFrameworkId[]) => ids.map((i) => WAGES.framework(i).short).join(', ');
  const changes = [];
  if (name(before) !== name(list)) changes.push({ label: 'Wage frameworks', from: name(before), to: name(list) });
  if (beforeDef !== d)
    changes.push({ label: 'Default for new jobs', from: WAGES.framework(beforeDef).label, to: WAGES.framework(d).label });
  if (changes.length) HISTORY.record({ clientId, area: 'rates', title: 'Wage frameworks changed', changes });
  return { ok: true };
}

/* -------------------------------------------------------------- reading */

export const cards = (): RateCard[] => RATE_CARDS;

/** The card an account is priced from. `null` on the record means Standard. */
export function clientCardId(clientId: string | null | undefined): string {
  const c = clientId ? clientById(clientId) : null;
  return c?.rateCardId || DEFAULT_CARD;
}

export const clientCard = (clientId: string | null | undefined): RateCard =>
  rateCard(clientCardId(clientId));

/**
 * Only STAFF prices are per framework. A radio costs the same whoever is
 * holding it, so a kit or services price agreed with the account holds under
 * every framework — it is filed, and found, under NLW.
 */
const fwFor = (chargeId: string, fw: WageFrameworkId): WageFrameworkId =>
  chargeById(chargeId)?.kind === 'staff' ? fw : 'nlw';

function priceMap(clientId: string, fw: WageFrameworkId): Record<string, ClientPrice> | undefined {
  return fw === 'nlw' ? JOURNAL.prices[clientId] : JOURNAL.framed[clientId]?.[fw];
}

/**
 * Prices agreed with this account, newest first. With a framework, only the
 * ones agreed under it; without one, every framework's.
 */
export function clientPrices(clientId: string, fw?: WageFrameworkId): ClientPrice[] {
  const ids = fw ? [fw] : WAGES.FRAMEWORKS.map((f) => f.id);
  return ids
    .flatMap((id) => Object.values(priceMap(clientId, id) || {}).map((p) => ({ ...p, framework: id })))
    .sort((a, b) => +new Date(b.at) - +new Date(a.at));
}

export function clientPrice(
  clientId: string,
  chargeId: string,
  fw: WageFrameworkId = 'nlw',
): ClientPrice | null {
  return priceMap(clientId, fwFor(chargeId, fw))?.[chargeId] || null;
}

/** How many accounts hold an agreed price for this charge line, under any framework. */
export function accountsHolding(chargeId: string): number {
  return CLIENTS.filter((c) => WAGES.FRAMEWORKS.some((f) => clientPrice(c.id, chargeId, f.id))).length;
}

/** How many accounts are priced from a given card. Read at render, never
    cached: `clients.ts` replays its journal over CLIENTS at import, and a
    count taken at module load would be the seed's, not the register's. */
export function accountsOnCard(cardId: string): number {
  return CLIENTS.filter((c) => (c.rateCardId || DEFAULT_CARD) === cardId).length;
}

/* ------------------------------------------------------------- resolving */

/**
 * What `clientId` is charged for `chargeId` on `when` — the one function
 * quoting calls, and the only place the order of precedence is written down.
 *
 *     an agreed price   beats   the account's card   beats   the published rate
 *
 * `clientId` is optional so a screen with no account in hand (the rate card
 * itself, the stock register) resolves the published rate exactly as it always
 * did.
 */
export function rateFor(
  chargeId: string,
  clientId?: string | null,
  when?: string | Date | null,
  frameworkId?: string | null,
  /** When the hours are WORKED — the wage floor that applies then, which for a
      job quoted in November and run next June is a different number. Defaults
      to `when`. */
  workedOn?: string | Date | null,
): ResolvedRate | null {
  const cardId = clientCardId(clientId);
  const fw: WageFrameworkId = WAGES.isFramework(frameworkId) ? frameworkId : 'nlw';
  const base = frameworkRate(chargeId, when, cardId, fw, workedOn);
  if (!base) return null;

  const agreed = clientId ? clientPrice(clientId, chargeId, fw) : null;
  if (!agreed) return base;

  // The volume breaks come off the PUBLISHED rate, not off the card price the
  // agreement replaced — otherwise the same discount would be applied twice.
  const published = rateAt(chargeId, when);
  const list = published?.charge ?? base.charge;
  return {
    ...base,
    charge: agreed.charge,
    tiers: scaleTiers(published?.tiers || [], list, agreed.charge),
    basis: 'client',
  };
}

/**
 * A charge line on a card, under a wage framework, with no client agreement.
 *
 * The published table is priced for the statutory floor. A framework above it
 * raises a STAFF line's cost by exactly the extra pay per hour (`premiumOn`),
 * and the charge moves by the same proportion so the margin holds — EP does not
 * absorb the difference, and does not mark it up either. Kit and services are
 * not paid by the hour and do not move. `lineIsStale` re-asks this, so a line
 * is compared with its own framework rather than read as stale against NLW.
 */
export function frameworkRate(
  chargeId: string,
  when: string | Date | null | undefined,
  cardId: string,
  fw: WageFrameworkId,
  workedOn?: string | Date | null,
): ResolvedRate | null {
  const base = rateAt(chargeId, when, cardId);
  if (!base) return null;
  const premium = base.kind === 'staff' ? WAGES.premiumOn(fw, workedOn || when) : 0;
  return { ...withPremium(base, premium), framework: fw };
}

/** A resolved NLW rate with `premium` extra pay per hour folded in, margin held. */
export function withPremium(base: ResolvedRate, premium: number): ResolvedRate {
  if (!premium || !base.cost) return { ...base, wagePremium: 0 };
  const cost = round2(base.cost + premium);
  const ratio = cost / base.cost;
  const charge = round2(base.charge * ratio);
  return {
    ...base,
    cost,
    charge,
    tiers: scaleTiers(base.tiers || [], base.charge, charge),
    wagePremium: premium,
  };
}

/** What the account pays today, per charge line. Powers the client rates tab. */
export interface RateRow {
  chargeId: string;
  code: string;
  name: string;
  kind: ChargeKind;
  unit: ChargeUnit;
  cost: number;
  /** The published charge-out today. */
  list: number;
  /** What this account pays today, after card and price list. */
  effective: number;
  basis: 'standard' | 'card' | 'client';
  agreed: ClientPrice | null;
  margin: number;
  retired: boolean;
}

export function rateTable(clientId: string, fw: WageFrameworkId = 'nlw'): RateRow[] {
  return CHARGES.map((ch) => {
    const r = rateFor(ch.id, clientId, NOW, fw)!;
    const list = rateAt(ch.id, NOW)!.charge;
    return {
      chargeId: ch.id,
      code: ch.code,
      name: ch.name,
      kind: ch.kind,
      unit: ch.unit,
      cost: r.cost,
      list,
      effective: r.charge,
      basis: (r.basis || 'standard') as RateRow['basis'],
      agreed: clientPrice(clientId, ch.id, fw),
      margin: r.charge ? Math.round(((r.charge - r.cost) / r.charge) * 100) : 0,
      retired: !!ch.retired,
    };
  });
}

/**
 * Agreed prices that have gone bad.
 *
 * A held price does not announce itself when the cost underneath it rises. The
 * two states worth naming are different in kind: BELOW COST is a line EP loses
 * money on every time it is quoted; THIN still makes money, but no longer
 * enough to cover the cost of running the job around it.
 */
export const MARGIN_FLOOR = 25;

export interface StaleAgreement {
  price: ClientPrice;
  cost: number;
  margin: number;
  severity: 'below-cost' | 'thin';
}

export function staleAgreements(clientId: string): StaleAgreement[] {
  return clientPrices(clientId)
    .map((price) => {
      // The cost under the framework it was agreed for: an RLW price is held
      // against an RLW wage bill, which rises every May whether or not anyone
      // reopens the agreement.
      const fw = WAGES.isFramework(price.framework) ? price.framework : 'nlw';
      const r = frameworkRate(price.chargeId, NOW, DEFAULT_CARD, fw);
      const cost = r?.cost ?? 0;
      const margin = price.charge ? Math.round(((price.charge - cost) / price.charge) * 100) : 0;
      return {
        price, cost, margin,
        severity: (price.charge < cost ? 'below-cost' : 'thin') as StaleAgreement['severity'],
      };
    })
    .filter((s) => s.price.charge < s.cost || s.margin < MARGIN_FLOOR);
}

/* --------------------------------------------------------------- writing */

export interface Result {
  ok: boolean;
  reason?: string;
}

/**
 * Why this price cannot be agreed, or null.
 *
 * Below cost is refused rather than warned about. EP sells some things at cost
 * deliberately — that passes — but a price that loses money on every unit is
 * either a typo or a decision nobody meant to take through a rate table, and
 * the table of charges already refuses exactly this at exactly this point.
 */
export function setPriceBlocker(
  clientId: string,
  chargeId: string,
  charge: number,
  fw: WageFrameworkId = 'nlw',
): string | null {
  /* `clients.rates`, not `charges.edit`. Agreeing a price with one account is
     the job of whoever negotiated it — a Senior Manager or the Client Manager
     who owns the relationship — and it can only ever move what THIS client
     pays. Changing the published table every client is priced from stays
     Finance's, behind `charges.edit`, where it belongs. */
  if (!ROLES.can('clients.rates')) return ROLES.denial('clients.rates') || 'You cannot agree a client rate.';
  if (!clientById(clientId)) return 'No such client.';
  if (!clientFrameworks(clientId).includes(fw))
    return `${WAGES.framework(fw).label} is not set up for this account.`;
  const r = frameworkRate(chargeId, NOW, DEFAULT_CARD, fw);
  if (!r) return 'No such charge line.';
  if (!Number.isFinite(charge) || charge <= 0) return 'Give it a price.';
  if (charge < r.cost)
    return `${money(charge)} is below the ${money(r.cost)} cost price — every one of these would lose money.`;
  return null;
}

export function setClientPrice(
  clientId: string,
  chargeId: string,
  charge: number,
  opts: { note?: string; by?: string; framework?: WageFrameworkId } = {},
): Result {
  const fw = fwFor(chargeId, opts.framework || 'nlw');
  const blocker = setPriceBlocker(clientId, chargeId, charge, fw);
  if (blocker) return { ok: false, reason: blocker };
  const was = rateFor(chargeId, clientId, NOW, fw);
  const hadAgreed = clientPrice(clientId, chargeId, fw);

  const target =
    fw === 'nlw'
      ? (JOURNAL.prices[clientId] ||= {})
      : ((JOURNAL.framed[clientId] ||= {})[fw] ||= {});
  target[chargeId] = {
    clientId,
    chargeId,
    ...(fw === 'nlw' ? {} : { framework: fw }),
    charge: round2(charge),
    note: (opts.note || '').trim(),
    at: new Date().toISOString(),
    by: opts.by || ROLES.actingActor().name,
  };
  persist();
  const ch = chargeById(chargeId);
  HISTORY.record({
    clientId,
    area: 'rates',
    title: `${hadAgreed ? 'Agreed price changed' : 'Price agreed'}: ${ch?.name ?? chargeId}${fw === 'nlw' ? '' : ` (${WAGES.framework(fw).short})`}`,
    changes: [
      {
        label: hadAgreed ? 'Agreed price' : 'Price',
        from: was ? `${money(was.charge)}${hadAgreed ? '' : ` (${was.basis === 'card' ? 'rate card' : 'published'})`}` : '—',
        to: money(round2(charge)),
      },
    ],
    note: (opts.note || '').trim() || undefined,
  });
  return { ok: true };
}

/**
 * Drop an agreed price. The account falls back to its card — which is itself a
 * price change, so the caller is expected to say what the line will now cost
 * rather than reporting "removed" and leaving the operator to work it out.
 */
export function clearClientPrice(clientId: string, chargeId: string, fwIn: WageFrameworkId = 'nlw'): Result {
  const fw = fwFor(chargeId, fwIn);
  if (!ROLES.can('clients.rates'))
    return { ok: false, reason: ROLES.denial('clients.rates') || 'You cannot change a client rate.' };
  const forClient = priceMap(clientId, fw);
  if (!forClient || !forClient[chargeId]) return { ok: false, reason: 'There is no agreed price for that line.' };
  const dropped = forClient[chargeId];
  delete forClient[chargeId];
  if (!Object.keys(forClient).length) {
    if (fw === 'nlw') delete JOURNAL.prices[clientId];
    else delete JOURNAL.framed[clientId]![fw];
  }
  persist();
  const now = rateFor(chargeId, clientId, NOW, fw);
  HISTORY.record({
    clientId,
    area: 'rates',
    title: `Agreed price dropped: ${chargeById(chargeId)?.name ?? chargeId}${fw === 'nlw' ? '' : ` (${WAGES.framework(fw).short})`}`,
    changes: [
      {
        label: 'Price',
        from: money(dropped.charge),
        to: now ? `${money(now.charge)} (${now.basis === 'card' ? 'rate card' : 'published'})` : '—',
      },
    ],
  });
  return { ok: true };
}

/** Test seam, and the "start again" the client rates tab offers. */
export function resetClientPrices(clientId?: string): void {
  if (clientId) {
    delete JOURNAL.prices[clientId];
    delete JOURNAL.framed[clientId];
  } else JOURNAL = { ...empty(), frameworks: JOURNAL.frameworks };
  persist();
}
