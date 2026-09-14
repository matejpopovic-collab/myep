/* ============================================================================
   EPROSTA — the quote document
   ----------------------------------------------------------------------------
   One version in, one printable page out. Nothing here reads the live job for
   money or lines: everything on the page comes from the frozen snapshot in
   `QuoteVersion`, which is what makes an old document still print what it said
   at the time rather than what the job says today.

   Why HTML and the browser's own Save as PDF, rather than a PDF library:

     · The same markup is the on-screen preview and the printed page, so there
       is one layout to get right instead of two that drift.
     · No 200KB dependency, and no second implementation of the letterhead.
     · A stored PDF and a live record are two accounts of one quote that can
       disagree. Rendering on demand means there is only ever one account.

   What is NOT on this page, deliberately: cost and margin. The internal quote
   table shows both because EP Team needs them. A document that can reach the
   client shows what the client is being charged and nothing about what it
   costs to deliver.
   ========================================================================== */

import { addDays, fmtDateFull, fmtRange, money } from './format';
import { client as clientById, jobType, manager as managerById } from '@/data/db';
import { clientAddress } from './clients';
import * as W from './wof';

/** Who the copy is for. It decides which versions may appear on the trail. */
export type Audience = 'ep' | 'client';

/** UK standard rate. One place, so the document and any future invoice agree. */
export const VAT_RATE = 0.2;

/** How long a quote is held at its figures. */
const VALID_DAYS = 30;

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const vat = (net: number): number => Math.round(net * VAT_RATE * 100) / 100;

/* --------------------------------------------------------------- the page -- */

