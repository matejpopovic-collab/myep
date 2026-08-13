/* ============================================================================
   EPROSTA — WORKER RATING
   ----------------------------------------------------------------------------
   The register used to carry a bare number: `rating: 4.2`. Nobody could say
   where it came from, what would move it, or why one worker outranked another
   in the assign list. A score like that is worse than none — operators stop
   trusting it, and it cannot reward anybody because nobody knows the rules.

   This module replaces it with a score DERIVED from the attendance record, and
   publishes the criteria that produce it. Four properties matter:

     Earned, not awarded.  Every point comes from a shift that was actually
       worked. No supervisor has to remember to rate anyone.

     Recent behaviour counts more.  Weight halves every six months, so a worker
       who has cleaned up their record climbs back — the point of a reward
       system rather than a punishment ledger.

     Small samples are not flattered.  Scores are pulled toward a neutral 4.0
       until a worker has real history, so a brand-new worker cannot outrank a
       60-shift veteran on a fluke.

     A cancelled shift is nobody's fault.  Client cancellations are excluded
       from the sample entirely.

   What it unlocks is deliberately one thing: PRIORITY IN THE STAFFING QUEUE.
   ========================================================================== */

import { ATTENDANCE, EMPLOYEES, NOW } from '@/data/db';
import type { AttendanceOutcome, Employee, Tone } from '@/data/types';

const DAY = 86400000;

/* ==========================================================================
   1. THE CRITERIA
   --------------------------------------------------------------------------
   Stated as data, in one place, so the explainer shown to operators and the
   arithmetic that ranks the queue cannot drift apart.
   ========================================================================== */

export interface PointRule {
  /** `null` means "excluded from the sample entirely". */
  value: number | null;
  label: string;
  blurb: string;
}

export const POINTS: Record<AttendanceOutcome, PointRule> = {
  worked: {
    value: 1.0, label: 'Worked the shift',
    blurb: 'Clocked in and out within tolerance. The full point.',
  },
  overtime: {
    value: 1.0, label: 'Stayed past the finish',
    blurb: 'Counted the same as a clean shift. Staying late is a favour, not a fault.',
  },
  late: {
    value: 0.55, label: 'Clocked in late',
    blurb: 'Just over half a point. It cost the shift something, but they came.',
  },
  'no-show': {
    value: 0.0, label: 'Did not attend',
    blurb: 'No point, and it is the heaviest single thing on the score.',
  },
  cancelled: {
    value: null, label: 'Cancelled by the client',
    blurb: 'Excluded from the sample. A job that never ran is not the worker’s doing.',
  },
};

export const HALF_LIFE_DAYS = 182; // six months
const WEIGHT_FLOOR = 0.12; // nothing ever counts for literally nothing
export const PRIOR = 0.8; // the neutral starting point, 4.0 in stars
export const PRIOR_WEIGHT = 6; // worth about six shifts of evidence

export interface Band {
  id: string;
  label: string;
  tone: Tone;
  min: number;
  minRated: number;
  perk: string;
}

/**
 * The label is what an operator reads in the queue; `perk` is what the band
 * earns, which is the half that makes this a reward scheme rather than a
 * scoreboard.
 */
export const BANDS: Band[] = [
  { id: 'trusted', label: 'Trusted', tone: 'healthy', min: 4.6, minRated: 20,
    perk: 'Offered shifts first, ahead of every other band.' },
  { id: 'reliable', label: 'Reliable', tone: 'info', min: 4.2, minRated: 8,
    perk: 'Offered shifts ahead of Established and below.' },
  { id: 'established', label: 'Established', tone: 'neutral', min: 3.5, minRated: 1,
    perk: 'Standard position in the queue.' },
  { id: 'watch', label: 'Needs a word', tone: 'atRisk', min: 0, minRated: 1,
    perk: 'Offered last. Worth a conversation before the next booking.' },
];

