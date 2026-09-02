/* ============================================================================
   CLIENT RECORD — the account, on a page of its own
   ----------------------------------------------------------------------------
   Clicking a client used to open a 580px modal with three tabs in it. That was
   fine while a client was a name, a code and a list of tags. It stopped being
   fine the moment the account started carrying things you have to READ against
   each other — what they pay, what they have signed, what expires next month,
   what they have on with us right now. A modal is a place to answer one
   question and leave; this is a place to look something up.

   So it is a route, `/clients/:id`, which also buys the three things a modal
   structurally cannot:

     · a URL. "Send me the Jockey Club's record" is now a link, not a
       description of which list to scroll.
     · a back button that means what it says.
     · room for the rate table, which is 40 rows wide and was never going to
       fit beside a postcode field.

   The register still deep-links in with `?id=`; that now redirects here rather
   than opening a dialog over the list, so there is one way to see a client and
   not two that drift.
   ========================================================================== */

import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { Breadcrumb, EmptyState, Kpi, Pill } from '@/components/primitives';
import { ConfirmDestructive, MenuButton, Modal } from '@/components/Modal';
import { StagePill } from '@/components/wof-ui';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX } from '@/lib/status';
import { countLabel, fmtRange, money } from '@/lib/format';
import { coverageTone, eventCoverage } from '@/lib/coverage';
import {
  CLIENT_DEPARTMENTS, CLIENT_REGIONS, CLIENT_TYPES, EMPLOYEES, EVENTS, MANAGERS,
  SERVICE_TYPES, TAGS, client as clientById, manager as managerById,
} from '@/data/db';
import type { Client } from '@/data/types';
import * as CLIENT_STORE from '@/lib/clients';
import * as FILES from '@/lib/clientfiles';
import * as RATES from '@/lib/rates';
import * as ROLES from '@/lib/roles';
import * as W from '@/lib/wof';
import { useClientDocsVersion, useClientsVersion, useRatesVersion, useWofVersion } from '@/lib/useStore';
import RatesTab from './client/RatesTab';
import DocumentsTab from './client/DocumentsTab';

type Tab = 'details' | 'requirements' | 'rates' | 'documents' | 'work';

const TAB_IDS: Tab[] = ['details', 'requirements', 'rates', 'documents', 'work'];

