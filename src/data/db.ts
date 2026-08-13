/* ============================================================================
   EPROSTA — mock data + reference data
   ----------------------------------------------------------------------------
   Reconstructed from the seven screenshots of app.test.eprosta.com, then typed.

   ONE DELIBERATE DATA FIX, per the critique's closing note:
   the live app showed four irreconcilable numbers for the same Wilderness
   shift — list card `14 / 15`, split badge `14/1`, `Qty Required: 1`, and 15
   staff rows. Here there is a single source of truth:

       split.required          -> how many bodies the role needs
       split.assignments[]     -> who is on it
       filled = assignments where confirmation === 'confirmed'

   Everything on every screen derives from those. Wilderness therefore reads
   15 required, 15 assigned, 14 confirmed => 14/15 everywhere, and the one
   unconfirmed person is visibly the reason the gap exists.

   REFERENCE DATA (briefing §2.1) is merged in at the bottom of this file:
   table of charges, client records, event schedules, staff register, job types
   and document types. Charges are VERSIONED — `rateAt(id, date)` resolves the
   rate that applied on a given date, which is what stops an April rate rise
   from silently re-pricing a job invoiced in March.
   ========================================================================== */

import type {
  AppNotification, Assignment, AttendanceRow, Charge, ChargeTier, ChargeVersion,
  CheckIn, Client, ClientBase, ClientExtra, DayEntry, DayStateKind, DocumentType,
  Employee, EmployeeBase, EmployeeExtra, EpEvent, EventScheduleEntry, JobType,
  Manager, ResolvedRate, Split, Tag, TeamBand, TeamMember,
} from './types';
// `NOW` is re-exported below for the screens, but a re-export creates no local
// binding — `buildDayEntries()` needs the value in scope here.
import { NOW, shiftDeep } from './clock';

/* The clock is real, and the seed is moved to meet it. See `./clock.ts` for
   why the offset is whole weeks and why it is pinned at first run rather than
   recomputed. Re-exported here because every screen already imports `NOW`
   from `@/data/db` and there is no reason to make them all learn a new path. */
export { NOW, SHIFT_DAYS, SEED_ANCHOR, clockNote, reanchor } from './clock';

/* ---------------------------------------------------------------- offices */
export const OFFICES: string[] = [
  'All Offices', 'EP Event Services', 'EP Team South', 'London',
  'South East', 'North East', 'Northampton', 'Midlands',
];

export const DEPARTMENTS: string[] = ['Stewarding', 'Traffic & Car Park', 'Hospitality', 'Security', 'Bar', 'Control Room'];

export const JOB_ROLES: string[] = [
  'Car Park Steward', 'Event Steward', 'Response Steward', 'Taxi Marshal',
  'Bar Staff', 'Hospitality Host', 'Gate Supervisor', 'Control Room Operator',
  'Pit Steward', 'Turnstile Operator',
];

export const TAGS: Tag[] = [
  { id: 'sia',        label: 'SIA Licensed',      tone: 'info' },
  { id: 'first-aid',  label: 'First Aid',         tone: 'healthy' },
  { id: 'supervisor', label: 'Supervisor',        tone: 'info' },
  { id: 'driver',     label: 'Driver',            tone: 'neutral' },
  { id: 'radio',      label: 'Radio Trained',     tone: 'neutral' },
  { id: 'accredited', label: 'Accreditation Held',tone: 'healthy' },
  { id: 'nights',     label: 'Nights Available',  tone: 'neutral' },
  { id: 'covid',      label: 'Crowd Safety L2',   tone: 'info' },
];

/* ---------------------------------------------------------------- clients */
/* Codes preserved exactly as they appear in the live app, junk included —
   the UI now flags them rather than silently rendering them as valid. */