export const NEW_BAND: Band = {
  id: 'new', label: 'New', tone: 'neutral', min: 0, minRated: 0,
  perk: 'Ranked just under Established until there is a record to read.',
};

/* ==========================================================================
   2. THE RECORD
   --------------------------------------------------------------------------
   Real attendance rows first — those are the ones an operator can click
   through to. Older shifts are filled in behind them so a rating has a sample
   to work with, since ATTENDANCE only holds the recent detail.

   The fill is generated to be CONSISTENT WITH what the register already
   asserts: `shiftsWorked` sets the sample size, `strikes` sets the number of
   no-shows, and the old stored `rating` sets roughly how many of the rest were
   late. Without that last one every worker's score would jump the day this
   shipped, with no way to sanity-check the engine against the numbers the
   business already knew.
   ========================================================================== */

interface HistoryRow {
  date: string;
  role: string;
  outcome: AttendanceOutcome;
  eventId: string | null;
  sourceId: string | null;
  real: boolean;
}

export interface WeightedHistoryRow extends HistoryRow {
  daysAgo: number;
  counts: boolean;
  points: number | null;
  weight: number;
}

const HISTORY = new Map<string, HistoryRow[]>();

/** Small deterministic PRNG, so the prototype reads the same on every load. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function buildHistory(emp: Employee): HistoryRow[] {
  // Real rows, newest first.
  const real: HistoryRow[] = ATTENDANCE.filter((a) => a.employeeId === emp.id)
    .map((a) => ({
      date: a.date, role: a.role, outcome: a.outcome,
      eventId: a.eventId, sourceId: a.id, real: true,
    }))
    .sort((x, y) => y.date.localeCompare(x.date));

  const target = Math.max(emp.shiftsWorked || 0, real.length);
  const fill = target - real.length;
  if (fill <= 0) return real;

  const rnd = lcg(parseInt(emp.id.split('-')[1], 10) * 7919);

  // How many of the filled-in shifts went wrong, from what the register says.
  const realNoShows = real.filter((r) => r.outcome === 'no-show').length;
  const noShows = Math.max(0, Math.min(fill, (emp.strikes || 0) - realNoShows));
  const shortfall = Math.max(0, 1 - (emp.priorRating || 4) / 5);
  const lates = Math.min(fill - noShows, Math.round(fill * shortfall * 1.5));
  const overtimes = Math.round(fill * 0.08);

  const outcomes: AttendanceOutcome[] = ([] as AttendanceOutcome[])
    .concat(Array<AttendanceOutcome>(noShows).fill('no-show'))
    .concat(Array<AttendanceOutcome>(lates).fill('late'))
    .concat(Array<AttendanceOutcome>(overtimes).fill('overtime'))
    .concat(Array<AttendanceOutcome>(Math.max(0, fill - noShows - lates - overtimes)).fill('worked'));

  // Shuffle deterministically. A worker still on the books after a recent
  // no-show is the unusual case, not the default.
  for (let i = outcomes.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]];
  }

  const step = Math.min(30, Math.max(5, Math.round(540 / target)));
  const start = real.length
    ? +new Date(real[real.length - 1].date) - step * DAY
    : NOW.getTime() - 21 * DAY;

  const roles = [emp.department, 'Event Steward'];
  const filled: HistoryRow[] = outcomes.map((outcome, i) => ({
    date: new Date(start - i * step * DAY).toISOString().slice(0, 10),
    role: roles[i % roles.length],
    outcome, eventId: null, sourceId: null, real: false,
  }));

  return real.concat(filled);
}

/** Every shift behind a worker's score, newest first, with its weighting. */
export function history(emp: Employee): WeightedHistoryRow[] {
  if (!HISTORY.has(emp.id)) HISTORY.set(emp.id, buildHistory(emp));
  return HISTORY.get(emp.id)!.map((h) => {
    const daysAgo = Math.max(0, Math.round((+NOW - +new Date(h.date)) / DAY));
    const p = POINTS[h.outcome] || POINTS.worked;
    return {
      ...h, daysAgo,
      counts: p.value !== null,
      points: p.value,
      weight: p.value === null ? 0 : Math.max(WEIGHT_FLOOR, Math.pow(0.5, daysAgo / HALF_LIFE_DAYS)),
    };
  });
}