const CSS = `
  @page { size: A4; margin: 0; }
  :root {
    --ink: #14161c; --ink-2: #40454f; --ink-3: #767d8a;
    --line: #dcdfe6; --line-2: #eef0f4;
    --accent: #4338ca; --accent-bg: #eef0fe; --wash: #f7f8fa;
  }
  * { box-sizing: border-box; min-width: 0; }
  body {
    margin: 0;
    font-family: "Helvetica Neue", Helvetica, Arial, "Segoe UI", system-ui, sans-serif;
    font-size: 9.4pt; line-height: 1.42; color: var(--ink-2); background: #fff;
    -webkit-font-smoothing: antialiased;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet {
    position: relative; display: flex; flex-direction: column;
    width: 210mm; height: 297mm; padding: 13mm 15mm 11mm;
    overflow: hidden; background: #fff;
  }
  .sheet + .sheet { page-break-before: always; break-before: page; }
  /* The history sheet grows with the trail. A job with twenty versions has to
     spill onto a third page rather than lose the last eight rows to a clip —
     a truncated audit trail is worse than none, because
     it looks complete. */
  .sheet.flow { height: auto; min-height: 297mm; overflow: visible; }
  /* On the flowing sheet the small print follows the trail rather than being
     pushed to the bottom of a fixed page: a footer held down by an auto top
     margin, on a sheet that is one line too tall, throws itself onto a page of
     its own, which is how you get a blank third page with a sentence on it. */
  .sheet.flow .pagefoot { margin-top: 6mm; }
  .tail { break-inside: avoid; page-break-inside: avoid; }
  .history tr { break-inside: avoid; page-break-inside: avoid; }
  /* Nothing on a sheet may be squashed to make the page fit. Without this the
     flex column shrinks its own children when the content runs long, and the
     first thing to collapse is the meta strip — silently, and only in print. */
  .sheet > * { flex-shrink: 0; }
  @media screen {
    html { background: #6b7280; }
    body { padding: 0 0 18px; }
    .sheet { margin: 0 auto 18px; box-shadow: 0 2px 18px rgba(0,0,0,.28); }
  }
  /* Screen-only bar, so the person who opened this does not have to guess how
     to turn it into a file. */
  .bar {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 10px 16px; margin-bottom: 18px;
    background: #14161c; color: #e7e9ee; font-size: 12.5px;
  }
  .bar button {
    font: inherit; font-weight: 600; cursor: pointer;
    padding: 6px 14px; border-radius: 6px; border: 0;
    background: #4f46e5; color: #fff;
  }
  @media print { .bar { display: none; } }

  h2 { margin: 0; }
  p { margin: 0 0 6pt; }
  strong { color: var(--ink); font-weight: 600; }
  .muted { color: var(--ink-3); }
  .tnum { font-variant-numeric: tabular-nums; }
  .fill { color: #9aa1ad; border-bottom: 1px dashed #c3c8d2; padding-bottom: .5pt; }

  .masthead {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 14mm;
    padding-bottom: 4mm; border-bottom: 2px solid var(--accent);
  }
  .brand { display: flex; align-items: center; gap: 3.2mm; }
  .brand .mark {
    width: 13mm; height: 13mm; border-radius: 2.4mm; background: var(--accent); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 13pt; font-weight: 700;
  }
  .brand .name { font-size: 15pt; font-weight: 700; color: var(--ink); line-height: 1.1; }
  .brand .tagline { font-size: 8.2pt; color: var(--ink-3); margin-top: 1pt; }
  .doc-title {
    text-align: right; font-size: 16pt; font-weight: 700; color: var(--ink);
    letter-spacing: .6pt; text-transform: uppercase; line-height: 1;
  }
  .doc-sub { text-align: right; font-size: 8.4pt; color: var(--ink-3); margin-top: 2.4mm; }

  .meta {
    display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 5mm;
    border: 1px solid var(--line); border-radius: 1.6mm; overflow: hidden;
  }
  .meta > div { padding: 3mm 3.4mm; border-right: 1px solid var(--line-2); }
  .meta > div:last-child { border-right: 0; }
  .meta dt {
    font-size: 7.2pt; text-transform: uppercase; letter-spacing: .6pt;
    color: var(--ink-3); margin-bottom: 1.2mm;
  }
  .meta dd { margin: 0; font-size: 10pt; font-weight: 600; color: var(--ink); }
  .meta .note { font-size: 7.6pt; font-weight: 400; color: var(--ink-3); margin-top: .8mm; }

  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 5mm; }
  .panel-label {
    font-size: 7.4pt; text-transform: uppercase; letter-spacing: .7pt;
    color: var(--ink-3); font-weight: 600; margin-bottom: 2mm;
  }
  .panel .who { font-size: 11pt; font-weight: 700; color: var(--ink); margin-bottom: 1mm; }
  .panel .row { font-size: 9pt; }
  .panel .row + .row { margin-top: .6mm; }

  h2.section {
    font-size: 8pt; text-transform: uppercase; letter-spacing: .8pt;
    color: var(--ink-3); font-weight: 600; margin: 5.5mm 0 2.4mm;
  }
  table { width: 100%; border-collapse: collapse; }
  .lines th {
    font-size: 7.4pt; text-transform: uppercase; letter-spacing: .6pt; color: var(--ink-3);
    font-weight: 600; text-align: left; padding: 0 3mm 2mm 0; border-bottom: 1px solid var(--line);
  }
  .lines th.r, .lines td.r { text-align: right; padding-right: 0; }
  .lines td { padding: 2.8mm 3mm 2.8mm 0; border-bottom: 1px solid var(--line-2); vertical-align: top; }
  .lines td.r { white-space: nowrap; }
  .lines .desc { font-size: 10pt; font-weight: 600; color: var(--ink); }
  .lines .sub { font-size: 8.2pt; color: var(--ink-3); margin-top: 1mm; }
  .lines .val { font-size: 10.5pt; font-weight: 700; color: var(--ink); }
  .lines .was { font-size: 8pt; color: var(--ink-3); }
  /* Grouping bands. The client's own planning sheet reads area-first, so the
     document they are asked to sign does too. */
  .lines tr.grp td {
    padding: 4.5mm 0 1.5mm;
    font-size: 8.2pt; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--ink-2); border-bottom: 1px solid var(--line);
  }
  .lines tr.grp-sub td {
    padding: 2mm 0 1mm;
    font-size: 8.6pt; font-weight: 600; color: var(--ink-3); border-bottom: none;
  }

  .foot { display: flex; justify-content: space-between; gap: 10mm; margin-top: 4mm; }
  .foot .count { font-size: 8.4pt; color: var(--ink-3); padding-top: 1mm; }
  .totals { width: 82mm; }
  .totals .t { display: flex; justify-content: space-between; padding: 1.6mm 0; font-size: 9.4pt; }
  .totals .t + .t { border-top: 1px solid var(--line-2); }
  .totals .t.grand {
    border-top: 1.6pt solid var(--ink); margin-top: 1mm; padding-top: 2.4mm;
    font-size: 12pt; font-weight: 700; color: var(--ink);
  }

  .callout {
    margin-top: 5mm; padding: 3.6mm 4mm; background: var(--accent-bg);
    border: 1px solid #d9dcfb; border-radius: 1.6mm; font-size: 9pt;
  }
  .callout .h { font-weight: 700; color: var(--ink); margin-bottom: 1.2mm; }
  .stamp {
    margin-top: 5mm; padding: 3.6mm 4mm; border: 1px solid var(--line);
    border-left: 2.4mm solid var(--accent); border-radius: 1.6mm;
    background: var(--wash); font-size: 9pt;
  }
  .accept { margin-top: 5mm; padding-top: 3.5mm; border-top: 1px solid var(--line); }
  .sigs { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 3.5mm; }
  .sig .rule { border-bottom: 1px solid var(--ink-3); height: 10mm; }
  .sig .cap { font-size: 7.6pt; color: var(--ink-3); margin-top: 1.6mm; }
  .sig .who { font-size: 8.6pt; font-weight: 600; color: var(--ink); margin-bottom: 2mm; }

  .history th {
    font-size: 7.4pt; text-transform: uppercase; letter-spacing: .6pt; color: var(--ink-3);
    font-weight: 600; text-align: left; padding: 0 3mm 2mm 0; border-bottom: 1px solid var(--line);
  }
  .history td {
    padding: 2.4mm 3mm 2.4mm 0; border-bottom: 1px solid var(--line-2);
    vertical-align: top; font-size: 8.8pt;
  }
  .history th:last-child, .history td:last-child { padding-right: 0; }
  .history .v { font-weight: 700; color: var(--ink); font-size: 9.4pt; white-space: nowrap; }
  .history .money { font-weight: 600; color: var(--ink); white-space: nowrap; text-align: right; }
  .history .who { font-size: 8pt; color: var(--ink-3); margin-top: 1mm; }
  /* The amendments a single send carried. Indented under the headline that
     counts them, because the count is the summary and these are the detail. */
  .history .changes { margin: 1mm 0 0; padding-left: 3.6mm; }
  .history .changes li { margin-bottom: 0.6mm; }
  .history tr.current td { background: var(--accent-bg); }

  .tag {
    display: inline-block; padding: .6mm 1.8mm; border-radius: 1mm;
    font-size: 7.4pt; font-weight: 600; letter-spacing: .3pt; text-transform: uppercase;
    background: #e8eaef; color: #4b5261; white-space: nowrap;
  }
  .tag.issued { background: #e3f4ea; color: #1f6b41; }
  .tag.held { background: #fdecec; color: #9b2226; }
  .tag.queried { background: #fdf0e3; color: #8a4b12; }
  .tag.signed { background: #e6eefc; color: #234a9c; }

  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; margin-top: 2mm; }
  ul.terms { margin: 0; padding-left: 4.2mm; font-size: 8.8pt; }
  ul.terms li { margin-bottom: 1.6mm; }

  .pagefoot {
    margin-top: auto; padding-top: 4mm; border-top: 1px solid var(--line-2);
    display: flex; justify-content: space-between; gap: 8mm;
    font-size: 7.4pt; color: var(--ink-3);
  }
  .pagefoot .co { max-width: 120mm; }
`;

