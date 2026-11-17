/* ============================================================================
   EPROSTA — THE 2027 LABOUR RATE CARD
   ----------------------------------------------------------------------------
   Transcribed from "WIP - EP Team - Rate Card - MASTER", tab "2027 - Rate Card
   Labour", on 12 Nov 2026. One block per wage framework, and the blocks are
   NOT the same list: the real Living Wage card has 33 roles in 7 categories,
   the National Living Wage card 32 (no Fan Zone Manager), and the London and
   Ireland cards 27 roles in 10 categories with a few names of their own
   ("SIA Security DS", "Banksmen", "Cashiers"). Names are kept exactly as the
   sheet spells them, so a role here can be found there.

   Each row carries, in sheet order:

     A  role                       the name on the quote and the roster
     B  category                   the pay scale the role sits on
     E  2027 RLW applied           the rise per hour over the 2026 rate
                                   (null where the sheet has "/" — a new role)
     F  2027 Pay Rate              what one hour of the role is PAID
     K  Subtotal Cost              pay + NI + holiday pay + head office
     L  Rate A  (5%)               high volume / strategically valuable
     N  Rate B  (10%)              standard rate for new business
     P  Rate C  (20%)              new business, high season

   Sheet notes 1-4: every work order uses these figures, the real Living Wage
   card is the primary one, the client is charged Rate A, B or C, and nothing
   is to deviate from them. So these are read as written — never derived from
   a factor — see `rates.frameworkRate`.

   The Ireland card is in EUROS. Nothing here converts it.

   This file imports nothing, so `db.ts` can build charges from it.
   ========================================================================== */

export type LabourFw = 'nlw' | 'rlw' | 'llw' | 'ilw';

export interface LabourRate {
  /** Column B — the pay category (1 is the most senior). */
  category: number;
  /** Column E — "2027 RLW applied": the rise per hour. null = "/" on the sheet. */
  uplift: number | null;
  /** Column F — the 2027 pay rate per hour. */
  pay: number;
  /** Column K — what one hour costs EP to supply. */
  cost: number;
  /** Columns L, N, P — what the client is charged per hour. */
  a: number;
  b: number;
  c: number;
}

type Row = [name: string, category: number, uplift: number | null, pay: number, cost: number, a: number, b: number, c: number];

const RLW: Row[] = [
  ['Operations Manager', 1, 1.06, 25.0, 36.77, 38.61, 40.44, 44.12],
  ['Security Manager', 1, 0, 25.0, 36.77, 38.61, 40.44, 44.12],
  ['Event Manager / Site Manager', 2, 0.76, 22.5, 33.09, 34.75, 36.4, 39.71],
  ['Fan Zone Manager', 2, null, 22.5, 33.09, 34.75, 36.4, 39.71],
  ['CSAS Marshall', 2, null, 22.5, 33.09, 34.75, 36.4, 39.71],
  ['HVM Supervisor', 2, 1.13, 22.5, 33.09, 34.75, 36.4, 39.71],
  ['CAD Technician', 2, null, 22.5, 33.09, 34.75, 36.4, 39.71],
  ['HVM Marshall', 3, 0.92, 18.0, 26.47, 27.8, 29.12, 31.77],
  ['Control Room Coordinator', 3, null, 18.0, 26.47, 27.8, 29.12, 31.77],
  ['Site Crew Chief', 4, 0.77, 16.6, 24.41, 25.63, 26.85, 29.3],
  ['Traffic Manager', 4, 0.77, 16.6, 24.41, 25.63, 26.85, 29.3],
  ['Car Park Manager', 4, 0.77, 16.6, 24.41, 25.63, 26.85, 29.3],
  ['Bag Drop Manager', 4, 0.77, 16.6, 24.41, 25.63, 26.85, 29.3],
  ['SIA Security Supervisor', 4, 0.76, 16.6, 24.41, 25.63, 26.85, 29.3],
  ['Event Supervisor', 4, 0.72, 16.6, 24.41, 25.63, 26.85, 29.3],
  ['Park-Live! On Site Support', 4, 0.71, 16.6, 24.41, 25.63, 26.85, 29.3],
  ['SIA Security', 5, 0.68, 15.5, 22.8, 23.94, 25.08, 27.36],
  ['Forklift / Telehandler Operative', 5, 0.65, 15.5, 22.8, 23.94, 25.08, 27.36],
  ['Banksman', 5, 0.65, 15.5, 22.8, 23.94, 25.08, 27.36],
  ['Cash Manager', 5, 0.72, 15.5, 22.8, 23.94, 25.08, 27.36],
  ['Traffic Supervisor', 5, 0.69, 15.5, 22.8, 23.94, 25.08, 27.36],
  ['Car Park Supervisor', 5, 0.69, 15.5, 22.8, 23.94, 25.08, 27.36],
  ['Bag Drop Supervisor', 5, 0.69, 15.5, 22.8, 23.94, 25.08, 27.36],
  ['Site Admin Coordinator / Company Rep', 6, 0.68, 14.75, 21.7, 22.78, 23.87, 26.04],
  ['Crowd Safety Steward', 6, 0.68, 14.75, 21.7, 22.78, 23.87, 26.04],
  ['Traffic Operative', 6, 0.68, 14.75, 21.69, 22.78, 23.86, 26.03],
  ['Site Crew', 6, 0.65, 14.75, 21.69, 22.78, 23.86, 26.03],
  ['Cashiers / Cash Collectors', 7, 0.65, 14.2, 20.88, 21.93, 22.97, 25.06],
  ['Traffic / Road Closure Steward', 7, 0.65, 14.2, 20.88, 21.93, 22.97, 25.06],
  ['Car Park Steward', 7, 0.65, 14.2, 20.88, 21.93, 22.97, 25.06],
  ['Programme Seller / Merchandise Staff', 7, 0.65, 14.2, 20.88, 21.93, 22.97, 25.06],
  ['Ticket Seller / Checker / Scanner', 7, 0.65, 14.2, 20.88, 21.93, 22.97, 25.06],
  ['Bag Drop Cashier / Runner', 7, 0.65, 14.2, 20.88, 21.93, 22.97, 25.06],
];