/* ==========================================================================
   3. THE SCORE
   ========================================================================== */

export interface Score {
  value: number;
  band: Band;
  rated: number;
  excluded: number;
  counts: Record<AttendanceOutcome, number>;
  streak: number;
  raw: number | null;
  attendance: number | null;
  recent: number;
  recentLate: number;
  recentNoShow: number;
  next: { label: string; needs: string[]; perk: string } | null;
}

export function score(emp: Employee): Score {
  const rows = history(emp);
  const counted = rows.filter((r) => r.counts);

  const wSum = counted.reduce((s, r) => s + r.weight, 0);
  const pSum = counted.reduce((s, r) => s + r.weight * (r.points as number), 0);

  // Shrunk toward the neutral prior. With no history at all this returns
  // exactly PRIOR, which is why an unrated worker sits mid-table rather than at
  // either extreme.
  const adjusted = (pSum + PRIOR_WEIGHT * PRIOR) / (wSum + PRIOR_WEIGHT);
  const value = Math.round(adjusted * 5 * 10) / 10;

  const counts: Record<AttendanceOutcome, number> = {
    worked: 0, overtime: 0, late: 0, 'no-show': 0, cancelled: 0,
  };
  rows.forEach((r) => {
    counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  });

  // Clean run: consecutive most-recent shifts with nothing against them.
  let streak = 0;
  for (const r of counted) {
    if (r.outcome === 'no-show' || r.outcome === 'late') break;
    streak++;
  }

  // Behaviour inside the window that actually drives the score, which is the
  // only period a worker can still change.
  const recent = counted.filter((r) => r.daysAgo <= 365);
  const recentClean = recent.filter((r) => r.outcome !== 'no-show' && r.outcome !== 'late').length;
  const recentLate = recent.filter((r) => r.outcome === 'late').length;
  const recentNoShow = recent.filter((r) => r.outcome === 'no-show').length;

  const band = bandFor(value, counted.length);

  return {
    value, band,
    rated: counted.length,
    excluded: counts.cancelled,
    counts, streak,
    raw: wSum ? Math.round((pSum / wSum) * 1000) / 1000 : null,
    attendance: recent.length ? Math.round((recentClean / recent.length) * 100) : null,
    recent: recent.length, recentLate, recentNoShow,
    next: nextBand(value, counted.length),
  };
}

export function bandFor(value: number, rated: number): Band {
  if (!rated) return NEW_BAND;
  return BANDS.find((b) => value >= b.min && rated >= b.minRated) || BANDS[BANDS.length - 1];
}

/** What this worker would have to do to move up. The reward, spelled out. */
function nextBand(value: number, rated: number): Score['next'] {
  const cur = bandFor(value, rated);
  const idx = BANDS.findIndex((b) => b.id === cur.id);
  const target = cur.id === 'new' ? BANDS[2] : BANDS[idx - 1];
  if (!target) return null;

  const needs: string[] = [];
  if (value < target.min) needs.push(`reach ${target.min.toFixed(1)}`);
  if (rated < target.minRated) {
    const n = target.minRated - rated;
    needs.push(`${n} more rated ${n === 1 ? 'shift' : 'shifts'}`);
  }
  if (!needs.length) needs.push('hold this record');
  return { label: target.label, needs, perk: target.perk };
}

/* ==========================================================================
   4. THE REWARD — QUEUE ORDER
   --------------------------------------------------------------------------
   Band first, then score. Band before raw score matters: the order is
   explainable in a word rather than by a decimal nobody can defend, and two
   workers a tenth apart are not shuffled between one screen and the next. An
   outstanding open application floats a worker up within their band — they
   asked for the shift, so they get looked at first.
   ========================================================================== */