const CLIENTS_BASE: ClientBase[] = [
  { id: 'c-1',  name: '1st Reaction Security',                  code: '1ST',   email: 'sharonp@1st-reaction.co.uk',            status: 'active', tags: ['sia'] },
  { id: 'c-2',  name: 'Abbots Events',                          code: 'ABB',   email: 'grayson@abbotsevents.co.uk',            status: 'active', tags: [] },
  { id: 'c-3',  name: 'Active Training World',                  code: 'St Albans Half Marathon', email: 'martin@activetrainingworld.co.uk', status: 'active', tags: ['first-aid'] },
  { id: 'c-4',  name: 'AEG Facilities (UK) Limited - OVO Arena',code: 'OVO',   email: '',                                      status: 'active', tags: ['sia', 'radio'] },
  { id: 'c-5',  name: 'AEI Group Limited',                      code: 'AEI',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-6',  name: 'AELTC',                                  code: 'AELTC', email: '',                                      status: 'active', tags: ['accredited', 'supervisor'] },
  { id: 'c-7',  name: 'AFC Rushden & Diamonds',                 code: 'RFC',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-8',  name: 'Against Breast Cancer',                  code: 'ABC',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-9',  name: 'Ageas Bowl Hampshire',                   code: 'YYY',   email: 'simon.jones@ageasbowl.com',             status: 'active', tags: ['radio'] },
  { id: 'c-10', name: 'Agricultural Engineers Association',     code: 'AEA',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-11', name: 'AIB Group',                              code: 'AIB',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-12', name: 'Aintree Racecourse',                     code: 'YYY',   email: 'Elaine.Davis@thejockeyclub.co.uk',      status: 'active', tags: ['accredited', 'sia'] },
  { id: 'c-13', name: 'Albert Evans Events1',                   code: 'AEE',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-14', name: 'Aldborough Boroughbridge',               code: 'ZZZ',   email: 'bbridgeshowsec@gmail.com',              status: 'active', tags: [] },
  { id: 'c-15', name: 'All Land Services Limited',              code: 'ALS',   email: 'info@all-landservices.co.uk',           status: 'active', tags: [] },
  { id: 'c-16', name: 'Alpha ETS',                              code: 'ALP',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-17', name: 'Alresford Show',                         code: 'ALR',   email: 'secretary@alresfordshow.co.uk',         status: 'active', tags: [] },
  { id: 'c-18', name: 'Alwinton Show',                          code: 'ALW',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-19', name: 'Festival Republic Ltd',                  code: 'FRL',   email: 'ops@festivalrepublic.com',              status: 'active', tags: ['accredited', 'radio', 'sia'] },
  { id: 'c-20', name: 'EDG Sports Management',                  code: 'EDG',   email: 'staffing@edgsports.co.uk',              status: 'active', tags: ['accredited'] },
  { id: 'c-21', name: 'Nepalese Community Trust',               code: 'NCT',   email: '',                                      status: 'active', tags: [] },
  { id: 'c-22', name: 'Amber Valley Council',                   code: 'AVC',   email: 'events@ambervalley.gov.uk',             status: 'inactive', tags: [] },
  { id: 'c-23', name: 'Anglian Water Events',                   code: 'ANW',   email: '',                                      status: 'inactive', tags: [] },
  { id: 'c-24', name: 'Ascot Racecourse',                       code: 'ASC',   email: 'staffing@ascot.co.uk',                  status: 'active', tags: ['accredited', 'supervisor'] },
];

/* -------------------------------------------------------------- employees */
/* rating: 0–5, one decimal, out of the last 12 rated shifts.
   status: 'verified' | 'flagged' | 'pending'  (never colour alone in the UI) */
const EMPLOYEES_BASE: EmployeeBase[] = [
  { id: 'e-1',  name: 'Usama Butt',            email: 'usamabutt786512@gmail.com', phone: '073772 11939',  office: 'EP Team South', department: 'Stewarding',        rating: 4.2, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['radio'],                 available: true,  shiftsWorked: 34, initials: 'UB', hue: 262 },
  { id: 'e-2',  name: 'Victoria Abdul-Salam',  email: 'victoriasalam04@gmail.com', phone: '07484622182',   office: 'South East',    department: 'Hospitality',       rating: 4.4, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['first-aid'],              available: true,  shiftsWorked: 28, initials: 'VA', hue: 24  },
  { id: 'e-3',  name: 'Tharun Sai Reddy Alle', email: 'tharunreddy956@gmail.com',  phone: '07721564922',   office: 'London',        department: 'Stewarding',        rating: 3.8, ratedShifts: 9,  status: 'verified', strikes: 1, tags: ['sia', 'radio'],           available: true,  shiftsWorked: 19, initials: 'TA', hue: 200 },
  { id: 'e-4',  name: 'Shannon Darwin Angeles',email: 'shannwinwin@gmail.com',     phone: '+447887150300', office: 'All Offices',   department: 'Bar',               rating: 4.1, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['nights'],                 available: false, shiftsWorked: 41, initials: 'SA', hue: 48  },
  { id: 'e-5',  name: 'Judith Chisom Chigozie',email: 'judithchigozie916@gmail.com',phone:'07344059124',   office: 'North East',    department: 'Stewarding',        rating: 4.6, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['supervisor', 'radio'],    available: true,  shiftsWorked: 52, initials: 'JC', hue: 340 },
  { id: 'e-6',  name: 'Sophie Bailey Davis',   email: 'sophiedavis1282@gmail.com', phone: '+44 7548467847',office: 'Northampton',   department: 'Hospitality',       rating: 2.9, ratedShifts: 11, status: 'flagged',  strikes: 3, tags: [],                         available: true,  shiftsWorked: 16, initials: 'SD', hue: 12  },
  { id: 'e-7',  name: 'Oliver Yakubu Ejigbo',  email: 'ejigbooliver@gmail.com',    phone: '07827682995',   office: 'North East',    department: 'Security',          rating: 4.3, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['sia', 'accredited'],      available: true,  shiftsWorked: 37, initials: 'OE', hue: 300 },
  { id: 'e-8',  name: 'Fleur Ellerton',        email: 'fleur.ellerton@gmail.com',  phone: '+447594435790', office: 'All Offices',   department: 'Control Room',      rating: 4.7, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['supervisor', 'radio', 'covid'], available: true, shiftsWorked: 63, initials: 'FE', hue: 160 },
  { id: 'e-9',  name: 'Omolobake Ashimolowo',  email: 'o.ashimolowo@gmail.com',    phone: '07700 900412',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.0, ratedShifts: 10, status: 'verified', strikes: 0, tags: ['driver'],          available: true,  shiftsWorked: 22, initials: 'OA', hue: 96  },
  { id: 'e-10', name: 'Amber Brown-Cousins',   email: 'amber.bc@gmail.com',        phone: '07700 900187',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.5, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['driver', 'radio'], available: true,  shiftsWorked: 45, initials: 'AB', hue: 210 },
  { id: 'e-11', name: 'Catherine Carrie',      email: 'c.carrie@gmail.com',        phone: '07700 900233',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 3.9, ratedShifts: 12, status: 'verified', strikes: 1, tags: [],                  available: true,  shiftsWorked: 30, initials: 'CC', hue: 320 },
  { id: 'e-12', name: 'Merlin Dickins',        email: 'm.dickins@gmail.com',       phone: '07700 900654',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.1, ratedShifts: 11, status: 'verified', strikes: 0, tags: ['first-aid'],       available: true,  shiftsWorked: 26, initials: 'MD', hue: 180 },
  { id: 'e-13', name: 'Kizzie Doumbia',        email: 'k.doumbia@gmail.com',       phone: '07700 900771',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.8, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['supervisor'],      available: true,  shiftsWorked: 58, initials: 'KD', hue: 40  },
  { id: 'e-14', name: 'Finley Edwards',        email: 'f.edwards@gmail.com',       phone: '07700 900318',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 3.6, ratedShifts: 8,  status: 'verified', strikes: 1, tags: [],                  available: true,  shiftsWorked: 14, initials: 'FE', hue: 275 },
  { id: 'e-15', name: 'George England',        email: 'g.england@gmail.com',       phone: '07700 900925',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.2, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['driver'],          available: true,  shiftsWorked: 39, initials: 'GE', hue: 140 },
  { id: 'e-16', name: 'Emma Fisher',           email: 'e.fisher@gmail.com',        phone: '07700 900540',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.4, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['radio'],           available: true,  shiftsWorked: 47, initials: 'EF', hue: 8   },
  { id: 'e-17', name: 'Charlie Longhorn',      email: 'c.longhorn@gmail.com',      phone: '07700 900166',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 3.7, ratedShifts: 10, status: 'verified', strikes: 2, tags: [],                  available: true,  shiftsWorked: 21, initials: 'CL', hue: 230 },
  { id: 'e-18', name: 'Alice Marriott',        email: 'a.marriott@gmail.com',      phone: '07700 900482',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.9, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['supervisor', 'first-aid'], available: true, shiftsWorked: 71, initials: 'AM', hue: 190 },
  { id: 'e-19', name: 'Rhea Mitra',            email: 'r.mitra@gmail.com',         phone: '07700 900395',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.0, ratedShifts: 12, status: 'verified', strikes: 0, tags: [],                  available: true,  shiftsWorked: 33, initials: 'RM', hue: 55  },
  { id: 'e-20', name: 'Myla Platt',            email: 'm.platt@gmail.com',         phone: '07700 900718',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.3, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['radio'],           available: true,  shiftsWorked: 42, initials: 'MP', hue: 290 },
  { id: 'e-21', name: 'Nadia Rahman',          email: 'n.rahman@gmail.com',        phone: '07700 900604',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.1, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['first-aid'],       available: true,  shiftsWorked: 29, initials: 'NR', hue: 115 },
  { id: 'e-22', name: 'Tomas Sokolov',         email: 't.sokolov@gmail.com',       phone: '07700 900851',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 3.5, ratedShifts: 7,  status: 'pending',  strikes: 0, tags: [],                  available: true,  shiftsWorked: 6,  initials: 'TS', hue: 20  },
  { id: 'e-23', name: 'Grace Whitfield',       email: 'g.whitfield@gmail.com',     phone: '07700 900273',  office: 'EP Event Services', department: 'Traffic & Car Park', rating: 4.6, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['supervisor'],      available: true,  shiftsWorked: 55, initials: 'GW', hue: 168 },
  { id: 'e-24', name: 'Idris Okafor',          email: 'i.okafor@gmail.com',        phone: '07700 900937',  office: 'London',        department: 'Security',          rating: 4.2, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['sia'],                 available: true,  shiftsWorked: 36, initials: 'IO', hue: 250 },
  { id: 'e-25', name: 'Priya Nair',            email: 'p.nair@gmail.com',          phone: '07700 900148',  office: 'London',        department: 'Hospitality',       rating: 4.5, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['first-aid'],           available: true,  shiftsWorked: 44, initials: 'PN', hue: 330 },
  { id: 'e-26', name: 'Daniel Osei',           email: 'd.osei@gmail.com',          phone: '07700 900529',  office: 'Midlands',      department: 'Bar',               rating: 3.4, ratedShifts: 9,  status: 'flagged',  strikes: 2, tags: [],                      available: false, shiftsWorked: 13, initials: 'DO', hue: 76  },
  { id: 'e-27', name: 'Lucy Bennett',          email: 'l.bennett@gmail.com',       phone: '07700 900360',  office: 'South East',    department: 'Control Room',      rating: 4.8, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['supervisor', 'covid'], available: true,  shiftsWorked: 67, initials: 'LB', hue: 205 },
  { id: 'e-28', name: 'Marcus Reid',           email: 'm.reid@gmail.com',          phone: '07700 900782',  office: 'Northampton',   department: 'Stewarding',        rating: 3.2, ratedShifts: 10, status: 'flagged',  strikes: 4, tags: [],                      available: true,  shiftsWorked: 18, initials: 'MR', hue: 358 },
  { id: 'e-29', name: 'Hannah Voss',           email: 'h.voss@gmail.com',          phone: '07700 900413',  office: 'North East',    department: 'Stewarding',        rating: 4.0, ratedShifts: 11, status: 'pending',  strikes: 0, tags: [],                      available: true,  shiftsWorked: 8,  initials: 'HV', hue: 128 },
  { id: 'e-30', name: 'Callum Fraser',         email: 'c.fraser@gmail.com',        phone: '07700 900695',  office: 'Midlands',      department: 'Traffic & Car Park',rating: 4.4, ratedShifts: 12, status: 'verified', strikes: 0, tags: ['driver', 'radio'],     available: true,  shiftsWorked: 40, initials: 'CF', hue: 218 },
];

/* ------------------------------------------------------- assignment maker */
let splitSeq = 130015;

function assign(empId: string, opts: Partial<Assignment> = {}): Assignment {
  return {
    employeeId: empId,
    status: opts.status || 'accepted',              // invited | accepted | declined
    confirmation: opts.confirmation || 'confirmed', // confirmed | awaiting | declined
    checkIn: opts.checkIn || null,                  // null | 'pending' | 'approved'
    note: opts.note || '',
  };
}

type SplitConfig = Partial<Omit<Split, 'role' | 'required'>> &
  Pick<Split, 'role' | 'required'>;

function split(cfg: SplitConfig): Split {
  return {
    id: cfg.id || String(splitSeq++),
    role: cfg.role,
    required: cfg.required,
    pickupTime: cfg.pickupTime ?? null,   // null renders "Not set", never "00:00"
    office: cfg.office || 'EP Event Services',
    uniform: cfg.uniform || 'White Shirt',
    travel: cfg.travel || 'Own transport',
    tags: cfg.tags || [],
    assignments: cfg.assignments || [],
  };
}

/* ------------------------------------------------------------ Wilderness */
/* 15 required, 15 assigned, 14 confirmed -> 14/15. Reconciles all four
   numbers the live app disagreed on. */
const wildernessDay1: Assignment[] = [
  ...['e-9','e-10','e-11','e-12','e-13','e-14','e-15','e-16','e-17','e-18','e-19','e-20','e-21','e-23']
    .map(id => assign(id, { checkIn: 'approved' })),
  assign('e-22', { status: 'accepted', confirmation: 'awaiting', checkIn: null,
                   note: 'Accepted 3 days ago, has not confirmed attendance' }),
];

export const EVENTS: EpEvent[] = [
  {
    id: 'ev-1',
    name: 'Wilderness Festival 19th-28th',
    clientId: 'c-19',
    office: 'EP Event Services',
    start: '2026-07-27T07:00:00',
    end:   '2026-08-03T19:00:00',
    allDay: false,
    requiresAccreditation: true,
    accreditationExportReady: false,
    accreditationBlockedReason: 'Accreditation export unlocks once every assigned worker has an approved check-in. 1 worker is still unconfirmed.',
    locations: [
      { id: 'loc-1', name: 'Main Car Park — Gate C', note: 'Meet at the steward cabin' },
      { id: 'loc-2', name: 'Blue Camp Entrance',     note: '' },
    ],
    additionalInfo: 'Wristbands collected from Production at 06:30. High-vis provided on site. No parking on the access road.',
    leadId: null,
    shifts: [
      {
        id: 'sh-1', label: 'Day 1 — Day Shift', day: 1,
        start: '2026-07-27T07:00:00', end: '2026-07-27T19:00:00',
        splits: [ split({ id: '130015', role: 'Car Park Steward', required: 15, pickupTime: '06:15',
                          uniform: 'White Shirt', travel: 'Office', tags: ['driver'],
                          assignments: wildernessDay1 }) ],
      },
      {
        id: 'sh-2', label: 'Day 1 — Night Shift', day: 1,
        start: '2026-07-27T19:00:00', end: '2026-07-28T07:00:00',
        splits: [ split({ role: 'Response Steward', required: 6, pickupTime: '18:15', tags: ['radio', 'nights'],
                          assignments: ['e-1','e-3','e-7','e-24','e-27','e-8'].map(id => assign(id, { checkIn: 'approved' })) }) ],
      },
      {
        id: 'sh-3', label: 'Day 2 — Day Shift', day: 2,
        start: '2026-07-28T07:00:00', end: '2026-07-28T19:00:00',
        splits: [
          split({ role: 'Car Park Steward', required: 12, pickupTime: '06:15', tags: ['driver'],
                  assignments: ['e-9','e-10','e-11','e-13','e-15','e-16','e-18','e-19','e-20','e-21']
                    .map(id => assign(id, { checkIn: 'approved' })) }),
          split({ role: 'Gate Supervisor', required: 2, pickupTime: '06:00', tags: ['supervisor', 'radio'],
                  assignments: [assign('e-23', { checkIn: 'approved' })] }),
        ],
      },
      {
        id: 'sh-4', label: 'Day 3 — Day Shift', day: 3,
        start: '2026-07-29T07:00:00', end: '2026-07-29T19:00:00',
        splits: [ split({ role: 'Event Steward', required: 20, pickupTime: '06:30',
                          assignments: ['e-9','e-12','e-14','e-16','e-17','e-19','e-25','e-29']
                            .map(id => assign(id, { checkIn: 'pending' })) }) ],
      },
      {
        id: 'sh-5', label: 'Day 4 — Day Shift', day: 4,
        start: '2026-07-30T07:00:00', end: '2026-07-30T19:00:00',
        splits: [ split({ role: 'Event Steward', required: 20, pickupTime: '06:30',
                          assignments: ['e-10','e-13','e-15','e-18','e-20']
                            .map(id => assign(id, { confirmation: 'awaiting' })) }) ],
      },
      {
        id: 'sh-6', label: 'Day 5 — Day Shift', day: 5,
        start: '2026-07-31T07:00:00', end: '2026-07-31T19:00:00',
        splits: [
          split({ role: 'Event Steward',   required: 18, pickupTime: '06:30',
                  assignments: ['e-9','e-11','e-16','e-21'].map(id => assign(id)) }),
          split({ role: 'Pit Steward',     required: 8,  pickupTime: '10:00', tags: ['first-aid'],
                  assignments: [assign('e-12'), assign('e-25')] }),
        ],
      },
      {
        id: 'sh-7', label: 'Day 6 — Day Shift', day: 6,
        start: '2026-08-01T07:00:00', end: '2026-08-01T19:00:00',
        splits: [ split({ role: 'Event Steward', required: 18, pickupTime: '06:30', assignments: [] }) ],
      },
      {
        id: 'sh-8', label: 'Day 7 — Breakdown', day: 7,
        start: '2026-08-02T08:00:00', end: '2026-08-02T18:00:00',
        splits: [ split({ role: 'Event Steward', required: 10, pickupTime: '07:30', assignments: [] }) ],
      },
    ],
  },

  {
    id: 'ev-2',
    name: 'Reggaeland 1st-2nd',
    clientId: 'c-19',
    office: 'London',
    start: '2026-07-30T08:00:00',
    end:   '2026-08-04T22:00:00',
    allDay: false,
    requiresAccreditation: true,
    accreditationExportReady: false,
    accreditationBlockedReason: 'No workers assigned yet — nothing to export.',
    locations: [{ id: 'loc-3', name: 'Crystal Palace Park — North Gate', note: '' }],
    additionalInfo: 'Largest booking of the season. Client requires 100% SIA coverage on all security splits.',
    leadId: null,
    shifts: [
      { id: 'sh-r1', label: 'Day 1 — Build', day: 1, start: '2026-07-30T08:00:00', end: '2026-07-30T20:00:00',
        splits: [ split({ role: 'Event Steward', required: 60, pickupTime: '07:00', assignments: [] }),
                  split({ role: 'Gate Supervisor', required: 8, pickupTime: '06:45', tags: ['supervisor'], assignments: [] }) ] },
      { id: 'sh-r2', label: 'Day 2 — Show Day', day: 2, start: '2026-07-31T08:00:00', end: '2026-07-31T23:30:00',
        splits: [ split({ role: 'Event Steward', required: 120, pickupTime: '07:00', assignments: [] }),
                  split({ role: 'Response Steward', required: 24, pickupTime: '07:00', tags: ['sia'], assignments: [] }) ] },
      { id: 'sh-r3', label: 'Day 3 — Show Day', day: 3, start: '2026-08-01T08:00:00', end: '2026-08-01T23:30:00',
        splits: [ split({ role: 'Event Steward', required: 120, pickupTime: '07:00', assignments: [] }),
                  split({ role: 'Bar Staff', required: 40, pickupTime: '09:00', uniform: 'Black Polo', assignments: [] }) ] },
      { id: 'sh-r4', label: 'Day 4 — Breakdown', day: 4, start: '2026-08-02T09:00:00', end: '2026-08-02T19:00:00',
        splits: [ split({ role: 'Event Steward', required: 44, pickupTime: '08:15', assignments: [] }) ] },
    ],
  },

  {
    id: 'ev-3',
    name: 'Taxi Marshal 31st-1st',
    clientId: 'c-4',
    office: 'London',
    start: '2026-07-31T18:00:00',
    end:   '2026-08-01T03:00:00',
    allDay: false,
    requiresAccreditation: false,
    accreditationExportReady: false,
    accreditationBlockedReason: 'This event does not require accreditation.',
    locations: [{ id: 'loc-4', name: 'OVO Arena Wembley — Taxi Rank', note: '' }],
    additionalInfo: 'Late finish. Taxis home provided for anyone finishing after 01:00.',
    leadId: null,
    shifts: [
      { id: 'sh-t1', label: 'Night Shift', day: 1, start: '2026-07-31T18:00:00', end: '2026-08-01T03:00:00',
        splits: [ split({ role: 'Taxi Marshal', required: 4, pickupTime: '17:15', tags: ['radio', 'nights'], assignments: [] }) ] },
    ],
  },

  {
    id: 'ev-4',
    name: 'EDG - 100 Phoenix vs Welsh Fire 01.08',
    clientId: 'c-20',
    office: 'South East',
    start: '2026-08-01T12:00:00',
    end:   '2026-08-01T23:00:00',
    allDay: false,
    requiresAccreditation: true,
    accreditationExportReady: false,
    accreditationBlockedReason: 'No workers assigned yet — nothing to export.',
    locations: [{ id: 'loc-5', name: 'Ageas Bowl — Main Concourse', note: '' }],
    additionalInfo: 'Match day. Briefing in the Control Room 90 minutes before gates.',
    leadId: null,
    shifts: [
      { id: 'sh-e1', label: 'Match Day', day: 1, start: '2026-08-01T12:00:00', end: '2026-08-01T23:00:00',
        splits: [ split({ role: 'Turnstile Operator', required: 12, pickupTime: '11:00', assignments: [] }),
                  split({ role: 'Event Steward', required: 10, pickupTime: '11:00', assignments: [] }),
                  split({ role: 'Hospitality Host', required: 4, pickupTime: '10:30', uniform: 'Black Suit', assignments: [] }) ] },
    ],
  },

  {
    id: 'ev-5',
    name: 'Nepalese 01.08',
    clientId: 'c-21',
    office: 'EP Team South',
    start: '2026-08-01T10:00:00',
    end:   '2026-08-01T20:00:00',
    allDay: false,
    requiresAccreditation: false,
    accreditationExportReady: false,
    accreditationBlockedReason: 'This event does not require accreditation.',
    locations: [{ id: 'loc-6', name: 'Aldershot Community Ground', note: '' }],
    additionalInfo: '',
    leadId: null,
    shifts: [
      { id: 'sh-n1', label: 'Day Shift', day: 1, start: '2026-08-01T10:00:00', end: '2026-08-01T20:00:00',
        splits: [ split({ role: 'Event Steward', required: 15, pickupTime: '09:00', assignments: [] }) ] },
    ],
  },

  {
    id: 'ev-6',
    name: 'EDG - 100 Phoenix vs Sunrisers Leeds 07.08',
    clientId: 'c-20',
    office: 'South East',
    start: '2026-08-07T12:00:00',
    end:   '2026-08-07T23:00:00',
    allDay: false,
    requiresAccreditation: true,
    accreditationExportReady: false,
    accreditationBlockedReason: 'No workers assigned yet — nothing to export.',
    locations: [{ id: 'loc-7', name: 'Ageas Bowl — Main Concourse', note: '' }],
    additionalInfo: '',
    leadId: null,
    shifts: [
      { id: 'sh-s1', label: 'Match Day', day: 1, start: '2026-08-07T12:00:00', end: '2026-08-07T23:00:00',
        splits: [ split({ role: 'Turnstile Operator', required: 12, pickupTime: '11:00',
                          assignments: ['e-1','e-3'].map(id => assign(id, { confirmation: 'awaiting' })) }),
                  split({ role: 'Event Steward', required: 14, pickupTime: '11:00', assignments: [] }) ] },
    ],
  },

  {
    id: 'ev-7',
    name: 'Aintree Race Day 08.08',
    clientId: 'c-12',
    office: 'North East',
    start: '2026-08-08T09:00:00',
    end:   '2026-08-08T21:00:00',
    allDay: false,
    requiresAccreditation: true,
    accreditationExportReady: true,
    accreditationBlockedReason: '',
    locations: [{ id: 'loc-8', name: 'Aintree Racecourse — Steeplechase Enclosure', note: '' }],
    additionalInfo: '',
    leadId: null,
    shifts: [
      { id: 'sh-a1', label: 'Race Day', day: 1, start: '2026-08-08T09:00:00', end: '2026-08-08T21:00:00',
        splits: [ split({ role: 'Event Steward', required: 28, pickupTime: '08:00',
                          assignments: ['e-1','e-2','e-3','e-5','e-7','e-8','e-24','e-25','e-27','e-29','e-30','e-9','e-10','e-11','e-13','e-15','e-16','e-18','e-19','e-20','e-21','e-23','e-12','e-14','e-17','e-28','e-22','e-26']
                            .map(id => assign(id, { checkIn: 'approved' })) }),
                  split({ role: 'Hospitality Host', required: 4, pickupTime: '08:00', uniform: 'Black Suit',
                          assignments: ['e-2','e-25','e-6','e-4'].map(id => assign(id, { checkIn: 'approved' })) }) ] },
    ],
  },

  {
    id: 'ev-8',
    name: 'St Albans Half Marathon',
    clientId: 'c-3',
    office: 'EP Team South',
    start: '2026-08-09T06:00:00',
    end:   '2026-08-09T15:00:00',
    allDay: false,
    requiresAccreditation: false,
    accreditationExportReady: false,
    accreditationBlockedReason: 'This event does not require accreditation.',
    locations: [{ id: 'loc-9', name: 'Verulamium Park — Start Line', note: '' }],
    additionalInfo: '',
    leadId: null,
    shifts: [
      { id: 'sh-h1', label: 'Race Morning', day: 1, start: '2026-08-09T06:00:00', end: '2026-08-09T15:00:00',
        splits: [ split({ role: 'Event Steward', required: 22, pickupTime: '05:15', tags: ['first-aid'],
                          assignments: ['e-2','e-5','e-8','e-25','e-27','e-30','e-29','e-21','e-19','e-16']
                            .map(id => assign(id)) }) ] },
    ],
  },

  {
    id: 'ev-9',
    name: 'Alresford Show',
    clientId: 'c-17',
    office: 'EP Team South',
    start: '2026-08-15T07:00:00',
    end:   '2026-08-15T19:00:00',
    allDay: true,
    requiresAccreditation: false,
    accreditationExportReady: false,
    accreditationBlockedReason: 'This event does not require accreditation.',
    locations: [],
    additionalInfo: '',
    leadId: null,
    shifts: [
      { id: 'sh-al1', label: 'Show Day', day: 1, start: '2026-08-15T07:00:00', end: '2026-08-15T19:00:00',
        splits: [ split({ role: 'Event Steward', required: 16, pickupTime: null,
                          assignments: ['e-1','e-2','e-3','e-4','e-5','e-7','e-8','e-24','e-25','e-27','e-29','e-30','e-9','e-10','e-11','e-13']
                            .map(id => assign(id)) }) ] },
    ],
  },
];

/* ----------------------------------------------------------- check-ins */
/* Rows awaiting an approval decision. Sourced from splits where
   assignment.checkIn === 'pending'. */
export const CHECK_INS: CheckIn[] = [
  { id: 'ci-1', employeeId: 'e-9',  eventId: 'ev-1', shiftId: 'sh-4', role: 'Event Steward',
    scheduledIn: '2026-07-29T07:00:00', scheduledOut: '2026-07-29T19:00:00',
    actualIn: '2026-07-29T07:04:00',  actualOut: '2026-07-29T19:12:00', flag: null },
  { id: 'ci-2', employeeId: 'e-12', eventId: 'ev-1', shiftId: 'sh-4', role: 'Event Steward',
    scheduledIn: '2026-07-29T07:00:00', scheduledOut: '2026-07-29T19:00:00',
    actualIn: '2026-07-29T07:52:00',  actualOut: '2026-07-29T19:00:00', flag: 'Late in by 52 min' },
  { id: 'ci-3', employeeId: 'e-14', eventId: 'ev-1', shiftId: 'sh-4', role: 'Event Steward',
    scheduledIn: '2026-07-29T07:00:00', scheduledOut: '2026-07-29T19:00:00',
    actualIn: '2026-07-29T06:58:00',  actualOut: null, flag: 'No clock-out recorded' },
  { id: 'ci-4', employeeId: 'e-16', eventId: 'ev-1', shiftId: 'sh-4', role: 'Event Steward',
    scheduledIn: '2026-07-29T07:00:00', scheduledOut: '2026-07-29T19:00:00',
    actualIn: '2026-07-29T07:01:00',  actualOut: '2026-07-29T21:40:00', flag: 'Overtime 2h 40m' },
  { id: 'ci-5', employeeId: 'e-17', eventId: 'ev-1', shiftId: 'sh-4', role: 'Event Steward',
    scheduledIn: '2026-07-29T07:00:00', scheduledOut: '2026-07-29T19:00:00',
    actualIn: '2026-07-29T07:00:00',  actualOut: '2026-07-29T18:58:00', flag: null },
  { id: 'ci-6', employeeId: 'e-19', eventId: 'ev-1', shiftId: 'sh-4', role: 'Event Steward',
    scheduledIn: '2026-07-29T07:00:00', scheduledOut: '2026-07-29T19:00:00',
    actualIn: '2026-07-29T07:06:00',  actualOut: '2026-07-29T19:02:00', flag: null },
  { id: 'ci-7', employeeId: 'e-25', eventId: 'ev-1', shiftId: 'sh-4', role: 'Event Steward',
    scheduledIn: '2026-07-29T07:00:00', scheduledOut: '2026-07-29T19:00:00',
    actualIn: null, actualOut: null, flag: 'No show — no clock-in recorded' },
  { id: 'ci-8', employeeId: 'e-29', eventId: 'ev-1', shiftId: 'sh-4', role: 'Event Steward',
    scheduledIn: '2026-07-29T07:00:00', scheduledOut: '2026-07-29T19:00:00',
    actualIn: '2026-07-29T07:03:00',  actualOut: '2026-07-29T19:05:00', flag: null },
];

/* ----------------------------------------------------------- attendance */
/* Settled history — the screen that used to 404. */
export const ATTENDANCE: AttendanceRow[] = [
  { id: 'at-1',  employeeId: 'e-9',  eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-27',
    scheduled: '07:00–19:00', actual: '06:58–19:04', hours: 12.1, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-2',  employeeId: 'e-10', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-27',
    scheduled: '07:00–19:00', actual: '07:02–19:00', hours: 12.0, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-3',  employeeId: 'e-11', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-27',
    scheduled: '07:00–19:00', actual: '07:41–19:00', hours: 11.3, outcome: 'late',     approvedBy: 'Jake Wright' },
  { id: 'at-4',  employeeId: 'e-12', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-27',
    scheduled: '07:00–19:00', actual: '07:00–19:00', hours: 12.0, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-5',  employeeId: 'e-13', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-27',
    scheduled: '07:00–19:00', actual: '06:55–19:10', hours: 12.3, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-6',  employeeId: 'e-28', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-27',
    scheduled: '07:00–19:00', actual: '—',           hours: 0,    outcome: 'no-show',  approvedBy: 'Jake Wright' },
  { id: 'at-7',  employeeId: 'e-14', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-28',
    scheduled: '07:00–19:00', actual: '07:00–21:20', hours: 14.3, outcome: 'overtime', approvedBy: 'Jake Wright' },
  { id: 'at-8',  employeeId: 'e-15', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-28',
    scheduled: '07:00–19:00', actual: '07:04–19:00', hours: 11.9, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-9',  employeeId: 'e-16', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-28',
    scheduled: '07:00–19:00', actual: '07:00–19:00', hours: 12.0, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-10', employeeId: 'e-6',  eventId: 'ev-1', role: 'Hospitality Host',date: '2026-07-28',
    scheduled: '10:00–20:00', actual: '—',           hours: 0,    outcome: 'cancelled',approvedBy: 'Jake Wright' },
  { id: 'at-11', employeeId: 'e-18', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-28',
    scheduled: '07:00–19:00', actual: '06:52–19:06', hours: 12.2, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-12', employeeId: 'e-1',  eventId: 'ev-1', role: 'Response Steward', date: '2026-07-27',
    scheduled: '19:00–07:00', actual: '18:55–07:05', hours: 12.2, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-13', employeeId: 'e-3',  eventId: 'ev-1', role: 'Response Steward', date: '2026-07-27',
    scheduled: '19:00–07:00', actual: '19:35–07:00', hours: 11.4, outcome: 'late',     approvedBy: 'Jake Wright' },
  { id: 'at-14', employeeId: 'e-7',  eventId: 'ev-1', role: 'Response Steward', date: '2026-07-27',
    scheduled: '19:00–07:00', actual: '19:00–07:00', hours: 12.0, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-15', employeeId: 'e-23', eventId: 'ev-1', role: 'Gate Supervisor',  date: '2026-07-28',
    scheduled: '06:45–19:00', actual: '06:40–19:15', hours: 12.6, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-16', employeeId: 'e-26', eventId: 'ev-7', role: 'Event Steward',    date: '2026-07-25',
    scheduled: '09:00–21:00', actual: '—',           hours: 0,    outcome: 'no-show',  approvedBy: 'Jake Wright' },
  { id: 'at-17', employeeId: 'e-20', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-28',
    scheduled: '07:00–19:00', actual: '07:00–19:00', hours: 12.0, outcome: 'worked',   approvedBy: 'Jake Wright' },
  { id: 'at-18', employeeId: 'e-21', eventId: 'ev-1', role: 'Car Park Steward', date: '2026-07-28',
    scheduled: '07:00–19:00', actual: '07:08–19:00', hours: 11.9, outcome: 'worked',   approvedBy: 'Jake Wright' },
];

/* --------------------------------------------------------- notifications */
export const NOTIFICATIONS: AppNotification[] = [
  { id: 'n-1', type: 'staffing', severity: 'critical', unread: true,
    title: 'Reggaeland 1st-2nd has 416 unfilled roles',
    body: 'Show day is tomorrow and no workers are assigned to any split.',
    at: '2026-07-31T08:42:00', link: '/events/ev-2' },
  { id: 'n-2', type: 'checkin', severity: 'atRisk', unread: true,
    title: '8 check-ins waiting for approval',
    body: 'Wilderness Festival Day 3 — includes 1 no-show and 1 missing clock-out.',
    at: '2026-07-31T07:15:00', link: '/check-in-approvals' },
  { id: 'n-3', type: 'confirmation', severity: 'atRisk', unread: true,
    title: 'Tomas Sokolov has not confirmed',
    body: 'Wilderness Festival Day 1 — Day Shift. Accepted 3 days ago, still awaiting confirmation.',
    at: '2026-07-30T16:03:00', link: '/events/ev-1' },
  { id: 'n-4', type: 'staff', severity: 'critical', unread: false,
    title: 'Marcus Reid reached 4 strikes',
    body: 'Automatically flagged. Review before assigning to further shifts.',
    at: '2026-07-30T11:20:00', link: '/staff/e-28' },
  { id: 'n-5', type: 'staffing', severity: 'atRisk', unread: false,
    title: 'Taxi Marshal 31st-1st starts today with 0 of 4 filled',
    body: 'Night shift, 18:00 start. Callout has not been sent.',
    at: '2026-07-30T09:00:00', link: '/events/ev-3' },
  { id: 'n-6', type: 'confirmation', severity: 'healthy', unread: false,
    title: '28 workers confirmed for Aintree Race Day 08.08',
    body: 'Event is fully covered.',
    at: '2026-07-29T14:47:00', link: '/events/ev-7' },
  { id: 'n-7', type: 'checkin', severity: 'healthy', unread: false,
    title: 'Wilderness Day 2 check-ins approved',
    body: '11 timesheets approved and released for billing.',
    at: '2026-07-29T09:12:00', link: '/attendance' },
  { id: 'n-8', type: 'staff', severity: 'info', unread: false,
    title: 'Hannah Voss completed onboarding',
    body: 'Awaiting document verification before first assignment.',
    at: '2026-07-28T13:30:00', link: '/staff/e-29' },
];

/* ==========================================================================
   REFERENCE DATA
   ========================================================================== */

/* ------------------------------------ people who own things (briefing §5) */
export const MANAGERS: Manager[] = [
  { id: 'm-colin',  name: 'Colin Harding', role: 'OPS Manager',            initials: 'CH', hue: 214, owns: 'WOFs, master calendar, job documents' },
  { id: 'm-gracie', name: 'Gracie Mullen', role: 'WOF Administrator',      initials: 'GM', hue: 330, owns: 'WOF data entry, staff admin sheets, payroll input' },
  { id: 'm-pete',   name: 'Pete Sandow',   role: 'Staffing & Warehouse',   initials: 'PS', hue: 150, owns: 'Staffing, picking and packing' },
  { id: 'm-jenny',  name: 'Jenny Watt',    role: 'Payroll',                initials: 'JW', hue: 40,  owns: 'Full payroll workflow' },
  { id: 'm-jake',   name: 'Jake Wright',   role: 'Staffing Manager',       initials: 'JW', hue: 262, owns: 'Shift allocation and callouts' },
  { id: 'm-fd',     name: 'Finance Director', role: 'Finance (starting)',  initials: 'FD', hue: 8,   owns: 'Invoicing, cash flow, payroll sign-off' },
];

/* ------------------------------------------------------ the permanent team */
/*
   The People Planner workbook's 77 columns, as records.

   NINE OF THE 77 ARE NOT PEOPLE, and are deliberately absent here:

     · "Robbie the Robot" and "Rodney the Robot" are plant. They belong in the
       resource register with the vans and the telehandlers, not in a staff
       list where they would inflate every headcount the planner reports.
     · "Additional Cover" is a free-text list of freelancer names typed into a
       single cell. It is a note about who was brought in, not a person.
     · "Duty Phone Cover" is a rota, not a human — it becomes the `standby` day
       state, which is what it always meant.

   That leaves 68 real people across twelve bands. The two "Traffic Management"
   header blocks in the workbook are one band split across the sheet for column
   width; they are merged.

   `managerId` carries the six `MANAGERS` records through, so every existing
   ownership link on a schedule or a WOF keeps resolving while the planner gets
   a register with enough people in it to be worth looking at.
*/

const BAND_HUE: Record<TeamBand, number> = {
  'Operations': 214,
  'Special Events': 288,
  'Traffic Management': 32,
  'Greenfield': 140,
  'Stadia and Venues': 200,
  'Wembley': 340,
  'Logistics': 96,
  'Central': 250,
  'Finance and Payroll': 40,
  'Training': 172,
  'Staffing and Compliance': 8,
  'Technology': 264,
};

/** Initials from a name, coping with the hyphenated and the apostrophed. */
function initialsOf(name: string): string {
  const parts = name.split(/[\s-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

const email = (name: string): string =>
  `${name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z]+/g, '.')}@epteam.co.uk`;

/** [name, role, default day, managerId] */
type TeamSeed = [string, string, DayStateKind, string?];

const TEAM_SEED: Record<TeamBand, TeamSeed[]> = {
  'Operations': [
    ['Colin Rhodes', 'Operations Director', 'head-office', 'm-colin'],
    ['Gracie Howley-Bumford', 'WOF Administrator', 'head-office', 'm-gracie'],
    ['Isabelle Rouani-North', 'Operations Coordinator', 'head-office'],
  ],
  'Special Events': [
    ['Lee Storey', 'Special Events Manager', 'head-office'],
    ['Caleb Howley', 'Special Events Manager', 'head-office'],
    ['Rhys McDonald', 'Special Events Coordinator', 'head-office'],
  ],
  'Traffic Management': [
    ["Martin O'Connor", 'Traffic Management Lead', 'head-office'],
    ['Scott Bennett', 'Traffic Management Manager', 'head-office'],
    ['Niall Ward', 'Traffic Management Manager', 'head-office'],
    ['Amy Parsons', 'TM Operative', 'warehouse'],
    ['Anthony Hall', 'TM Operative', 'warehouse'],
    ['Archie Howley-Bumford', 'TM Operative', 'warehouse'],
    ['David Cooper', 'TM Operative', 'warehouse'],
    ['Habib Rouami', 'TM Operative', 'warehouse'],
    ['Jack Fortnam', 'TM Operative', 'warehouse'],
    ['Jon Vowles', 'TM Operative', 'warehouse'],
    ['Mason Standley', 'TM Operative', 'warehouse'],
    ['Paul Gill', 'TM Operative', 'warehouse'],
    ['Tom Lovell', 'TM Operative', 'warehouse'],
  ],
  'Greenfield': [
    ['Craig Barrett', 'Greenfield Manager', 'head-office'],
    ['Colin Bell', 'Greenfield Manager', 'head-office'],
    ['Ella Hay', 'Greenfield Coordinator', 'head-office'],
    ['Kai Campbell', 'Greenfield Coordinator', 'head-office'],
    ['Ivana Bolaric', 'Greenfield Coordinator', 'head-office'],
  ],
  'Stadia and Venues': [
    ['Jake Paris', 'Stadia Manager', 'head-office', 'm-jake'],
    ['Lewis Salter', 'Venues Manager', 'head-office'],
    ['Holly Brown', 'Venues Coordinator', 'head-office'],
  ],
  'Wembley': [
    ['Helen Scorer', 'Wembley Account Manager', 'head-office'],
    ['Dipesh Damani', 'Wembley Supervisor', 'back-office'],
    ['Max Lake-Grange', 'Wembley Supervisor', 'back-office'],
    ["James O'Connor", 'Wembley Supervisor', 'back-office'],
  ],
  'Logistics': [
    ['James Merrey', 'Logistics Manager', 'warehouse', 'm-pete'],
    ['Andy Bumford', 'Warehouse Supervisor', 'warehouse'],
    ['Hayden Feakin', 'Warehouse Operative', 'warehouse'],
    ['Mark Allen', 'Driver', 'warehouse'],
    ['Muhammad Umair', 'Driver', 'warehouse'],
    ['Andrei Chizerev', 'Driver', 'warehouse'],
    ['Richard Wanjiku', 'Driver', 'warehouse'],
    ['Mark Darby', 'Warehouse Operative', 'warehouse'],
    ['Nathan George', 'Warehouse Operative', 'warehouse'],
    ['Frankie Cummings', 'Warehouse Operative', 'warehouse'],
  ],
  'Central': [
    ['Simon Legg', 'Managing Director', 'head-office'],
    ['Scott Metcalfe', 'Commercial Director', 'head-office'],
    ['Liam MacDonald', 'Business Development', 'head-office'],
    ['Kaz Beare', 'Executive Assistant', 'head-office'],
  ],
  'Finance and Payroll': [
    ['Emma Linnell', 'Finance Manager', 'head-office', 'm-fd'],
    ['Antony Ashby', 'Management Accountant', 'head-office'],
    ['Sophie Davis', 'Accounts Assistant', 'head-office'],
    ['Jenny Watt', 'Payroll Manager', 'head-office', 'm-jenny'],
    ['Zain Memon', 'Payroll Assistant', 'head-office'],
  ],
  'Training': [
    ['Sam Darlington', 'Training Manager', 'head-office'],
    ['Jennifer Ashby', 'Training Coordinator', 'head-office'],
    ['Andrew Schein-Illes', 'Training Officer', 'head-office'],
  ],
  'Staffing and Compliance': [
    ['Peter Caven', 'Head of Staffing', 'head-office'],
    ['Sharon Smith', 'Compliance Manager', 'head-office'],
    ['Hayley Metcalfe', 'Staffing Coordinator', 'head-office'],
    ['Sophie Weatherby', 'Staffing Coordinator', 'head-office'],
    ['Emma Woolford', 'Compliance Officer', 'head-office'],
    ['Heather Ryan', 'Staffing Administrator', 'head-office'],
  ],
  'Technology': [
    ['Alex Mason', 'Head of Technology', 'head-office'],
    ['Becky Bumford', 'Systems Analyst', 'head-office'],
    ['Molly Howley-Bumford', 'Account Manager', 'head-office'],
    ["O'Neil McLean", 'Support Technician', 'head-office'],
    ['Emily Codd', 'Data Analyst', 'wfh'],
    ['Ellise Blundell', 'Support Technician', 'head-office'],
    ['Marcin Sliwa', 'Field Technician', 'warehouse'],
    ['Natalie Hart', 'Account Manager', 'head-office'],
    ['Natalie Mitchell', 'Account Manager', 'head-office'],
  ],
};

export const TEAM: TeamMember[] = (
  Object.keys(TEAM_SEED) as TeamBand[]
).flatMap((band) =>
  TEAM_SEED[band].map(([name, role, defaultDay, managerId], i) => ({
    id: `tm-${band.toLowerCase().replace(/[^a-z]+/g, '-')}-${i + 1}`,
    name,
    band,
    role,
    email: email(name),
    initials: initialsOf(name),
    // Nudged per row so two people in the same band are not the same colour.
    hue: (BAND_HUE[band] + i * 11) % 360,
    defaultDay,
    managerId: managerId ?? null,
    active: true,
  })),
);

export const TEAM_BANDS: TeamBand[] = Object.keys(TEAM_SEED) as TeamBand[];

export const teamMember = (id: string): TeamMember | undefined =>
  TEAM.find((t) => t.id === id);

/** The team record for a `MANAGERS` id, for the ownership links. */
export const teamForManager = (managerId: string): TeamMember | undefined =>
  TEAM.find((t) => t.managerId === managerId);

/* ------------------------------------------------------------- day entries */
/*
   Generated rather than written out, and generated from `NOW` rather than from
   `SEED_ANCHOR`.

   Every other seed array here is a literal that `shiftDeep()` moves forward at
   the bottom of this file. This one is not, for two reasons. A month of day
   states for 68 people is several thousand rows, which is not a thing to hand
   author. And the shift exists to put fixed dates near today — computing from
   `NOW` in the first place arrives at the same place directly, in the same
   frame of reference as the records a user creates, so `DAY_ENTRIES` is
   deliberately absent from the `shiftDeep` list at the end of this file.

   Content is keyed on a hash of person and date, so the grid is identical on
   every reload and across every machine, without storing anything. Change the
   window and the days keep their states; only the edges move.

   AN ENTRY IS A DEPARTURE FROM THE NORM, NOT A RECORD OF EVERY DAY.
   A weekday with no entry means the person is on their `defaultDay` — head
   office, warehouse — or on an event. Writing those out would double the size
   of the store to say nothing, and would make an untouched day indistinguishable
   from one somebody has actually looked at.
*/

/** FNV-1a. Small, fast, and stable across engines — which is the whole point. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const addDays = (d: Date, n: number): Date => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};

/** Late-August bank holiday, Christmas and New Year for the years in view. */
function bankHolidays(from: Date, to: Date): Set<string> {
  const out = new Set<string>();
  for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
    const aug = new Date(y, 7, 31);
    while (aug.getDay() !== 1) aug.setDate(aug.getDate() - 1);
    out.add(iso(aug));
    out.add(iso(new Date(y, 11, 25)));
    out.add(iso(new Date(y, 11, 26)));
    out.add(iso(new Date(y, 0, 1)));
  }
  return out;
}

function buildDayEntries(): DayEntry[] {
  const out: DayEntry[] = [];
  const start = addDays(NOW, -28);
  const end = addDays(NOW, 84);
  const holidays = bankHolidays(start, end);
  const approver = 'tm-staffing-and-compliance-1'; // Peter Caven, Head of Staffing

  TEAM.forEach((person) => {
    // One booked week off each, placed deterministically inside the window.
    const leaveStart = hash(`${person.id}:leave`) % 100;

    for (let i = 0; i <= 112; i++) {
      const day = addDays(start, i);
      const date = iso(day);
      const dow = day.getDay();
      const roll = hash(`${person.id}:${date}`) % 100;

      let kind: DayStateKind | null = null;
      let note = '';
      let hours: string | null = null;

      if (holidays.has(date)) {
        kind = 'bank-holiday';
      } else if (i >= leaveStart && i < leaveStart + 5 && dow !== 0 && dow !== 6) {
        kind = 'annual-leave';
      } else if (dow === 0 || dow === 6) {
        // Most of the team is off at weekends; the rest are on an event, which
        // is a fact the events module owns, so nothing is written for them.
        if (roll < 82) kind = 'off';
      } else if (roll < 3) {
        kind = 'toil';
      } else if (roll < 5) {
        kind = 'sick';
        note = 'Called in';
      } else if (roll < 9) {
        kind = 'wfh';
      } else if (roll < 13 && person.defaultDay === 'warehouse') {
        kind = 'warehouse';
        hours = '08:00-17:00';
        note = 'Depot';
      }

      if (!kind) continue;

      // Leave and TOIL are the two that someone has to say yes to. Everything
      // else is a statement of fact, so it carries no approver rather than a
      // fabricated one.
      const needsApproval = kind === 'annual-leave' || kind === 'toil';
      // A handful of future requests are left outstanding, so the approval
      // queue opens with something in it rather than an empty state that looks
      // like a broken screen.
      const pending = needsApproval && i > 84 && roll % 3 === 0;

      out.push({
        id: `de-${person.id}-${date}`,
        personId: person.id,
        date,
        kind,
        note,
        hours,
        status: pending ? 'requested' : 'approved',
        approvedBy: needsApproval && !pending ? approver : null,
        at: `${iso(addDays(day, -14))}T09:00:00`,
      });
    }
  });

  /*
     Casual workers get entries too, and sparser ones.

     They are not on a rota, so there is no default day to depart from and no
     office to be at — the only thing they tell us is which days they cannot
     work. That is the same fact as an ops manager's annual leave, which is why
     it is the same record type against the same person key, and it is what
     makes `assign()` able to refuse a booking instead of quietly double-booking
     somebody who is already on holiday.
  */
  EMPLOYEES.forEach((emp) => {
    for (let i = 0; i <= 112; i++) {
      const day = addDays(start, i);
      const date = iso(day);
      const roll = hash(`${emp.id}:${date}`) % 100;

      let kind: DayStateKind | null = null;
      if (roll < 7) kind = 'off';
      else if (roll < 9) kind = 'sick';
      if (!kind) continue;

      out.push({
        id: `de-${emp.id}-${date}`,
        personId: emp.id,
        date,
        kind,
        note: kind === 'off' ? 'Unavailable' : 'Called in',
        hours: null,
        status: 'approved',
        approvedBy: null,
        at: `${iso(addDays(day, -7))}T09:00:00`,
      });
    }
  });

  return out;
}

/* `DAY_ENTRIES` is built at the very bottom of this file, not here.
   `buildDayEntries()` reads `EMPLOYEES`, which is assembled by `.map()` from
   `EMPLOYEES_BASE` several hundred lines below this point. Calling it here
   yields an empty casual-worker set — silently, because the array is merely
   absent rather than wrong, so nothing throws and nothing looks broken until
   somebody wonders why `assign()` never refuses anyone. */

/* --------------------------------------------------- 1. table of charges */
/*   kind   : 'staff' | 'kit' | 'service'
     unit   : what one unit means — hour | day | each
     cost   : what it costs EP to supply one unit
     charge : what the client is charged for one unit
     tiers  : volume breaks, applied on line quantity, highest match wins
     history: superseded versions, newest first                              */
export const CHARGES: Charge[] = [
  /* ---- Staff charge-out (per person per hour) ------------------------- */
  { id: 'ch-st-event',    kind: 'staff', code: 'ST-EVT', name: 'Event Steward',        unit: 'hour', role: 'Event Steward',
    cost: 12.60, charge: 18.50, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 50, charge: 17.75 }, { minQty: 100, charge: 17.00 }],
    history: [{ effectiveFrom: '2025-04-01', cost: 11.90, charge: 17.40, tiers: [{ minQty: 50, charge: 16.80 }] }] },

  { id: 'ch-st-carpark',  kind: 'staff', code: 'ST-CPK', name: 'Car Park Steward',     unit: 'hour', role: 'Car Park Steward',
    cost: 12.60, charge: 18.50, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 50, charge: 17.75 }],
    history: [{ effectiveFrom: '2025-04-01', cost: 11.90, charge: 17.40, tiers: [] }] },

  { id: 'ch-st-response', kind: 'staff', code: 'ST-RSP', name: 'Response Steward',     unit: 'hour', role: 'Response Steward',
    cost: 14.10, charge: 21.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-st-sia',      kind: 'staff', code: 'ST-SIA', name: 'SIA Licensed Officer', unit: 'hour', role: 'Security Officer',
    cost: 16.20, charge: 24.50, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 40, charge: 23.50 }], history: [] },

  { id: 'ch-st-super',    kind: 'staff', code: 'ST-SUP', name: 'Supervisor',           unit: 'hour', role: 'Gate Supervisor',
    cost: 16.80, charge: 25.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-st-control',  kind: 'staff', code: 'ST-CTL', name: 'Control Room Operator',unit: 'hour', role: 'Control Room Operator',
    cost: 15.40, charge: 23.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-st-hosp',     kind: 'staff', code: 'ST-HSP', name: 'Hospitality Host',     unit: 'hour', role: 'Hospitality Host',
    cost: 13.20, charge: 19.50, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-st-bar',      kind: 'staff', code: 'ST-BAR', name: 'Bar Staff',            unit: 'hour', role: 'Bar Staff',
    cost: 12.40, charge: 18.00, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 30, charge: 17.25 }], history: [] },

  { id: 'ch-st-taxi',     kind: 'staff', code: 'ST-TXM', name: 'Taxi Marshal',         unit: 'hour', role: 'Taxi Marshal',
    cost: 13.10, charge: 19.75, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-st-turnstile',kind: 'staff', code: 'ST-TRN', name: 'Turnstile Operator',   unit: 'hour', role: 'Turnstile Operator',
    cost: 12.60, charge: 18.50, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-st-pit',      kind: 'staff', code: 'ST-PIT', name: 'Pit Steward',          unit: 'hour', role: 'Pit Steward',
    cost: 13.60, charge: 20.50, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  /* ---- Kit day rates (per item per day) ------------------------------- */
  { id: 'ch-kit-radio',   kind: 'kit', code: 'KT-RAD', name: 'Two-way radio (Motorola DP2400)', unit: 'day',
    cost: 2.80, charge: 7.50, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 40, charge: 6.75 }, { minQty: 100, charge: 6.00 }],
    history: [{ effectiveFrom: '2025-04-01', cost: 2.60, charge: 7.00, tiers: [] }], hireHopCode: 'RAD-DP2400' },

  { id: 'ch-kit-charger', kind: 'kit', code: 'KT-CHG', name: 'Radio 6-way charge bank', unit: 'day',
    cost: 1.20, charge: 4.00, effectiveFrom: '2026-04-01', tiers: [], history: [], hireHopCode: 'RAD-CHG6' },

  { id: 'ch-kit-barrier', kind: 'kit', code: 'KT-BAR', name: 'Pedestrian barrier (2.2m)', unit: 'day',
    cost: 0.95, charge: 3.20, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 100, charge: 2.75 }, { minQty: 400, charge: 2.40 }], history: [], hireHopCode: 'BAR-PED22' },

  { id: 'ch-kit-heras',   kind: 'kit', code: 'KT-HRS', name: 'Heras fence panel + feet', unit: 'day',
    cost: 0.80, charge: 2.90, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 200, charge: 2.35 }], history: [], hireHopCode: 'FEN-HERAS' },

  { id: 'ch-kit-cone',    kind: 'kit', code: 'KT-CON', name: 'Traffic cone (750mm)', unit: 'day',
    cost: 0.18, charge: 0.85, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 200, charge: 0.65 }], history: [], hireHopCode: 'TM-CONE750' },

  { id: 'ch-kit-signage', kind: 'kit', code: 'KT-SGN', name: 'Directional signage pack', unit: 'day',
    cost: 9.50, charge: 28.00, effectiveFrom: '2026-04-01', tiers: [], history: [], hireHopCode: 'SGN-DIRPK' },

  { id: 'ch-kit-lighting',kind: 'kit', code: 'KT-LGT', name: 'Tower light (diesel)', unit: 'day',
    cost: 42.00, charge: 95.00, effectiveFrom: '2026-04-01', tiers: [], history: [], hireHopCode: 'LGT-TOWER' },

  { id: 'ch-kit-buggy',   kind: 'kit', code: 'KT-BGY', name: 'Site buggy (6-seat)', unit: 'day',
    cost: 55.00, charge: 130.00, effectiveFrom: '2026-04-01', tiers: [], history: [], hireHopCode: 'VEH-BUGGY6' },

  { id: 'ch-kit-welfare', kind: 'kit', code: 'KT-WLF', name: 'Staff welfare unit', unit: 'day',
    cost: 68.00, charge: 165.00, effectiveFrom: '2026-04-01', tiers: [], history: [], hireHopCode: 'WEL-UNIT' },

  { id: 'ch-kit-hivis',   kind: 'kit', code: 'KT-HIV', name: 'Branded hi-vis (consumable)', unit: 'each',
    cost: 3.40, charge: 8.50, effectiveFrom: '2026-04-01',
    tiers: [{ minQty: 100, charge: 7.50 }], history: [], hireHopCode: 'PPE-HIVIS' },

  { id: 'ch-kit-cabin',   kind: 'kit', code: 'KT-CAB', name: 'Steward cabin / control point', unit: 'day',
    cost: 75.00, charge: 180.00, effectiveFrom: '2026-04-01', tiers: [], history: [], hireHopCode: 'CAB-CTRL' },

  /* ---- Services ------------------------------------------------------- */
  { id: 'ch-sv-tmplan',   kind: 'service', code: 'SV-TMP', name: 'Traffic management plan', unit: 'each',
    cost: 180.00, charge: 495.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-sv-survey',   kind: 'service', code: 'SV-SUR', name: 'Pre-event site survey', unit: 'each',
    cost: 145.00, charge: 385.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-sv-pm',       kind: 'service', code: 'SV-PM',  name: 'Event project management', unit: 'day',
    cost: 210.00, charge: 550.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-sv-accred',   kind: 'service', code: 'SV-ACC', name: 'Accreditation administration', unit: 'each',
    cost: 90.00, charge: 245.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-sv-transport',kind: 'service', code: 'SV-TRN', name: 'Crew transport (17-seat minibus)', unit: 'day',
    cost: 135.00, charge: 295.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },

  { id: 'ch-sv-radiolic', kind: 'service', code: 'SV-RLC', name: 'Ofcom radio licence (per event)', unit: 'each',
    cost: 75.00, charge: 160.00, effectiveFrom: '2026-04-01', tiers: [], history: [] },
];