const NLW: Row[] = [
  ['Operations Manager', 1, 0.82, 21.62, 31.79, 33.38, 34.97, 38.15],
  ['Security Manager', 1, 0, 21.62, 31.8, 33.39, 34.98, 38.16],
  ['Event Manager / Site Manager', 2, 0.58, 19.46, 28.62, 30.05, 31.48, 34.34],
  ['CSAS Marshall', 2, 0, 19.46, 28.62, 30.05, 31.48, 34.34],
  ['HVM Supervisor', 2, 0.87, 19.46, 28.62, 30.05, 31.48, 34.34],
  ['CAD Technician', 2, 0, 19.46, 28.62, 30.05, 31.48, 34.34],
  ['HVM Marshall', 3, 0.71, 15.57, 22.9, 24.04, 25.19, 27.48],
  ['Control Room Coordinator', 3, 0, 15.57, 22.9, 24.04, 25.19, 27.48],
  ['Site Crew Chief', 4, 0.59, 14.36, 21.12, 22.18, 23.23, 25.34],
  ['Traffic Manager', 4, 0.59, 14.36, 21.12, 22.18, 23.23, 25.34],
  ['Car Park Manager', 4, 0.59, 14.36, 21.12, 22.18, 23.23, 25.34],
  ['Bag Drop Manager', 4, 0.59, 14.36, 21.12, 22.18, 23.23, 25.34],
  ['SIA Security Supervisor', 4, 0.58, 14.36, 21.12, 22.18, 23.23, 25.34],
  ['Event Supervisor', 4, 0.55, 14.36, 21.12, 22.18, 23.23, 25.34],
  ['Park-Live! On Site Support', 4, 0, 14.36, 21.12, 22.18, 23.23, 25.34],
  ['SIA Security', 5, 0.55, 14.03, 20.63, 21.67, 22.7, 24.76],
  ['Forklift / Telehandler Operative', 5, 0.5, 14.03, 20.63, 21.67, 22.7, 24.76],
  ['Banksman', 5, 0.5, 14.03, 20.63, 21.67, 22.7, 24.76],
  ['Cash Manager', 5, 0.55, 14.03, 20.63, 21.67, 22.7, 24.76],
  ['Traffic Supervisor', 5, 0.53, 14.03, 20.63, 21.67, 22.7, 24.76],
  ['Car Park Supervisor', 5, 0.53, 14.03, 20.64, 21.67, 22.7, 24.76],
  ['Bag Drop Supervisor', 5, 0.53, 14.03, 20.64, 21.67, 22.7, 24.76],
  ['Site Admin Coordinator / Company Rep', 6, 0.52, 13.82, 20.33, 21.35, 22.36, 24.4],
  ['Crowd Safety Steward', 6, 0.52, 13.82, 20.33, 21.35, 22.36, 24.4],
  ['Traffic Operative', 6, 0, 13.82, 20.33, 21.34, 22.36, 24.39],
  ['Site Crew', 6, 0.5, 13.82, 20.33, 21.34, 22.36, 24.39],
  ['Cashiers / Cash Collectors', 7, 0.5, 13.3, 19.57, 20.54, 21.52, 23.48],
  ['Traffic / Road Closure Steward', 7, 0.5, 13.3, 19.57, 20.54, 21.52, 23.48],
  ['Car Park Steward', 7, 0.5, 13.3, 19.57, 20.54, 21.52, 23.48],
  ['Programme Seller / Merchandise Staff', 7, 0, 13.3, 19.56, 20.54, 21.52, 23.47],
  ['Ticket Seller / Checker / Scanner', 7, 0.5, 13.3, 19.57, 20.54, 21.52, 23.48],
  ['Bag Drop Cashier / Runner', 7, 0.5, 13.3, 19.57, 20.54, 21.52, 23.48],
];