const RANK: Record<string, number> = { trusted: 4, reliable: 3, established: 2, new: 1, watch: 0 };

export function compare(a: Employee, b: Employee): number {
  const sa = score(a);
  const sb = score(b);
  if (RANK[sb.band.id] !== RANK[sa.band.id]) return RANK[sb.band.id] - RANK[sa.band.id];
  if (sb.value !== sa.value) return sb.value - sa.value;
  return sb.rated - sa.rated;
}

export interface QueueRow {
  emp: Employee;
  score: Score;
  applied: boolean;
  position: number;
  reason: string;
}

/**
 * Order a list of workers for a shift and say WHY each sits where it does.
 * `applied` is the set of worker ids with an open application for this role.
 */
export function queue(list: Employee[], opts: { applied?: Set<string> | string[] } = {}): QueueRow[] {
  const set = opts.applied instanceof Set ? opts.applied : new Set(opts.applied || []);
  return list
    .map((emp) => ({ emp, score: score(emp), applied: set.has(emp.id) }))
    .sort((x, y) => {
      if (RANK[y.score.band.id] !== RANK[x.score.band.id]) {
        return RANK[y.score.band.id] - RANK[x.score.band.id];
      }
      if (x.applied !== y.applied) return x.applied ? -1 : 1;
      if (y.score.value !== x.score.value) return y.score.value - x.score.value;
      return y.score.rated - x.score.rated;
    })
    .map((r, i) => ({ ...r, position: i + 1, reason: reason(r) }));
}

/**
 * Why this worker sits where they sit, in counts rather than a percentage. A
 * percentage invites the wrong question — "74% clean, so why are they 4.3?" —
 * because lateness is a partial deduction, not a zero.
 */
export function reason(r: { score: Score; applied: boolean }): string {
  const s = r.score;
  if (!s.rated) return 'No record yet — ranked mid-table until there is one';

  const bits: string[] = [];
  if (r.applied) bits.push('applied for this shift');
  bits.push(`${s.recent} shift${s.recent === 1 ? '' : 's'} in the last year`);
  bits.push(
    s.recentLate
      ? `${s.recentLate} late`
      : s.streak >= 5
        ? `${s.streak} in a row with nothing against them`
        : 'never late',
  );
  if (s.counts['no-show']) {
    bits.push(`${s.counts['no-show']} no-show${s.counts['no-show'] === 1 ? '' : 's'} on record`);
  }
  return bits.join(' · ');
}

/** One line an operator can act on, without opening anything. */
export function summary(emp: Employee): string {
  const s = score(emp);
  if (!s.rated) return 'No attendance record yet';
  const parts = [`${s.recent} shift${s.recent === 1 ? '' : 's'} in the last year`];
  parts.push(s.recentLate ? `${s.recentLate} late` : 'never late');
  if (s.counts['no-show'])
    parts.push(`${s.counts['no-show']} no-show${s.counts['no-show'] === 1 ? '' : 's'}`);
  if (s.streak >= 3) parts.push(`${s.streak} clean in a row`);
  return parts.join(' · ');
}

/* ==========================================================================
   5. PUBLISH BACK ONTO THE REGISTER
   --------------------------------------------------------------------------
   `emp.rating` and `emp.ratedShifts` are overwritten with the derived values,
   so the star widget, the staff list sort and the assign dialog all read the
   same number this module computed. There is no second rating to disagree with
   — the register stores a cache of this calculation rather than a rival
   opinion. The original is kept as `priorRating` because the history generator
   needs it, and because seeing what the number used to be is worth something
   during a rollout.
   ========================================================================== */

EMPLOYEES.forEach((e) => {
  if (e.priorRating == null) e.priorRating = e.rating;
});
EMPLOYEES.forEach((e) => {
  const s = score(e);
  e.rating = s.value;
  e.ratedShifts = s.rated;
  e.ratingBand = s.band.id;
});