/* --------------------------------------------------- 2. client records */
const CLIENT_EXTRA: Record<string, Partial<ClientExtra>> = {
  'c-19': { legalName: 'Festival Republic Ltd', contact: 'Dana Reilly', contactRole: 'Head of Operations',
            phone: '020 7009 3400', billingEmail: 'ap@festivalrepublic.com', termsDays: 30, creditLimit: 250000,
            agreement: 'Master Services Agreement 2024–2027', agreementEnds: '2027-03-31', depositPolicy: 25,
            address: 'Waterhouse Building, Kensington, London' },
  'c-20': { legalName: 'EDG Sports Management Ltd', contact: 'Marcus Vane', contactRole: 'Match Day Manager',
            phone: '023 8047 2200', billingEmail: 'finance@edgsports.co.uk', termsDays: 30, creditLimit: 90000,
            agreement: 'Seasonal fixture agreement 2026', agreementEnds: '2026-09-30', depositPolicy: 0,
            address: 'Ageas Bowl, Botley Road, Southampton' },
  'c-12': { legalName: 'The Jockey Club Racecourses Ltd', contact: 'Elaine Davis', contactRole: 'Raceday Operations',
            phone: '0151 522 2929', billingEmail: 'purchaseledger@thejockeyclub.co.uk', termsDays: 45, creditLimit: 150000,
            agreement: 'Raceday stewarding framework', agreementEnds: '2027-01-31', depositPolicy: 0,
            address: 'Aintree Racecourse, Ormskirk Road, Liverpool' },
  'c-4':  { legalName: 'AEG Facilities (UK) Limited', contact: 'Simon Achebe', contactRole: 'Venue Operations',
            phone: '020 8782 5500', billingEmail: 'ovo.ap@aegeurope.com', termsDays: 45, creditLimit: 120000,
            agreement: 'Arena casual labour agreement', agreementEnds: '2026-12-31', depositPolicy: 0,
            address: 'OVO Arena Wembley, Arena Square, London' },
  'c-3':  { legalName: 'Active Training World Ltd', contact: 'Martin Kaye', contactRole: 'Race Director',
            phone: '01727 227 400', billingEmail: 'martin@activetrainingworld.co.uk', termsDays: 14, creditLimit: 25000,
            agreement: 'Per-event terms', agreementEnds: null, depositPolicy: 20,
            address: 'St Albans, Hertfordshire' },
  'c-17': { legalName: 'Alresford Agricultural Show Society', contact: 'Judith Pell', contactRole: 'Show Secretary',
            phone: '01962 733 445', billingEmail: 'secretary@alresfordshow.co.uk', termsDays: 30, creditLimit: 20000,
            agreement: 'Annual show agreement', agreementEnds: '2026-12-31', depositPolicy: 20,
            address: 'Tichborne Park, Alresford, Hampshire' },
  'c-21': { legalName: 'Nepalese Community Trust', contact: 'Bishal Gurung', contactRole: 'Event Lead',
            phone: '01252 330 118', billingEmail: 'accounts@nepalesetrust.org.uk', termsDays: 14, creditLimit: 12000,
            agreement: 'Per-event terms', agreementEnds: null, depositPolicy: 50,
            address: 'Aldershot, Hampshire' },
  'c-24': { legalName: 'Ascot Racecourse Ltd', contact: 'Freya Lomax', contactRole: 'Raceday Staffing',
            phone: '0344 346 3000', billingEmail: 'ap@ascot.co.uk', termsDays: 45, creditLimit: 180000,
            agreement: 'Raceday stewarding framework', agreementEnds: '2027-05-31', depositPolicy: 0,
            address: 'High Street, Ascot, Berkshire' },
  'c-6':  { legalName: 'All England Lawn Tennis Club', contact: 'Peter Marsh', contactRole: 'Championships Ops',
            phone: '020 8944 1066', billingEmail: 'suppliers@aeltc.com', termsDays: 60, creditLimit: 300000,
            agreement: 'Championships supplier agreement', agreementEnds: '2027-07-31', depositPolicy: 0,
            address: 'Church Road, Wimbledon, London' },
};