const LLW: Row[] = [
  ['HVM Supervisor', 1, 1.13, 26.74, 39.33, 41.3, 43.26, 47.2],
  ['Operations Manager (including Per Diems)', 2, 1.06, 25.28, 37.19, 39.04, 40.9, 44.62],
  ['Operations Manager (no expenses TBC)', 2, 1.01, 24.07, 35.4, 37.17, 38.94, 42.48],
  ['HVM Marshall', 3, 0.92, 21.88, 32.18, 33.79, 35.4, 38.62],
  ['Site Crew Chief', 4, 0.77, 18.23, 26.82, 28.16, 29.5, 32.18],
  ['Traffic Manager', 4, 0.77, 18.23, 26.82, 28.16, 29.5, 32.18],
  ['Car Park Manager', 4, 0.77, 18.23, 26.82, 28.16, 29.5, 32.18],
  ['Bag Drop Manager', 4, 0.77, 18.23, 26.82, 28.16, 29.5, 32.18],
  ['Event Manager / Site Manager', 5, 0.76, 17.99, 26.46, 27.78, 29.1, 31.75],
  ['SIA Security Supervisor', 5, 0.76, 17.99, 26.46, 27.78, 29.1, 31.75],
  ['Event Supervisor', 6, 0.72, 17.02, 25.03, 26.28, 27.53, 30.03],
  ['SIA Security DS', 6, 0.72, 17.02, 25.03, 26.28, 27.53, 30.03],
  ['Cash Manager', 6, 0.72, 17.02, 25.03, 26.28, 27.53, 30.03],
  ['Traffic Supervisor', 7, 0.69, 16.41, 24.13, 25.34, 26.55, 28.96],
  ['Car Park Supervisor', 7, 0.69, 16.41, 24.13, 25.34, 26.55, 28.96],
  ['Bag Drop Supervisor', 7, 0.69, 16.41, 24.13, 25.34, 26.55, 28.96],
  ['Site Admin Coordinator', 8, 0.68, 16.17, 23.78, 24.97, 26.15, 28.53],
  ['Crowd Safety Steward', 8, 0.68, 16.17, 23.78, 24.97, 26.15, 28.53],
  ['Site Crew', 9, 0.65, 15.56, 22.88, 24.03, 25.17, 27.46],
  ['Cashiers', 9, 0.65, 15.56, 22.88, 24.03, 25.17, 27.46],
  ['Traffic / Road Closure Steward', 9, 0.65, 15.56, 22.88, 24.03, 25.17, 27.46],
  ['Car Park Steward', 9, 0.65, 15.56, 22.88, 24.03, 25.17, 27.46],
  ['Ticket Seller / Checker', 9, 0.65, 15.56, 22.88, 24.03, 25.17, 27.46],
  ['Bag Drop Cashier', 9, 0.65, 15.56, 22.88, 24.03, 25.17, 27.46],
  ['Bag Drop Runner', 9, 0.65, 15.56, 22.88, 24.03, 25.17, 27.46],
  ['Forklift / Telehandler Operative', 10, 0.65, 15.45, 22.72, 23.86, 24.99, 27.27],
  ['Banksmen', 10, 0.65, 15.45, 22.72, 23.86, 24.99, 27.27],
];