/* Bracketed rather than invented. A made-up VAT number on a document that can
   reach a client is worse than a visible gap. */
const COMPANY_FOOT =
  'EP Team · <span class="fill">[registered office]</span> · ' +
  'company no. <span class="fill">[00000000]</span> · ' +
  'VAT reg. <span class="fill">[GB 000 0000 00]</span>';

/* ------------------------------------------------------------- the parts -- */

/**
 * The priced lines, grouped the way the client's own planning sheet is: area,
 * then place and window, then the roles standing there - and then, once, at the
 * end, everything hired or supplied across the event as a whole.
 *
 * Two things the client's copy deliberately does NOT show.
 *
 * The COST column. Cost and margin are EP's business - see the note on the
 * internal quote table.
 *
 * The PER-DAY cells. The client is buying 22 Car Park Steward shifts at Lilley
 * Farm; which six days those fall on is operational detail, and putting it on
 * the signed document would mean a formal variation every time a steward moved
 * from the Friday to the Saturday. The day count is stated instead, which is
 * what the money actually depends on.
 */
function lineRows(v: W.QuoteVersion): string {
  /* Equipment and services are bought across the whole event, so they are
     banded together at the end rather than repeated inside every place they
     were ordered for. The place is not thrown away - it is printed as a
     sub-heading inside that band, so a client reading "12 x Two-way radio"
     can still see it was asked for because of Cross Roads.

     Split on the FROZEN kind, never on "has no window": a version frozen
     before this band existed carries no kind at all, and those documents are
     rendered exactly as they were sent. A quote the client is holding does not
     re-band itself because we changed our minds about headings. */
  const isItem = (l: W.VersionLine) => l.kind === 'kit' || l.kind === 'service';
  // And only where there is something to separate the equipment FROM. A quote
  // with no places on it has no bands at all, and a lone heading over the only
  // section a document has is a heading that says nothing.
  const banded = v.lines.some((l) => l.kind) && v.lines.some((l) => l.area);
  const staff = banded ? v.lines.filter((l) => !isItem(l)) : v.lines;
  const items = banded ? v.lines.filter(isItem) : [];

  const groups: { head: string | null; sub: string | null; lines: W.VersionLine[] }[] = [];
  // `undefined` rather than `null`, because `null` is a legitimate value here:
  // an ungrouped line has no area, and seeding the comparison with `null` meant
  // the FIRST line of a pre-deployment quote matched the initial state, opened
  // no group, and the next push read `groups[-1]`.
  let lastArea: string | null | undefined;
  let lastSub: string | null | undefined;

  staff.forEach((l) => {
    const area = l.area || null;
    const sub = l.area ? [l.place, l.window].filter(Boolean).join(' · ') || null : null;
    if (!groups.length || area !== lastArea || sub !== lastSub) {
      groups.push({ head: area !== lastArea ? area : null, sub, lines: [] });
      lastArea = area;
      lastSub = sub;
    }
    groups[groups.length - 1].lines.push(l);
  });

  // The equipment band. Its sub-headings are places, not windows: a radio has
  // no window, and one that had would be telling the client it works a shift.
  let lastWhere: string | null | undefined;
  items.forEach((l) => {
    const where = l.area ? [l.area, l.place].filter(Boolean).join(' · ') || null : null;
    const first = lastWhere === undefined;
    if (first || where !== lastWhere) {
      groups.push({ head: first ? ITEM_BAND : null, sub: where, lines: [] });
      lastWhere = where;
    }
    groups[groups.length - 1].lines.push(l);
  });

  return groups
    .map((g) => {
      const head = g.head
        ? `<tr class="grp"><td colspan="5">${esc(g.head)}</td></tr>`
        : '';
      const sub = g.sub ? `<tr class="grp-sub"><td colspan="5">${esc(g.sub)}</td></tr>` : '';
      return head + sub + g.lines.map(oneLine).join('');
    })
    .join('');
}