export const CLIENT_DEFAULTS: ClientExtra = { legalName: null, contact: null, contactRole: null, phone: null,
  billingEmail: null, termsDays: 30, creditLimit: 15000, agreement: 'Per-event terms',
  agreementEnds: null, depositPolicy: 25, address: null };

/** Base rows + CRM fields. Built once rather than mutated, so nothing can
    observe a half-enriched client. */
export const CLIENTS: Client[] = CLIENTS_BASE.map((c) => {
  const merged: Client = { ...CLIENT_DEFAULTS, legalName: c.name, ...CLIENT_EXTRA[c.id], ...c } as Client;
  if (!merged.billingEmail && c.email) merged.billingEmail = c.email;
  return merged;
});

/* -------------------------------------------------- 3. event schedules */
export const EVENT_SCHEDULE: EventScheduleEntry[] = [
  { id: 'sch-1', name: 'Wilderness Festival',            clientId: 'c-19', venue: 'Cornbury Park, Oxfordshire',
    type: 'festival', recurrence: 'Annual — late July', start: '2026-07-27T07:00:00', end: '2026-08-03T19:00:00',
    leadDays: 90, triggerRule: 'Raise WOF 90 days before build', ownerId: 'm-colin', wofId: 'wof-101' },

  { id: 'sch-2', name: 'Reggaeland',                     clientId: 'c-19', venue: 'Crystal Palace Park, London',
    type: 'festival', recurrence: 'Annual — early August', start: '2026-07-30T08:00:00', end: '2026-08-04T22:00:00',
    leadDays: 90, triggerRule: 'Raise WOF 90 days before build', ownerId: 'm-colin', wofId: 'wof-102' },

  { id: 'sch-3', name: 'Taxi Marshal — OVO Arena',       clientId: 'c-4',  venue: 'OVO Arena Wembley',
    type: 'venue', recurrence: 'Per show night', start: '2026-07-31T18:00:00', end: '2026-08-01T03:00:00',
    leadDays: 14, triggerRule: 'Raise WOF on receipt of show schedule', ownerId: 'm-gracie', wofId: 'wof-103' },

  { id: 'sch-4', name: '100 — Phoenix v Welsh Fire',     clientId: 'c-20', venue: 'Ageas Bowl, Southampton',
    type: 'sports', recurrence: 'Fixture list', start: '2026-08-01T12:00:00', end: '2026-08-01T23:00:00',
    leadDays: 21, triggerRule: 'Raise WOF on fixture confirmation', ownerId: 'm-colin', wofId: 'wof-104' },

  { id: 'sch-5', name: 'Nepalese Community Day',         clientId: 'c-21', venue: 'Aldershot Community Ground',
    type: 'show', recurrence: 'Annual — August', start: '2026-08-01T10:00:00', end: '2026-08-01T20:00:00',
    leadDays: 30, triggerRule: 'Raise WOF 30 days before', ownerId: 'm-gracie', wofId: 'wof-105' },

  { id: 'sch-6', name: '100 — Phoenix v Sunrisers',      clientId: 'c-20', venue: 'Ageas Bowl, Southampton',
    type: 'sports', recurrence: 'Fixture list', start: '2026-08-07T12:00:00', end: '2026-08-07T23:00:00',
    leadDays: 21, triggerRule: 'Raise WOF on fixture confirmation', ownerId: 'm-colin', wofId: 'wof-106' },

  { id: 'sch-7', name: 'Aintree Race Day',               clientId: 'c-12', venue: 'Aintree Racecourse',
    type: 'sports', recurrence: 'Race calendar', start: '2026-08-08T09:00:00', end: '2026-08-08T21:00:00',
    leadDays: 30, triggerRule: 'Raise WOF 30 days before raceday', ownerId: 'm-colin', wofId: 'wof-107' },

  { id: 'sch-8', name: 'St Albans Half Marathon',        clientId: 'c-3',  venue: 'Verulamium Park, St Albans',
    type: 'road-race', recurrence: 'Annual — August', start: '2026-08-09T06:00:00', end: '2026-08-09T15:00:00',
    leadDays: 60, triggerRule: 'Raise WOF 60 days before race day', ownerId: 'm-gracie', wofId: 'wof-108' },

  { id: 'sch-9', name: 'Alresford Show',                 clientId: 'c-17', venue: 'Tichborne Park, Alresford',
    type: 'show', recurrence: 'Annual — mid August', start: '2026-08-15T07:00:00', end: '2026-08-15T19:00:00',
    leadDays: 60, triggerRule: 'Raise WOF 60 days before show day', ownerId: 'm-colin', wofId: 'wof-109' },

  /* --- Known events with NO WOF yet. These are the reason the calendar and
         the WOF are bidirectional: OPS need to see them before anyone has
         raised paperwork, and the system must nag when the lead time on the
         trigger rule has passed. -------------------------------------- */
  { id: 'sch-10', name: 'Ascot Late Summer Raceday',     clientId: 'c-24', venue: 'Ascot Racecourse',
    type: 'sports', recurrence: 'Race calendar', start: '2026-08-22T10:00:00', end: '2026-08-22T20:00:00',
    leadDays: 30, triggerRule: 'Raise WOF 30 days before raceday', ownerId: 'm-colin', wofId: null },

  { id: 'sch-11', name: 'Aldborough & Boroughbridge Show', clientId: 'c-14', venue: 'Boroughbridge Showground',
    type: 'show', recurrence: 'Annual — late August', start: '2026-08-29T07:00:00', end: '2026-08-29T18:00:00',
    leadDays: 60, triggerRule: 'Raise WOF 60 days before show day', ownerId: 'm-gracie', wofId: null },

  { id: 'sch-12', name: 'OVO Arena — September residency', clientId: 'c-4', venue: 'OVO Arena Wembley',
    type: 'venue', recurrence: 'Per show night', start: '2026-09-04T17:00:00', end: '2026-09-06T01:00:00',
    leadDays: 14, triggerRule: 'Raise WOF on receipt of show schedule', ownerId: 'm-gracie', wofId: null },

  { id: 'sch-13', name: 'AELTC Autumn Members Event',    clientId: 'c-6',  venue: 'All England Club, Wimbledon',
    type: 'corporate', recurrence: 'One-off', start: '2026-09-12T09:00:00', end: '2026-09-12T19:00:00',
    leadDays: 45, triggerRule: 'Raise WOF 45 days before', ownerId: 'm-colin', wofId: null },

  { id: 'sch-14', name: 'Rushden & Diamonds — home fixtures', clientId: 'c-7', venue: 'Hayden Road, Rushden',
    type: 'sports', recurrence: 'Fortnightly — season', start: '2026-09-19T13:00:00', end: '2026-09-19T18:00:00',
    leadDays: 21, triggerRule: 'Raise WOF on fixture confirmation', ownerId: 'm-gracie', wofId: null },

  /* --- Historic, already delivered and invoiced. Feeds cash flow and the
         client job history. ------------------------------------------- */
  { id: 'sch-h1', name: 'Ageas Bowl — Vitality Blast',   clientId: 'c-20', venue: 'Ageas Bowl, Southampton',
    type: 'sports', recurrence: 'Fixture list', start: '2026-06-20T12:00:00', end: '2026-06-20T23:00:00',
    leadDays: 21, triggerRule: 'Raise WOF on fixture confirmation', ownerId: 'm-colin', wofId: 'wof-091' },

  { id: 'sch-h2', name: 'AELTC Championships — car parks', clientId: 'c-6', venue: 'All England Club, Wimbledon',
    type: 'sports', recurrence: 'Annual — June/July', start: '2026-06-29T06:00:00', end: '2026-07-12T22:00:00',
    leadDays: 120, triggerRule: 'Raise WOF 120 days before', ownerId: 'm-colin', wofId: 'wof-092' },

  { id: 'sch-h3', name: 'Aintree Summer Raceday',        clientId: 'c-12', venue: 'Aintree Racecourse',
    type: 'sports', recurrence: 'Race calendar', start: '2026-07-04T09:00:00', end: '2026-07-04T21:00:00',
    leadDays: 30, triggerRule: 'Raise WOF 30 days before raceday', ownerId: 'm-colin', wofId: 'wof-093' },

  { id: 'sch-h4', name: 'Abbots Events — Summer Fete',   clientId: 'c-2',  venue: 'Verulamium Park, St Albans',
    type: 'show', recurrence: 'One-off', start: '2026-07-11T09:00:00', end: '2026-07-11T18:00:00',
    leadDays: 45, triggerRule: 'Raise WOF 45 days before', ownerId: 'm-gracie', wofId: 'wof-094' },
];

