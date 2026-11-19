/* ============================================================================
   EPROSTA — ADDING A WORKER TO THE STAFF REGISTER
   ----------------------------------------------------------------------------
   The `staff.edit` capability has always promised "Add workers, amend records,
   flag and deactivate", and Recruitment holds it — but there was no way to add
   anybody. The register was the thirty seeded rows and nothing else.

   WHAT A NEW STARTER LOOKS LIKE
   -----------------------------
     · status 'pending'  — "Onboarding complete, documents not yet verified".
       Nobody is Verified the moment they are typed in; that is what the
       documents on their profile are for.
     · right to work 'pending' — same reason. Not checked is not checked.
     · no shifts, no strikes, no rating history. The rating engine scores an
       empty record as the neutral prior in the "New" band, which is exactly
       where a starter belongs in the queue.
     · pay from the department's band (PAYE or self-employed), the same table
       the seed uses, so payroll reads them like everybody else.

   WHY IT IS STORED, AND WHERE IT IS REPLAYED
   ------------------------------------------
   `EMPLOYEES` is built once from the seed. A worker only pushed into it would
   vanish on refresh — the "toast that changed nothing" failure the clients
   module was written to stop. Additions are journalled to localStorage under
   `STAFF_KEY` and replayed at the END of `data/db.ts`, not here, because the
   rating engine and the flags module walk `EMPLOYEES` the moment they load and
   have to find the new starter there.
   ========================================================================== */

import { DEPARTMENTS, EMPLOYEES, NOW, OFFICES, PAY_BANDS, STAFF_KEY, TAGS } from '@/data/db';
import type { Employee } from '@/data/types';
import * as RATING from './rating';

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

interface Journal {
  v: 1;
  added: Employee[];
}

function read(): Journal {
  try {
    const raw = JSON.parse(localStorage.getItem(STAFF_KEY) || 'null');
    if (!raw || raw.v !== 1 || !Array.isArray(raw.added)) return { v: 1, added: [] };
    return { v: 1, added: raw.added };
  } catch {
    return { v: 1, added: [] };
  }
}

function write(journal: Journal): void {
  try {
    localStorage.setItem(STAFF_KEY, JSON.stringify(journal));
  } catch {
    /* private mode — degrades to in-memory */
  }
  emit();
}

/* ------------------------------------------------------- reference lists */
/** Offices a worker can belong to — the filter's "All Offices" is not one. */
export const STAFF_OFFICES: string[] = OFFICES.filter((o) => o !== 'All Offices');
export const STAFF_DEPARTMENTS: string[] = DEPARTMENTS;
export type EmploymentType = Employee['employmentType'];
export const EMPLOYMENT_TYPES: EmploymentType[] = ['PAYE', 'Self-employed'];

/* ------------------------------------------------------------ validation */
export interface StaffInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  office: string;
  department: string;
  employmentType: EmploymentType;
  tags: string[];
}

export type StaffErrors = Partial<Record<'firstName' | 'lastName' | 'email' | 'phone' | 'office' | 'department', string>>;

export function validateEmail(email: string): string | null {
  const e = email.trim();
  if (!e) return 'Required — shift offers go here';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'That is not an email address';
  const taken = EMPLOYEES.find((x) => x.email.trim().toLowerCase() === e.toLowerCase());
  if (taken) return `Already on the register as ${taken.name}`;
  return null;
}

const digits = (p: string): string => p.replace(/\D/g, '');

/** UK numbers in either form: 07… (11 digits) or +44 7… (12 digits). */
export function validatePhone(phone: string): string | null {
  const p = phone.trim();
  if (!p) return 'Required — callouts need a number';
  if (!/^[+\d\s()-]+$/.test(p)) return 'Numbers, spaces and + only';
  const d = digits(p);
  if (d.length < 10 || d.length > 13) return 'That does not look like a full phone number';
  const taken = EMPLOYEES.find((x) => digits(x.phone).slice(-10) === d.slice(-10));
  if (taken) return `Already on the register as ${taken.name}`;
  return null;
}

export function validateStaff(input: StaffInput): StaffErrors {
  const errors: StaffErrors = {};
  if (!input.firstName.trim()) errors.firstName = 'Required';
  if (!input.lastName.trim()) errors.lastName = 'Required';
  const email = validateEmail(input.email);
  if (email) errors.email = email;
  const phone = validatePhone(input.phone);
  if (phone) errors.phone = phone;
  if (!STAFF_OFFICES.includes(input.office)) errors.office = 'Pick an office';
  if (!STAFF_DEPARTMENTS.includes(input.department)) errors.department = 'Pick a department';
  return errors;
}

export const hasErrors = (e: StaffErrors): boolean => Object.keys(e).length > 0;

/* ---------------------------------------------------------------- create */
function nextId(): string {
  // Numeric suffix on purpose: the rating engine seeds its PRNG from it.
  const max = EMPLOYEES.reduce((m, e) => Math.max(m, parseInt(e.id.split('-')[1], 10) || 0), 0);
  return `e-${max + 1}`;
}

function initialsOf(first: string, last: string): string {
  return `${first.trim()[0] ?? ''}${last.trim()[0] ?? ''}`.toUpperCase();
}

/** A stable avatar hue from the name, spread round the wheel like the seed's. */
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

const cap = (s: string): string => s.trim().replace(/\s+/g, ' ');

export type CreateResult = { ok: true; employee: Employee } | { ok: false; errors: StaffErrors };

export function createStaff(input: StaffInput): CreateResult {
  const errors = validateStaff(input);
  if (hasErrors(errors)) return { ok: false, errors };

  const first = cap(input.firstName);
  const last = cap(input.lastName);
  const name = `${first} ${last}`;
  const band = PAY_BANDS[input.department] || PAY_BANDS['Stewarding'];
  const selfEmployed = input.employmentType === 'Self-employed';
  const tags = TAGS.map((t) => t.id).filter((id) => input.tags.includes(id));

  const emp: Employee = {
    id: nextId(),
    name,
    email: input.email.trim(),
    phone: input.phone.trim(),
    office: input.office,
    department: input.department,
    rating: RATING.PRIOR * 5,
    ratedShifts: 0,
    status: 'pending',
    strikes: 0,
    tags,
    available: true,
    shiftsWorked: 0,
    initials: initialsOf(first, last),
    hue: hueOf(name),

    employmentType: input.employmentType,
    payRate: selfEmployed ? band.se : band.paye,
    payUplift: tags.includes('supervisor') ? 2.5 : tags.includes('sia') ? 1.75 : 0,
    niNumber: '',
    rtw: 'pending',
    rtwExpiry: null,
    rtwNote: 'New starter — right to work not yet checked',
    qualifications: tags.slice(),
    startedAt: new Date(NOW).toISOString().slice(0, 10),
    priorRating: RATING.PRIOR * 5,
  };

  // Publish the engine's view onto the record, as it does for the seed at load.
  const s = RATING.score(emp);
  emp.rating = s.value;
  emp.ratedShifts = s.rated;
  emp.ratingBand = s.band.id;

  EMPLOYEES.push(emp);
  const journal = read();
  journal.added.push(emp);
  write(journal);
  return { ok: true, employee: emp };
}

/** Workers added through the app (not the seed) — for tests and the profile. */
export const addedIds = (): string[] => read().added.map((e) => e.id);