export default function ClientDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  useClientsVersion();
  useRatesVersion();
  useClientDocsVersion();
  useWofVersion();

  const asked = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(asked && TAB_IDS.includes(asked) ? asked : 'details');
  const [deleting, setDeleting] = useState(false);

  const c = clientById(id);
  // A deleted or mistyped id is a dead end, not a blank page pretending to be
  // a record. Back to the register, which can at least be searched.
  if (!c) return <Navigate to="/clients" replace />;

  const jobs = W.all().filter((w) => w.clientId === c.id);
  const live = jobs.filter((w) => !W.isTerminal(w.stage));
  const events = EVENTS.filter((e) => e.clientId === c.id);
  const docs = FILES.forClient(c.id);
  const chase = FILES.needsAttention(c.id);
  const card = RATES.clientCard(c.id);
  const agreed = RATES.clientPrices(c.id).length;
  const stale = RATES.staleAgreements(c.id).length;
  const owner = managerById(c.clientManagerId);
  const codeIssue = CLIENT_STORE.codeIssue(c);

  const go = (t: Tab) => {
    setTab(t);
    // The tab is in the URL so a link can point at the rates, not just at the
    // client. Replaced rather than pushed: five tabs should not mean five
    // presses of Back to leave one screen.
    setParams(t === 'details' ? {} : { tab: t }, { replace: true });
  };

  return (
    <>
      <Breadcrumb trail={[{ label: 'Clients', to: '/clients' }, { label: c.name }]} />

      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold text-ink leading-tight flex items-center gap-2.5">
            {c.name}
            <Pill status={c.status} />
          </h1>
          <div className="text-[13px] text-ink-3 mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-mono">{c.code || 'No code'}</span>
            {/* The register flags junk codes inline; the record has to say the
                same thing, or opening the account is how you lose the warning. */}
            {codeIssue ? (
              <span
                className="pill tip"
                tabIndex={0}
                data-tip={codeIssue}
                style={{ background: TONE_BG.atRisk, color: TONE_HEX.atRisk }}
              >
                check
              </span>
            ) : null}
            {c.clientType ? <span>· {c.clientType}</span> : null}
            {c.department ? <span>· {c.department}</span> : null}
            <span>· {owner ? `Managed by ${owner.name}` : 'No client manager'}</span>
            {c.email ? (
              <a href={`mailto:${c.email}`} className="text-accent no-underline hover:underline">
                · {c.email}
              </a>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => navigate(`/events?client=${c.id}`)}>
            <Icon name="events" decorative /> Their events
          </button>
          <MenuButton
            label={`Actions for ${c.name}`}
            items={[
              { label: 'Agree a rate', icon: 'trendUp', onSelect: () => go('rates') },
              { label: 'File a document', icon: 'fileText', onSelect: () => go('documents') },
              '-',
              {
                label: c.status === 'active' ? 'Deactivate client' : 'Reactivate client',
                icon: c.status === 'active' ? 'ban' : 'checkCircle',
                disabled: !ROLES.can('clients.edit'),
                hint: ROLES.denial('clients.edit') || undefined,
                onSelect: () => {
                  const to = c.status === 'active' ? 'inactive' : 'active';
                  const r = CLIENT_STORE.updateClient(c.id, { status: to });
                  if (r.ok)
                    toast(`${c.name} ${to === 'active' ? 'reactivated' : 'deactivated'}.`, {
                      tone: to === 'active' ? 'healthy' : 'neutral',
                    });
                },
              },
              {
                label: 'Delete client',
                icon: 'trash',
                danger: true,
                disabled: !ROLES.can('clients.edit'),
                hint: ROLES.denial('clients.edit') || undefined,
                onSelect: () => setDeleting(true),
              },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-5">
        <Kpi
          label="Live work"
          value={String(live.length)}
          sub={live.length ? money(live.reduce((s, w) => s + W.contractValue(w), 0)) : 'nothing on'}
          tone={live.length ? 'info' : 'neutral'}
        />
        <Kpi label="Events booked" value={String(events.length)} sub="in the staffing tool" tone="neutral" />
        <Kpi
          label="Rate card"
          value={card.label}
          sub={agreed ? `${countLabel(agreed, 'price')} agreed on top` : 'no agreed prices'}
          tone={stale ? 'atRisk' : 'neutral'}
        />
        <Kpi
          label="Documents"
          value={String(docs.length)}
          sub={chase.length ? `${chase.length} need attention` : docs.length ? 'all in date' : 'none filed'}
          tone={chase.length ? 'atRisk' : docs.length ? 'healthy' : 'neutral'}
        />
      </div>

      <div className="tabs mb-5" role="tablist">
        {(
          [
            ['details', 'Details'],
            ['requirements', `Requirements${c.tags.length ? ` (${c.tags.length})` : ''}`],
            ['rates', `Rates${agreed ? ` (${agreed})` : ''}`],
            ['documents', `Documents${docs.length ? ` (${docs.length})` : ''}`],
            ['work', `Work & events (${jobs.length + events.length})`],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === k}
            onClick={() => go(k)}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === 'details' ? <DetailsTab c={c} /> : null}
      {tab === 'requirements' ? <RequirementsTab c={c} /> : null}
      {tab === 'rates' ? <RatesTab c={c} onSaved={() => undefined} /> : null}
      {tab === 'documents' ? <DocumentsTab c={c} /> : null}
      {tab === 'work' ? <WorkTab c={c} /> : null}

      {deleting ? (
        <DeleteClient
          c={c}
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            const name = c.name;
            CLIENT_STORE.removeClient(c.id);
            navigate('/clients');
            toast(`${name} deleted.`, { tone: 'neutral' });
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ details */

function DetailsTab({ c }: { c: Client }) {
  const toast = useToast();
  const [name, setName] = useState(c.name);
  const [code, setCode] = useState(c.code);
  const [email, setEmail] = useState(c.email);
  const [status, setStatus] = useState(c.status);
  const [managerId, setManagerId] = useState(c.clientManagerId ?? '');
  const [department, setDepartment] = useState(c.department ?? '');
  const [clientType, setClientType] = useState(c.clientType ?? '');
  const [services, setServices] = useState<string[]>(c.serviceTypes ?? []);
  const [contactName, setContactName] = useState(c.contact ?? '');
  const [mobile, setMobile] = useState(c.mobile ?? '');
  const [landline, setLandline] = useState(c.landline ?? '');
  const [website, setWebsite] = useState(c.website ?? '');
  const [address, setAddress] = useState(c.address ?? '');
  const [address2, setAddress2] = useState(c.address2 ?? '');
  const [city, setCity] = useState(c.city ?? '');
  const [region, setRegion] = useState(c.region ?? '');
  const [postcode, setPostcode] = useState(c.postcode ?? '');
  const [notes, setNotes] = useState(c.notes ?? '');
  const [touched, setTouched] = useState(false);

  const nameError = touched ? CLIENT_STORE.validateName(name, c.id) : null;
  const codeError = touched ? CLIENT_STORE.validateCode(code, c.id) : null;
  // An account that predates the required-email rule is not made unsaveable by
  // it; an edit only has to leave what is there valid.
  const emailError = touched ? CLIENT_STORE.validateEmail(email) : null;
  const websiteError = touched ? CLIENT_STORE.validateWebsite(website) : null;
  const postcodeError = touched ? CLIENT_STORE.validatePostcode(postcode) : null;
  const issue = CLIENT_STORE.codeIssue(c);

  const save = () => {
    setTouched(true);
    const r = CLIENT_STORE.updateClient(c.id, {
      name, code, email, status,
      clientManagerId: managerId || null,
      department: department || null,
      clientType: clientType || null,
      serviceTypes: services,
      contact: contactName.trim() || null,
      mobile: mobile.trim() || null,
      landline: landline.trim() || null,
      website: website.trim() || null,
      address: address.trim() || null,
      address2: address2.trim() || null,
      city: city.trim() || null,
      region: region || null,
      postcode: postcode.trim() || null,
      notes: notes.trim() || null,
    });
    toast(
      r.ok ? `${name} saved.` : 'Nothing was saved — the fields marked in red need fixing first.',
      { tone: r.ok ? 'healthy' : 'critical' },
    );
  };

  const err = (msg: string | null) =>
    msg ? <span className="block text-[11.5px] text-status-critical mt-1">{msg}</span> : null;

  return (
    <div className="card p-5">
      <div className="grid gap-3.5" style={{ maxWidth: 720 }}>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Client name</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
            {err(nameError)}
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Client manager</span>
            <select className="field" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">Unassigned</option>
              {MANAGERS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.role}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Department</span>
            <select className="field" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">Not set</option>
              {CLIENT_DEPARTMENTS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Type</span>
            <select className="field" value={clientType} onChange={(e) => setClientType(e.target.value)}>
              <option value="">Not set</option>
              {CLIENT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Code</span>
            <input
              className="field font-mono"
              value={code}
              maxLength={5}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <span
              className="block text-[11.5px] mt-1 text-ink-3"
              style={
                codeError ? { color: TONE_HEX.critical } : issue ? { color: TONE_HEX.atRisk } : undefined
              }
            >
              {codeError ?? issue ?? '2–5 uppercase letters, unique.'}
            </span>
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Status</span>
            <select
              className="field"
              value={status}
              onChange={(e) => setStatus(e.target.value as Client['status'])}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        </div>

        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-1">
            Service types
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {SERVICE_TYPES.map((s) => (
              <label
                key={s.id}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-surface-hover cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={services.includes(s.id)}
                  onChange={(e) =>
                    setServices((list) => (e.target.checked ? [...list, s.id] : list.filter((x) => x !== s.id)))
                  }
                />
                <span className="text-[13px] text-ink">{s.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-1">Contact</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Main contact</span>
            <input
              className="field"
              placeholder="Not set"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Email</span>
            <input
              className="field"
              type="email"
              value={email}
              placeholder="Not set"
              onChange={(e) => setEmail(e.target.value)}
            />
            {err(emailError)}
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Mobile</span>
            <input
              className="field"
              type="tel"
              placeholder="Not set"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Landline</span>
            <input
              className="field"
              type="tel"
              placeholder="Not set"
              value={landline}
              onChange={(e) => setLandline(e.target.value)}
            />
          </label>
        </div>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Website</span>
          <input
            className="field"
            placeholder="Not set"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
          {err(websiteError)}
        </label>

        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-1">Address</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Address line 1</span>
            <input
              className="field"
              placeholder="Building and street"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Address line 2</span>
            <input className="field" value={address2} onChange={(e) => setAddress2(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">City</span>
            <input className="field" value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Province/Region</span>
            <select className="field" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">Not set</option>
              {CLIENT_REGIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Postal code</span>
            <input
              className="field"
              value={postcode}
              onChange={(e) => setPostcode(e.target.value.toUpperCase())}
            />
            {err(postcodeError)}
          </label>
        </div>

        <label className="block">
          <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Notes</span>
          <textarea
            className="field"
            rows={3}
            placeholder="Not set"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <div className="flex justify-end pt-1">
          <button type="button" className="btn btn-primary" {...ROLES.gate('clients.edit')} onClick={save}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- requirements */

function RequirementsTab({ c }: { c: Client }) {
  const toast = useToast();
  const [tags, setTags] = useState<string[]>(c.tags);
  const dirty = tags.length !== c.tags.length || tags.some((t) => !c.tags.includes(t));

  return (
    <div className="card p-5" style={{ maxWidth: 720 }}>
      <p className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        Default requirements apply to <strong>every event {c.name} books</strong>. Only staff holding all of
        them can be assigned or receive a callout. Individual events can add more on top.
      </p>
      <div className="grid gap-1.5">
        {TAGS.map((t) => (
          <label
            key={t.id}
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-hover cursor-pointer"
          >
            <input
              type="checkbox"
              checked={tags.includes(t.id)}
              onChange={(e) =>
                setTags((list) => (e.target.checked ? [...list, t.id] : list.filter((x) => x !== t.id)))
              }
            />
            <span className="text-[13.5px] text-ink flex-1">{t.label}</span>
            <span className="text-[11.5px] text-ink-3">
              {EMPLOYEES.filter((e) => e.tags.includes(t.id)).length} staff hold this
            </span>
          </label>
        ))}
      </div>
      <div className="flex justify-end pt-4">
        <button
          type="button"
          className="btn btn-primary"
          {...ROLES.gate('clients.edit')}
          disabled={!dirty || !ROLES.can('clients.edit')}
          onClick={() => {
            const r = CLIENT_STORE.updateClient(c.id, { tags });
            if (r.ok) toast(`Requirements saved for ${c.name}.`, { tone: 'healthy' });
          }}
        >
          Save requirements
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the work */

function WorkTab({ c }: { c: Client }) {
  const jobs = W.all()
    .filter((w) => w.clientId === c.id)
    .sort((a, b) => +new Date(b.start) - +new Date(a.start));
  const events = EVENTS.filter((e) => e.clientId === c.id);

  return (
    <>
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Work orders</div>
      {jobs.length ? (
        <table className="tbl mb-6">
          <thead>
            <tr>
              <th>Job</th>
              <th>Stage</th>
              <th>Dates</th>
              <th style={{ textAlign: 'right' }}>Contract value</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link to={`/wofs/${w.id}`} className="text-[13.5px] text-ink no-underline hover:underline">
                    {w.title}
                  </Link>
                  <div className="text-[11.5px] text-ink-3 font-mono">{w.ref || w.id}</div>
                </td>
                <td>
                  <StagePill wof={w} />
                </td>
                <td className="text-[12.5px] text-ink-2">{fmtRange(w.start, w.end)}</td>
                <td style={{ textAlign: 'right' }} className="tabular-nums text-ink">
                  {money(W.contractValue(w))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="mb-6">
          <EmptyState title="No work orders" body="Nothing has been quoted for this account yet." />
        </div>
      )}

      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2">Events</div>
      {events.length ? (
        <div className="grid gap-1.5">
          {events.map((e) => {
            const cov = eventCoverage(e);
            const tone = coverageTone(cov, e.start, e.end);
            return (
              <Link
                key={e.id}
                to={`/events/${e.id}`}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-line-soft no-underline hover:border-surface-line"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] text-ink truncate">{e.name}</span>
                  <span className="block text-[11.5px] text-ink-3">
                    {fmtRange(e.start, e.end, e.allDay)}
                  </span>
                </span>
                <span className="text-[13px] font-bold tabular-nums" style={{ color: TONE_HEX[tone] }}>
                  {cov.filled}/{cov.required}
                </span>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No events booked" body="Nothing for this client is in the staffing tool." />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ delete */
/*
   Unchanged in substance from the register's version, and deliberately so: the
   rule that live work cannot be orphaned belongs to the act, not to the screen
   the act was started from.
*/

function DeleteClient({ c, onClose, onConfirm }: { c: Client; onClose: () => void; onConfirm: () => void }) {
  const { events, wofs, live } = CLIENT_STORE.clientCommitments(c.id);

  if (live > 0) {
    return (
      <Modal
        title={`Cannot delete “${c.name}”`}
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Close
          </button>
        }
      >
        <p className="text-[13.5px] text-ink-2 leading-relaxed">
          They have <strong className="text-ink">{countLabel(live, 'live work order')}</strong> on the go
          {events ? ` and ${countLabel(events, 'event')} in the staffing tool` : ''}. Deleting the account
          would leave that work pointing at nothing.
        </p>
        <p className="text-[13px] text-ink-2 leading-relaxed mt-3">
          Close or complete the jobs first. If you only want to stop new work coming in, set the account to{' '}
          <strong className="text-ink">Inactive</strong> instead — it keeps the history and takes them out of
          the client picker.
        </p>
      </Modal>
    );
  }

  return (
    <ConfirmDestructive
      title={`Delete “${c.name}”?`}
      confirmLabel="Delete client"
      typeToConfirm={c.name}
      onClose={onClose}
      onConfirm={onConfirm}
      message={
        wofs ? (
          <>
            This client has <strong>{countLabel(wofs, 'closed work order')}</strong> on record. Deleting
            removes the account; the history stays but will no longer name them. This cannot be undone.
          </>
        ) : (
          'This permanently removes the client record, its rate agreements and its documents. This cannot be undone.'
        )
      }
    />
  );
}