/* ---------------------------------------------------- 4. staff register */
/* Pay rate is what PAYROLL uses; the table of charges `cost` is what JOB
   COSTING uses for planning. Related, but not the same number. */
const PAY_BANDS: Record<string, { paye: number; se: number }> = {
  'Stewarding':        { paye: 12.21, se: 13.50 },
  'Traffic & Car Park':{ paye: 12.21, se: 13.50 },
  'Hospitality':       { paye: 12.60, se: 14.00 },
  'Security':          { paye: 15.00, se: 17.00 },
  'Bar':               { paye: 12.21, se: 13.40 },
  'Control Room':      { paye: 14.20, se: 16.00 },
};

/* Deterministic so the prototype reads the same for everyone. */
const RTW_OVERRIDES: Record<string, Partial<EmployeeExtra> & { rtwNote?: string }> = {
  'e-22': { rtw: 'pending',  rtwNote: 'Share code submitted, awaiting Home Office check' },
  'e-29': { rtw: 'pending',  rtwNote: 'Passport copy received, not yet verified' },
  'e-6':  { rtw: 'expiring', rtwExpiry: '2026-08-21', rtwNote: 'Visa expires in 3 weeks' },
  'e-3':  { rtw: 'expiring', rtwExpiry: '2026-09-14', rtwNote: 'Student visa — hour cap applies' },
  'e-26': { rtw: 'verified' },
};