/** The one heading over everything hired or supplied for the event as a whole. */
const ITEM_BAND = 'Equipment and services — across the whole event';

function oneLine(l: W.VersionLine): string {
  const bits = [
    l.code ? `<span>${esc(l.code)}</span>` : '',
    l.pricedAt ? `rate card ${esc(fmtDateFull(l.pricedAt))}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  /* A deployed line sells SHIFTS of a fixed length, so it reads that way.
     Keyed on the WINDOW, not the area: kit placed on a car park carries an
     area and a place but no window, and it is bought by the item for a number
     of days. Reading it as shifts of so many hours each would tell the client
     forty barriers work a nine-hour day. */
  const deployed = !!l.window;
  const qtyLabel = deployed ? `${l.qty} shift${l.qty === 1 ? '' : 's'}` : String(l.qty);
  const unitLabel = deployed
    ? `${l.units} hour${l.units === 1 ? '' : 's'} each`
    : `${l.units} ${esc(l.unitLabel)}${l.units === 1 ? '' : 's'}`;

  return `
      <tr>
        <td>
          <div class="desc">${esc(l.description)}</div>
          ${bits ? `<div class="sub">${bits}</div>` : ''}
          ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}
          ${
            l.clientApproval
              ? `<div class="sub">Client: ${esc(
                  l.clientApproval === 'accepted'
                    ? 'accepted'
                    : l.clientApproval === 'queried'
                      ? 'queried'
                      : 'awaiting your decision',
                )}</div>`
              : ''
          }
        </td>
        <td class="r tnum">${esc(qtyLabel)}</td>
        <td class="r tnum">${unitLabel}</td>
        <td class="r tnum">${money(l.rate)}${
          l.standardRate != null
            ? `<div class="was">volume rate, from ${money(l.standardRate)}</div>`
            : ''
        }</td>
        <td class="r val tnum">${money(l.value)}</td>
      </tr>`;
}

/** How a version ended up, in one word. */
function statusOf(v: W.QuoteVersion): { tag: string; label: string; detail: string } {
  const sent = v.issuedAt || v.at;
  if (v.signedAt)
    return { tag: 'signed', label: 'Signed', detail: `Signed by the client ${fmtDateFull(v.signedAt)}.` };
  if (v.objection) {
    const asked = W.objectionRequests(v.objection);
    return {
      tag: 'queried',
      label: 'Queried',
      detail:
        `Sent ${fmtDateFull(sent)}. Sent back by ${esc(v.objection.byName)} ${fmtDateFull(v.objection.at)}` +
        (v.objection.note ? `: “${esc(v.objection.note)}”` : '') +
        /* The requests are listed, not counted. This sheet is the record of
           what the client asked for against a figure they were holding, and
           "and 3 items" is exactly the summary that lets one of them get lost
           between one version and the next. */
        (asked.length
          ? `. They said the quote was missing: ${asked
              .map((r) => `“${esc(r.text)}”`)
              .join('; ')}`
          : ''),
    };
  }
  return { tag: 'issued', label: 'Sent', detail: `Sent to the client ${fmtDateFull(sent)}.` };
}

function historyRows(w: W.Wof, v: W.QuoteVersion, _audience: Audience): string {
  const all = v.kind === 'variation' ? W.variationVersions(w) : W.quoteVersions(w);
  // Every version on the trail was sent, so both copies list the same ones.
  // The client's record of events and EP Team's are the same record.
  const seq = all.filter((x) => x.no <= v.no);

  return seq
    .map((x) => {
      const st = statusOf(x);
      // The headline is a count when several amendments went out together;
      // the amendments themselves are what the reader actually wants.
      const detail =
        x.changes && x.changes.length > 1
          ? `<ul class="changes">${x.changes.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>`
          : '';
      return `
      <tr${x.no === v.no ? ' class="current"' : ''}>
        <td class="v">${esc(x.label)}</td>
        <td>${esc(fmtDateFull(x.at))}</td>
        <td class="money tnum">${money(x.value)}</td>
        <td>
          ${esc(x.change)}${detail}
          <div class="who">By ${esc(x.byName)}</div>
        </td>
        <td>
          <span class="tag ${st.tag}">${st.label}</span>
          <div class="who">${st.detail}${x.no === v.no ? ' This document.' : ''}</div>
        </td>
      </tr>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- render -- */

export interface DocOptions {
  audience?: Audience;
}

/**
 * The whole document, as one self-contained HTML file.
 *
 * Takes the WOF for the things that are true of the job whatever the version —
 * the client, the venue, the dates — and the version for everything that can
 * change: lines, totals, who priced it, what it was worth.
 */
export function quoteDocumentHtml(w: W.Wof, v: W.QuoteVersion, opts: DocOptions = {}): string {
  const audience: Audience = opts.audience || 'ep';
  const isVar = v.kind === 'variation';
  const cl = clientById(w.clientId);
  const jt = jobType(w.jobTypeId);
  const ref = W.versionRef(w, v);

  const net = v.value;
  const tax = vat(net);
  const gross = Math.round((net + tax) * 100) / 100;

  const issued = v.issuedAt || v.at;
  const validUntil = addDays(issued, VALID_DAYS);
  const dep = W.deposit(w);
  const depositDue = Math.round(net * (dep.pct / 100) * 100) / 100;

  const seq = isVar ? W.variationVersions(w) : W.quoteVersions(w);
  const previousIssued = seq.filter((x) => x.no < v.no).slice(-1)[0] || null;

  const staffHours = v.lines
    .filter((l) => l.unitLabel === 'hour')
    .reduce((sum, l) => sum + l.qty * l.units, 0);

  const title = isVar ? 'Variation schedule' : 'Quotation';

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<title>${esc(ref)} — ${esc(cl ? cl.name : 'Client')}</title>
<style>${CSS}</style>
</head>
<body>

<div class="bar">
  <span>${esc(ref)} · ${esc(w.title)} · ${esc(cl ? cl.name : '')}${
    audience === 'client' ? '' : ' · EP Team copy'
  }</span>
  <button type="button" onclick="window.print()">Print / Save as PDF</button>
</div>

<article class="sheet">
  <header class="masthead">
    <div class="brand">
      <div class="mark">EP</div>
      <div>
        <div class="name">EP Team</div>
        <div class="tagline">Event staffing, stewarding and traffic management</div>
      </div>
    </div>
    <div>
      <div class="doc-title">${esc(title)}</div>
      <div class="doc-sub">
        ${esc(v.label)}${
          previousIssued
            ? ` · supersedes ${esc(previousIssued.label)} issued ${esc(fmtDateFull(previousIssued.issuedAt!))}`
            : ''
        }<br />
        ${
          previousIssued ? 'This document replaces all earlier versions.' : 'The first version of this document.'
        }
      </div>
    </div>
  </header>

  <dl class="meta">
    <div>
      <dt>${isVar ? 'Variation reference' : 'Quote reference'}</dt>
      <dd>${esc(ref)}</dd>
      <div class="note">Job ${esc(w.jobCode || w.ref)}</div>
    </div>
    <div>
      <dt>${v.issuedAt ? 'Issued' : 'Prepared'}</dt>
      <dd>${esc(fmtDateFull(issued))}</dd>
      <div class="note">By ${esc(v.byName)}</div>
    </div>
    <div>
      <dt>${isVar ? 'Invoiced' : 'Valid until'}</dt>
      <dd>${isVar ? 'With the job' : esc(fmtDateFull(validUntil))}</dd>
      <div class="note">${isVar ? 'Added to the final invoice' : `${VALID_DAYS} days from issue`}</div>
    </div>
    <div>
      <dt>Total inc. VAT</dt>
      <dd>${money(gross)}</dd>
      <div class="note">${money(net)} before VAT</div>
    </div>
  </dl>

  <section class="panels">
    <div class="panel">
      <div class="panel-label">${isVar ? 'Variation for' : 'Quotation for'}</div>
      <div class="who">${esc(cl ? cl.name : 'Client')}</div>
      ${cl && cl.email ? `<div class="row">${esc(cl.email)}</div>` : ''}
      <div class="row">${
        cl && clientAddress(cl) ? esc(clientAddress(cl)) : '<span class="fill">[client address]</span>'
      }</div>
      <div class="row muted">Account ${esc(cl ? cl.code : '—')} · payment terms ${
        cl ? cl.termsDays : 30
      } days</div>
    </div>
    <div class="panel">
      <div class="panel-label">The job</div>
      <div class="who">${esc(w.title)}</div>
      <div class="row">${esc(w.venue)}${w.postcode ? `, ${esc(w.postcode)}` : ''}</div>
      <div class="row">${esc(fmtRange(w.start, w.end))}</div>
      <div class="row muted">${esc(jt ? jt.label : w.jobTypeId)} · EP contact ${esc(
        managerById(w.ownerId)?.name || 'EP Team',
      )}</div>
    </div>
  </section>

  <h2 class="section">${isVar ? 'Variation lines' : 'Priced lines'}</h2>
  <table class="lines">
    <thead>
      <tr>
        <th style="width:47%">Line</th>
        <th class="r" style="width:9%">Qty</th>
        <th class="r" style="width:16%">Units each</th>
        <th class="r" style="width:14%">Rate</th>
        <th class="r" style="width:14%">Value</th>
      </tr>
    </thead>
    <tbody>${lineRows(v)}</tbody>
  </table>

  <div class="foot">
    <div class="count">
      ${v.lines.length} line${v.lines.length === 1 ? '' : 's'}${
        staffHours ? ` · ${staffHours.toLocaleString('en-GB')} staffed hours` : ''
      }
    </div>
    <div class="totals">
      <div class="t"><span>Subtotal</span><span class="tnum">${money(net)}</span></div>
      <div class="t"><span>VAT at ${VAT_RATE * 100}%</span><span class="tnum">${money(tax)}</span></div>
      <div class="t grand"><span>Total</span><span class="tnum">${money(gross)}</span></div>
    </div>
  </div>

  ${
    isVar
      ? `<div class="callout">
    <div class="h">How this is charged</div>
    These lines are additional to the quotation ${esc(
      w.signoff ? `signed on ${fmtDateFull(w.signoff.signedAt)}` : 'agreed for this job',
    )} and are invoiced with it. Each line is accepted or queried on its own — accepting one does not
    commit you to the others.
  </div>`
      : `<div class="callout">
    <div class="h">Deposit and payment</div>
    ${
      dep.pct > 0
        ? `A deposit of ${dep.pct}% — <strong>${money(
            depositDue,
          )}</strong> — is payable on acceptance and is deducted from the final invoice. The balance is`
        : 'The job is'
    } invoiced after the event on ${cl ? cl.termsDays : 30}-day terms. Rates are held at the figures above
    until ${esc(fmtDateFull(validUntil))}; after that date the quotation is repriced against the rate card
    in force.
  </div>`
  }

  ${
    isVar
      ? ''
      : `<section class="accept">
    <h2 class="section" style="margin-top:0">Acceptance</h2>
    <p>
      Signing below accepts the quantities, dates and rates set out in this version of the quotation.
      Changes made after acceptance are quoted as variations and invoiced in addition.
    </p>
    <div class="sigs">
      <div class="sig">
        <div class="who">For and on behalf of ${esc(cl ? cl.name : 'the client')}</div>
        <div class="rule"></div>
        <div class="cap">Signature · name in capitals · position · date</div>
      </div>
      <div class="sig">
        <div class="who">For and on behalf of EP Team</div>
        <div class="rule"></div>
        <div class="cap">Signature · name in capitals · position · date</div>
      </div>
    </div>
  </section>`
  }

  <footer class="pagefoot">
    <div class="co">${COMPANY_FOOT}</div>
    <div>${esc(ref)} · page 1</div>
  </footer>
</article>

<article class="sheet flow">
  <header class="masthead" style="border-bottom-width:1px; border-bottom-color:var(--line)">
    <div class="brand">
      <div class="mark">EP</div>
      <div>
        <div class="name">EP Team</div>
        <div class="tagline">${esc(w.jobCode || w.ref)} · ${esc(cl ? cl.name : '')} · ${esc(w.title)}</div>
      </div>
    </div>
    <div class="doc-sub" style="margin-top:2mm">
      ${esc(v.label)} · ${v.issuedAt ? `issued ${esc(fmtDateFull(v.issuedAt))}` : 'not issued'}<br />
      ${money(net)} before VAT
    </div>
  </header>

  ${
    isVar || audience === 'ep'
      ? ''
      : `<h2 class="section">What the rate covers</h2>
  <div class="two">
    <div>
      <div class="panel-label">Included</div>
      <ul class="terms">
        <li>Vetted staff, briefed to the client's site plan and signed on and off shift.</li>
        <li>Supervision at one supervisor to every ten staff, at no extra charge.</li>
        <li>EP-branded uniform, hi-vis and standard PPE.</li>
        <li>Travel and subsistence within the quoted region.</li>
      </ul>
    </div>
    <div>
      <div class="panel-label">Not included unless quoted as a line</div>
      <ul class="terms">
        <li>SIA-licensed door supervisors, response teams and dog units.</li>
        <li>Radios, repeaters and the Ofcom licence for the event.</li>
        <li>Crew transport, welfare units and on-site accommodation.</li>
        <li>Accreditation administration and pass production.</li>
      </ul>
    </div>
  </div>`
  }

  <h2 class="section">Version history</h2>
  <p class="muted" style="font-size:8.4pt; margin-bottom:2.4mm">
    Each time this quotation is sent it is kept exactly as it was sent, and given a version number.
    Every version listed below was issued to you; there are no others.
  </p>
  <table class="history">
    <thead>
      <tr>
        <th style="width:7%">Ver.</th>
        <th style="width:17%">Date</th>
        <th style="width:13%; text-align:right">Value</th>
        <th style="width:38%">What changed</th>
        <th style="width:25%">Status</th>
      </tr>
    </thead>
    <tbody>${historyRows(w, v, audience)}</tbody>
  </table>

  <div class="tail">
  ${
    v.approval
      ? `<div class="stamp">
    <div style="font-weight:700; color:var(--ink); margin-bottom:1.2mm">Approved for issue</div>
    ${esc(v.approval.byName)} — ${esc(fmtDateFull(v.approval.at))}, at ${money(v.approval.value)}.${
      // An approval covers its own figure and anything under it, so a version
      // that came down after the sign-off is still approved. Said out loud,
      // because a stamp reading £18,850 on a £16,050 quote otherwise looks
      // like a document quoting the wrong number.
      Math.round(v.approval.value * 100) !== Math.round(v.value * 100)
        ? ` This version comes to ${money(v.value)} and is covered by it.`
        : ''
    }
    ${
      // The rule behind the stamp is EP Team's business. The client is told the
      // figure was signed off; how the sign-off works is internal.
      audience === 'ep'
        ? `<span class="muted">
      A quotation over ${money(W.QUOTE_APPROVAL_THRESHOLD, {
        pence: false,
      })} is issued only after approval by a senior manager who did not price it. Raising the total above
      the approved figure withdraws that approval and the quotation is held again.
    </span>`
        : ''
    }
  </div>`
      : ''
  }

  <footer class="pagefoot">
    <div class="co">
      ${COMPANY_FOOT} · <span class="fill">[bank details for deposit payment]</span><br />
      ${esc(v.label)} of ${esc(w.jobCode || w.ref)}, produced from the job record on
      ${esc(fmtDateFull(new Date().toISOString()))}. Bracketed fields are placeholders.
    </div>
    <div>${esc(ref)} · version history</div>
  </footer>
  </div>
</article>

</body>
</html>`;
}

/**
 * Open the document in a new tab, where the browser's own Save as PDF turns it
 * into a file.
 *
 * A blob rather than a route: the document is one self-contained page with its
 * own print geometry, and giving it a URL inside the app would mean teaching
 * the router, the shell and the portal's tier guard about a page that is none
 * of their business.
 */
export function openQuoteDocument(w: W.Wof, v: W.QuoteVersion, opts: DocOptions = {}): boolean {
  const html = quoteDocumentHtml(w, v, opts);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const win = window.open(url, '_blank');
  // Revoked late: the tab needs the URL until it has finished loading, and a
  // blocked pop-up needs it never.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return !!win;
}