/** Euros. */
const ILW: Row[] = [
  ['HVM Supervisor', 1, 1.08, 25.66, 37.74, 39.62, 41.51, 45.28],
  ['Operations Manager (including Per Diems)', 2, 1.02, 24.26, 35.68, 37.46, 39.25, 42.81],
  ['Operations Manager (no expenses TBC)', 2, 0.97, 23.09, 33.96, 35.66, 37.36, 40.75],
  ['HVM Marshall', 3, 0.88, 20.99, 30.87, 32.42, 33.96, 37.05],
  ['Site Crew Chief', 4, 0.74, 17.49, 25.73, 27.02, 28.3, 30.87],
  ['Traffic Manager', 4, 0.74, 17.49, 25.73, 27.02, 28.3, 30.87],
  ['Car Park Manager', 4, 0.74, 17.49, 25.73, 27.02, 28.3, 30.87],
  ['Bag Drop Manager', 4, 0.74, 17.49, 25.73, 27.02, 28.3, 30.87],
  ['Event Manager / Site Manager', 5, 0.73, 17.26, 25.39, 26.66, 27.92, 30.46],
  ['SIA Security Supervisor', 5, 0.73, 17.26, 25.39, 26.66, 27.92, 30.46],
  ['Event Supervisor', 6, 0.69, 16.33, 24.01, 25.21, 26.42, 28.82],
  ['SIA Security DS', 6, 0.69, 16.33, 24.01, 25.21, 26.42, 28.82],
  ['Cash Manager', 6, 0.69, 16.33, 24.01, 25.21, 26.42, 28.82],
  ['Traffic Supervisor', 7, 0.66, 15.75, 23.16, 24.31, 25.47, 27.79],
  ['Car Park Supervisor', 7, 0.66, 15.75, 23.16, 24.31, 25.47, 27.79],
  ['Bag Drop Supervisor', 7, 0.66, 15.75, 23.16, 24.31, 25.47, 27.79],
  ['Site Admin Coordinator', 8, 0.65, 15.51, 22.81, 23.95, 25.09, 27.38],
  ['Crowd Safety Steward', 8, 0.65, 15.51, 22.81, 23.95, 25.09, 27.38],
  ['Site Crew', 9, 0.63, 14.93, 21.96, 23.05, 24.15, 26.35],
  ['Cashiers', 9, 0.63, 14.93, 21.96, 23.05, 24.15, 26.35],
  ['Traffic / Road Closure Steward', 9, 0.63, 14.93, 21.96, 23.05, 24.15, 26.35],
  ['Car Park Steward', 9, 0.63, 14.93, 21.96, 23.05, 24.15, 26.35],
  ['Ticket Seller / Checker', 9, 0.63, 14.93, 21.96, 23.05, 24.15, 26.35],
  ['Bag Drop Cashier', 9, 0.63, 14.93, 21.96, 23.05, 24.15, 26.35],
  ['Bag Drop Runner', 9, 0.63, 14.93, 21.96, 23.05, 24.15, 26.35],
  ['Forklift / Telehandler Operative', 10, 0.62, 14.82, 21.8, 22.89, 23.98, 26.16],
  ['Banksmen', 10, 0.62, 14.82, 21.8, 22.89, 23.98, 26.16],
];

/** The sheet's order of preference: the real Living Wage card is the primary one. */
export const LABOUR_ORDER: LabourFw[] = ['rlw', 'nlw', 'llw', 'ilw'];
const BLOCKS: Record<LabourFw, Row[]> = { rlw: RLW, nlw: NLW, llw: LLW, ilw: ILW };

export interface LabourRole {
  /** The charge id this role is quoted from. */
  id: string;
  code: string;
  name: string;
  /** Only the frameworks whose card lists the role. */
  rates: Partial<Record<LabourFw, LabourRate>>;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Every role on any of the four cards, once, in the order the sheet first names it. */
export const LABOUR_ROLES: LabourRole[] = (() => {
  const byName = new Map<string, LabourRole>();
  LABOUR_ORDER.forEach((fw) => {
    BLOCKS[fw].forEach(([name, category, uplift, pay, cost, a, b, c]) => {
      let role = byName.get(name);
      if (!role) {
        role = { id: `ch-lb-${slug(name)}`, code: `LB-${String(byName.size + 1).padStart(2, '0')}`, name, rates: {} };
        byName.set(name, role);
      }
      role.rates[fw] = { category, uplift, pay, cost, a, b, c };
    });
  });
  return [...byName.values()];
})();

/** The rate the charge row itself carries: the primary card that lists the role. */
export const homeRate = (role: LabourRole): { fw: LabourFw; rate: LabourRate } => {
  const fw = LABOUR_ORDER.find((f) => role.rates[f])!;
  return { fw, rate: role.rates[fw]! };
};

/** Which sheet column each of the app's three rate cards reads. */
export const CARD_COLUMN: Record<string, 'a' | 'b' | 'c'> = { preferred: 'a', standard: 'b', premium: 'c' };
export const CARD_RATE_NAME: Record<string, string> = { preferred: 'Rate A', standard: 'Rate B', premium: 'Rate C' };

export const LABOUR_SOURCE = '2027 Rate Card — Labour';