export const EMPLOYEES: Employee[] = EMPLOYEES_BASE.map((e, i) => {
  const band = PAY_BANDS[e.department] || PAY_BANDS['Stewarding'];
  const selfEmployed = e.tags.includes('supervisor') || i % 7 === 0;
  const ov = RTW_OVERRIDES[e.id] || {};
  return {
    ...e,
    employmentType: selfEmployed ? 'Self-employed' : 'PAYE',
    payRate: selfEmployed ? band.se : band.paye,
    // Supervisors and SIA holders carry an uplift, applied per-shift.
    payUplift: e.tags.includes('supervisor') ? 2.5 : e.tags.includes('sia') ? 1.75 : 0,
    niNumber: `${['JK', 'PT', 'WM', 'NL', 'SR'][i % 5]} ${String(10 + i).padStart(2, '0')} ${String(20 + i * 3).padStart(2, '0')} ${String(30 + i).padStart(2, '0')} ${'ABCD'[i % 4]}`,
    rtw: ov.rtw || 'verified',
    rtwExpiry: ov.rtwExpiry || null,
    rtwNote: ov.rtwNote || '',
    qualifications: e.tags.slice(),
    startedAt: `202${3 + (i % 3)}-0${1 + (i % 9)}-1${i % 9}`,
  };
});

/* ------------------------------------- 5. job types + document types */
/* Briefing §3: "The required document list for a given job type must be
   definable without developer intervention." Both live in data; the WOF
   builds its checklist from whatever the job type says when it is created.

   `blocking` implements the warn-vs-block decision: the prototype WARNS and
   records an override rather than hard-blocking, but the flag is there for
   OPS to turn into a hard gate once policy is agreed. */
export const DOCUMENT_TYPES: DocumentType[] = [
  { id: 'risk-assessment',  label: 'Risk Assessment',                       owner: 'EP Operations', leadDays: 14, blocking: true },
  { id: 'method-statement', label: 'Method Statement',                      owner: 'EP Operations', leadDays: 14, blocking: true },
  { id: 'insurance',        label: 'Employers & Public Liability cert.',    owner: 'EP Finance',    leadDays: 21, blocking: true },
  { id: 'sia-licences',     label: 'SIA licence register',                  owner: 'EP Compliance', leadDays: 7,  blocking: true },
  { id: 'staff-list',       label: 'Accreditation / staff list',            owner: 'EP Operations', leadDays: 10, blocking: false },
  { id: 'traffic-plan',     label: 'Traffic management plan',               owner: 'EP Operations', leadDays: 21, blocking: true },
  { id: 'site-plan',        label: 'Site plan',                             owner: 'Client',        leadDays: 14, blocking: false },
  { id: 'event-licence',    label: 'Premises / event licence',              owner: 'Client',        leadDays: 28, blocking: true },
  { id: 'client-brief',     label: 'Signed client brief',                   owner: 'Client',        leadDays: 7,  blocking: false },
  { id: 'medical-plan',     label: 'Medical cover plan',                    owner: 'Client',        leadDays: 14, blocking: false },
  { id: 'radio-licence',    label: 'Ofcom radio licence',                   owner: 'EP Operations', leadDays: 10, blocking: false },
  { id: 'purchase-order',   label: 'Client purchase order',                 owner: 'Client',        leadDays: 3,  blocking: false },
];

export const JOB_TYPES: JobType[] = [
  { id: 'festival',  label: 'Festival / multi-day', depositPct: 25, termsDays: 30,
    docs: ['risk-assessment','method-statement','insurance','sia-licences','staff-list','traffic-plan','site-plan','event-licence','medical-plan','radio-licence'] },
  { id: 'sports',    label: 'Sports fixture', depositPct: 0, termsDays: 30,
    docs: ['risk-assessment','insurance','sia-licences','staff-list','site-plan','purchase-order'] },
  { id: 'show',      label: 'County / agricultural show', depositPct: 20, termsDays: 30,
    docs: ['risk-assessment','method-statement','insurance','traffic-plan','site-plan','client-brief'] },
  { id: 'road-race', label: 'Road race / mass participation', depositPct: 20, termsDays: 14,
    docs: ['risk-assessment','traffic-plan','insurance','medical-plan','staff-list'] },
  { id: 'corporate', label: 'Corporate / hospitality', depositPct: 50, termsDays: 14,
    docs: ['risk-assessment','insurance','client-brief','purchase-order'] },
  { id: 'venue',     label: 'Venue / arena night', depositPct: 0, termsDays: 45,
    docs: ['risk-assessment','insurance','sia-licences','staff-list'] },
];

/* ==========================================================================
   LOOKUPS + RATE RESOLUTION
   ========================================================================== */

export const employee = (id: string | null | undefined): Employee | undefined =>
  EMPLOYEES.find((e) => e.id === id);
export const client = (id: string | null | undefined): Client | undefined =>
  CLIENTS.find((c) => c.id === id);
export const event = (id: string | null | undefined): EpEvent | undefined =>
  EVENTS.find((e) => e.id === id);
export const tag = (id: string | null | undefined): Tag | undefined =>
  TAGS.find((t) => t.id === id);
export const manager = (id: string | null | undefined): Manager | undefined =>
  MANAGERS.find((m) => m.id === id);
export const charge = (id: string | null | undefined): Charge | undefined =>
  CHARGES.find((c) => c.id === id);
export const schedule = (id: string | null | undefined): EventScheduleEntry | undefined =>
  EVENT_SCHEDULE.find((s) => s.id === id);
export const docType = (id: string | null | undefined): DocumentType | undefined =>
  DOCUMENT_TYPES.find((d) => d.id === id);
export const jobType = (id: string | null | undefined): JobType | undefined =>
  JOB_TYPES.find((j) => j.id === id);

/** All versions of a charge, newest first, each with an effectiveFrom. */
export function chargeVersions(ch: Charge): ChargeVersion[] {
  return [
    { effectiveFrom: ch.effectiveFrom, cost: ch.cost, charge: ch.charge, tiers: ch.tiers, current: true },
    ...(ch.history || []).map((h) => ({ ...h, current: false })),
  ].sort((a, b) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom));
}

/**
 * The rate that applied on `when`. This is what stops a rate rise in April
 * from silently re-pricing a job invoiced in March.
 */
export function rateAt(chargeId: string, when?: string | Date | null): ResolvedRate | null {
  const ch = CHARGES.find((c) => c.id === chargeId);
  if (!ch) return null;
  const t = new Date(when || Date.now());
  const versions = chargeVersions(ch);
  const v = versions.find((ver) => new Date(ver.effectiveFrom) <= t) || versions[versions.length - 1];
  return {
    chargeId, kind: ch.kind, name: ch.name, unit: ch.unit, code: ch.code,
    cost: v.cost, charge: v.charge, tiers: v.tiers || [],
    rateVersion: v.effectiveFrom, isCurrent: !!v.current,
  };
}

/** Volume break: highest tier whose minQty the quantity meets. */
export function tieredCharge(rate: ResolvedRate | null, qty: number): number {
  if (!rate) return 0;
  const hit = (rate.tiers || [])
    .filter((t: ChargeTier) => qty >= t.minQty)
    .sort((a, b) => b.minQty - a.minQty)[0];
  return hit ? hit.charge : rate.charge;
}

/** Charge line that supplies a given staffing role, used to price a shift. */
export const chargeForRole = (role: string): Charge =>
  CHARGES.find((c) => c.kind === 'staff' && c.role === role) ||
  (CHARGES.find((c) => c.id === 'ch-st-event') as Charge);

/* ==========================================================================
   SEED RE-DATING
   --------------------------------------------------------------------------
   Runs once, at import, after every seed array above is built and before any
   consumer can read one. Each date-shaped string is moved forward by the whole
   number of weeks recorded at first run, so "tomorrow" in the seed is still
   tomorrow, on the same weekday, however long after 31 July 2026 the app is
   opened. `shiftDeep` matches only strings that are entirely a date, so free
   text, NI numbers, job codes and ids are untouched.

   Order matters: `CLIENTS` and `EMPLOYEES` are built by `.map()` from base
   rows, so they hold their own objects and must be shifted here rather than at
   the base arrays, which nothing else can see.
   ========================================================================== */
shiftDeep(EVENTS);
shiftDeep(CHECK_INS);
shiftDeep(ATTENDANCE);
shiftDeep(NOTIFICATIONS);
shiftDeep(CHARGES);
shiftDeep(CLIENTS);
shiftDeep(EVENT_SCHEDULE);
shiftDeep(EMPLOYEES);

/* ==========================================================================
   DAY ENTRIES — built last, and deliberately not shifted
   --------------------------------------------------------------------------
   Last, because `buildDayEntries()` reads both `TEAM` and `EMPLOYEES`, and
   `EMPLOYEES` is assembled by `.map()` from `EMPLOYEES_BASE` far below where
   the builder is defined. Calling it any earlier produces a day-state set with
   no casual workers in it — silently, since an absent array throws nothing and
   looks like nothing until somebody notices `assign()` never refuses anybody.

   Not shifted, because it is generated from `NOW` rather than written against
   `SEED_ANCHOR`. `shiftDeep` exists to move fixed dates forward to meet the
   clock; these were computed at the clock in the first place, so passing them
   through it would move them a second time and put every day state a few weeks
   away from the events it is supposed to explain.
   ========================================================================== */
export const DAY_ENTRIES: DayEntry[] = buildDayEntries();
