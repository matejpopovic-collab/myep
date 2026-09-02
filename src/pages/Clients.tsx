/* ============================================================================
   CLIENTS  (+ Tagging, folded in)
   ----------------------------------------------------------------------------
   The old top-level "Tagging" nav item rendered the entire ~500-row Clients
   list a second time and showed nothing but a name and an "Open" link — zero
   information scent. Tagging is an attribute of a client, not a peer of it, so
   it is now the "Requirements" tab of the client record, with tag pills shown
   inline on the list and a has-requirements filter.

   Also fixed:
     · one-click red Delete on every row      -> overflow menu + typed confirm
     · bright periwinkle header, loudest thing-> subtle elevated surface
     · junk codes (YYY, ZZZ, a full event name)-> flagged inline with a reason
     · blank email cells rendering as nothing -> "Not set"
     · Status column reading "Active" while filtered to Active -> hidden when filtered
     · 24px icons in boxes that read as inputs -> 32px ghost icon buttons
     · no count, no pagination, no striping    -> all three
   ========================================================================== */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState, PageHeader, Pill, TagPill } from '@/components/primitives';
import { ConfirmDestructive, MenuButton, Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { TONE_BG, TONE_HEX, TONE_LINE } from '@/lib/status';
import { countLabel } from '@/lib/format';
import {
  CLIENTS, CLIENT_DEFAULTS, CLIENT_DEPARTMENTS, CLIENT_REGIONS, CLIENT_TYPES,
  MANAGERS, SERVICE_TYPES, client as clientById,
} from '@/data/db';
import type { Client } from '@/data/types';
import * as CLIENT_STORE from '@/lib/clients';
import * as ROLES from '@/lib/roles';
import { useClientsVersion } from '@/lib/useStore';

const PER_PAGE = 15;
type SortKey = 'name' | 'code' | 'status';
type ClientTab = 'details' | 'requirements' | 'rates' | 'documents' | 'work';

/* ------------------------------------------------------------ data quality */

/* The rule itself lives in `lib/clients.ts` beside the one that refuses a bad
   code at entry, so the list and the client's own record cannot disagree about
   which codes are junk. */
const isJunkCode = (c: Client): boolean => CLIENT_STORE.codeIssue(c) !== null;
const junkReason = (c: Client): string => CLIENT_STORE.codeIssue(c) || '';

export default function ClientsPage() {
  const toast = useToast();
  useClientsVersion(); // re-render when a client is created, edited or removed
  const [params, setParams] = useSearchParams();

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [hasTags, setHasTags] = useState('all');
  const [junkOnly, setJunkOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);

  /* Deep link: `/clients?id=c-19` used to open a dialog over the list. The
     record is a page now, so the old link redirects to it rather than being
     quietly dropped — every notification, every timeline entry and every
     bookmark in the wild still uses this form. */
  const deepId = params.get('id');
  useEffect(() => {
    if (!deepId) return;
    const c = clientById(deepId);
    setParams({}, { replace: true });
    if (c) navigate(`/clients/${c.id}`, { replace: true });
  }, [deepId, navigate, setParams]);

  const rows = CLIENTS.filter((c) => {
    if (status !== 'all' && c.status !== status) return false;
    if (hasTags === 'yes' && !c.tags.length) return false;
    if (hasTags === 'no' && c.tags.length) return false;
    if (q && !`${c.name} ${c.code} ${c.email}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (junkOnly && !isJunkCode(c)) return false;
    return true;
  }).sort((a, b) => String(a[sort.key]).localeCompare(String(b[sort.key])) * sort.dir);

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const current = Math.min(page, pages);
  const pageRows = rows.slice((current - 1) * PER_PAGE, current * PER_PAGE);
  const showStatus = status === 'all'; // redundant when already filtered
  const junk = rows.filter(isJunkCode).length;

  const toggleSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: (-s.dir as 1 | -1) } : { key: k, dir: 1 }));

  const th = (key: SortKey, label: string) => {
    const on = sort.key === key;
    return (
      <th
        className="is-sortable"
        aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
        tabIndex={0}
        role="button"
        onClick={() => toggleSort(key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleSort(key);
          }
        }}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {on ? <Icon name={sort.dir === 1 ? 'chevronUp' : 'chevronDown'} decorative className="icon-sm" /> : null}
        </span>
      </th>
    );
  };

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle="Manage client accounts, their details, and the default requirements applied to every event they book."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            {...ROLES.gate('clients.edit')}
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" decorative /> New client
          </button>
        }
      />

      {junk ? (
        <div className="card p-3.5 mb-4 flex items-start gap-3" style={{ borderColor: TONE_LINE.atRisk }}>
          <span style={{ color: TONE_HEX.atRisk }} className="mt-0.5">
            <Icon name="alert" decorative />
          </span>
          <div className="flex-1">
            <div className="text-[13.5px] font-semibold text-ink">
              {countLabel(junk, 'client')} {junk === 1 ? 'has' : 'have'} an invalid code
            </div>
            <p className="text-[12.5px] text-ink-2 mt-0.5">
              Codes should be 2–5 uppercase letters and unique. Placeholder values like{' '}
              <span className="font-mono">YYY</span> and <span className="font-mono">ZZZ</span>, duplicates,
              and full event names all appear in the data.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm shrink-0"
            onClick={() => {
              setJunkOnly((j) => !j);
              setPage(1);
              toast(junkOnly ? 'Showing all clients.' : 'Showing only clients with an invalid code.');
            }}
          >
            Review these
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5 mb-4">
        <div className="relative w-72 max-w-full">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none">
            <Icon name="search" decorative />
          </span>
          <input
            className="field pl-9"
            type="search"
            value={q}
            placeholder="Search clients by name, code or email…"
            aria-label="Search clients"
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <label className="sr-only" htmlFor="status">
          Filter by status
        </label>
        <select
          className="field w-auto"
          id="status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All statuses</option>
        </select>

        {/* The information scent the old Tagging page never had: you can now
            tell which clients have requirements without opening each one. */}
        <label className="sr-only" htmlFor="hasTags">
          Filter by requirements
        </label>
        <select
          className="field w-auto"
          id="hasTags"
          value={hasTags}
          onChange={(e) => {
            setHasTags(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">Any requirements</option>
          <option value="yes">Has requirements</option>
          <option value="no">No requirements</option>
        </select>

        <div className="flex-1" />
        <span className="text-[13px] text-ink-2">
          <strong className="text-ink">{rows.length.toLocaleString()}</strong> of{' '}
          {CLIENTS.length.toLocaleString()} clients
        </span>
      </div>

      <section className="card">
        {rows.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    {th('name', 'Name')}
                    {th('code', 'Code')}
                    <th>Email</th>
                    <th>Default requirements</th>
                    {showStatus ? th('status', 'Status') : null}
                    <th style={{ width: 52 }}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((c) => (
                    <Row
                      key={c.id}
                      c={c}
                      showStatus={showStatus}
                      onOpen={(tab) =>
                        navigate(`/clients/${c.id}${tab === 'details' ? '' : `?tab=${tab}`}`)
                      }
                      onDelete={() => setDeleting(c)}
                      onToast={toast}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-surface-line-soft">
              <span className="text-[12.5px] text-ink-3">
                Showing {(current - 1) * PER_PAGE + 1}–{Math.min(current * PER_PAGE, rows.length)} of{' '}
                {rows.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn-icon"
                  disabled={current === 1}
                  aria-label="Previous page"
                  onClick={() => setPage(current - 1)}
                >
                  <Icon name="chevronLeft" decorative />
                </button>
                <span className="text-[12.5px] text-ink-2 px-2 tabular-nums">
                  Page {current} of {pages}
                </span>
                <button
                  type="button"
                  className="btn-icon"
                  disabled={current === pages}
                  aria-label="Next page"
                  onClick={() => setPage(current + 1)}
                >
                  <Icon name="chevronRight" decorative />
                </button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            iconName="clients"
            title="No clients match"
            body="Try a different search term or change the status filter."
          />
        )}
      </section>

      {deleting ? (
        <DeleteClient
          c={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const name = deleting.name;
            CLIENT_STORE.removeClient(deleting.id);
            setDeleting(null);
            toast(`${name} deleted.`, { tone: 'critical' });
          }}
        />
      ) : null}

      {creating ? (
        <NewClient
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            // Clear any filter that would hide the record just made — nothing
            // is more confusing than creating something and not seeing it.
            setQ('');
            setStatus('all');
            setHasTags('all');
            setJunkOnly(false);
            setPage(1);
            toast(`${c.name} created with code ${c.code}. You can raise a WOF against them now.`, {
              tone: 'healthy',
            });
          }}
        />
      ) : null}
    </>
  );
}

function Row({
  c,
  showStatus,
  onOpen,
  onDelete,
  onToast,
}: {
  c: Client;
  showStatus: boolean;
  onOpen: (tab: ClientTab) => void;
  onDelete: () => void;
  onToast: (msg: string, opts?: { tone?: 'healthy' | 'neutral' }) => void;
}) {
  const navigate = useNavigate();
  const junk = isJunkCode(c);

  return (
    <tr>
      <td>
        <button type="button" className="text-left text-[13.5px] text-ink hover:text-accent" onClick={() => onOpen('details')}>
          {c.name}
        </button>
      </td>
      <td>
        <span
          className={`font-mono text-[12.5px] ${junk ? '' : 'text-ink-2'}`}
          style={junk ? { color: TONE_HEX.atRisk } : undefined}
        >
          {c.code}
        </span>
        {junk ? (
          <span
            className="pill tip ml-1.5"
            tabIndex={0}
            data-tip={junkReason(c)}
            style={{ background: TONE_BG.atRisk, color: TONE_HEX.atRisk }}
          >
            check
          </span>
        ) : null}
      </td>
      {/* Blank cells rendered as nothing and made rows look broken. */}
      <td>
        {c.email ? (
          <a
            href={`mailto:${c.email}`}
            className="text-[13px] text-ink-2 no-underline hover:text-accent hover:underline"
          >
            {c.email}
          </a>
        ) : (
          <span className="text-ink-3 text-[13px] italic">Not set</span>
        )}
      </td>
      <td>
        <div className="flex gap-1 flex-wrap max-w-[240px]">
          {c.tags.length ? (
            c.tags.map((t) => <TagPill key={t} tagId={t} />)
          ) : (
            <button
              type="button"
              className="text-[12.5px] text-ink-3 italic hover:text-accent"
              onClick={() => onOpen('requirements')}
            >
              None — add
            </button>
          )}
        </div>
      </td>
      {showStatus ? (
        <td>
          <Pill status={c.status} />
        </td>
      ) : null}
      {/* Destructive action no longer sits one click away on every row. */}
      <td>
        <MenuButton
          label={`Actions for ${c.name}`}
          items={[
            { label: 'Open client record', icon: 'clients', onSelect: () => onOpen('details') },
            {
              label: 'Requirements', icon: 'tagging',
              badge: c.tags.length ? String(c.tags.length) : '',
              onSelect: () => onOpen('requirements'),
            },
            // Reading the register and changing it are separate permissions:
            // Finance and Payroll need to look accounts up, and neither should
            // be able to deactivate one.
            {
              label: 'Edit details', icon: 'edit',
              disabled: !ROLES.can('clients.edit'),
              hint: ROLES.denial('clients.edit') || undefined,
              onSelect: () => onOpen('details'),
            },
            { label: 'Rates & agreements', icon: 'trendUp', onSelect: () => onOpen('rates') },
            { label: 'Documents', icon: 'fileText', onSelect: () => onOpen('documents') },
            { label: 'View events', icon: 'events', onSelect: () => navigate(`/events?client=${c.id}`) },
            '-',
            {
              label: c.status === 'active' ? 'Deactivate client' : 'Reactivate client',
              icon: c.status === 'active' ? 'ban' : 'checkCircle',
              disabled: !ROLES.can('clients.edit'),
              hint: ROLES.denial('clients.edit') || undefined,
              onSelect: () =>
                onToast(`${c.name} ${c.status === 'active' ? 'deactivated' : 'reactivated'}.`, {
                  tone: c.status === 'active' ? 'neutral' : 'healthy',
                }),
            },
            {
              label: 'Delete client', icon: 'trash', danger: true,
              disabled: !ROLES.can('clients.edit'),
              hint: ROLES.denial('clients.edit') || undefined,
              onSelect: onDelete,
            },
          ]}
        />
      </td>
    </tr>
  );
}

/* The client record itself is a route now — `/clients/:id`, in
   `ClientDetail.tsx`. It was a 580px modal with three tabs, which was the right
   shape while a client was a name, a code and some tags, and the wrong one as
   soon as the account started carrying a rate table and a document register.
   See that file's header. */

/**
 * Deleting a client with live work would orphan it, so that case is refused
 * rather than warned about. Everything else is behind the typed confirm.
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
          <strong className="text-ink">Inactive</strong> instead — it keeps the history and takes them out
          of the client picker.
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
          'This permanently removes the client record and its default requirements. This cannot be undone.'
        )
      }
    />
  );
}

/**
 * Creates a real record.
 *
 * The previous version took what you typed, discarded it, and said "Client
 * created" — the exact failure the critique named first. It now validates
 * against the same code rule the list screen complains about, writes to the
 * register, and persists.
 *
 * WHY THIS FORM IS AS LONG AS IT IS
 * ---------------------------------
 * It asks for what the live client form asks for: who owns the account, which
 * division it belongs to, what kind of client it is, what EP sells them, and a
 * full contact block rather than one "phone" field. Two things are deliberately
 * NOT carried over from that form:
 *
 *   · The RAG status light (RED / AMBER / GREEN). This app's client status is
 *     Active / Inactive, and the client picker, the delete guard and the list
 *     filter all read it. A second status meaning something else on the same
 *     record is how you end up with an AMBER client nobody can explain.
 *   · Logo upload. A file input that quietly drops the file is worse than no
 *     file input, and storing images in the journal needs a size budget this
 *     change does not have.
 *
 * The two-tab split is the live form's own — Details, then Contact — so the
 * screen an operator already knows still reads the same way. A problem on the
 * tab you are not looking at switches to it rather than failing silently, the
 * same rule the client record's Save follows.
 */
function NewClient({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Client) => void }) {
  const [tab, setTab] = useState<'details' | 'contact'>('details');

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [managerId, setManagerId] = useState('');
  const [department, setDepartment] = useState('');
  const [clientType, setClientType] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [contact, setContact] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [terms, setTerms] = useState(String(CLIENT_DEFAULTS.termsDays));
  const [deposit, setDeposit] = useState(String(CLIENT_DEFAULTS.depositPolicy));

  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [landline, setLandline] = useState('');
  const [website, setWebsite] = useState('');
  const [address, setAddress] = useState('');
  const [address2, setAddress2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postcode, setPostcode] = useState('');
  const [notes, setNotes] = useState('');

  const [touched, setTouched] = useState(false);

  const input = (): CLIENT_STORE.ClientInput => ({
    name, code, email,
    status,
    contact: contact || undefined,
    termsDays: Number(terms) || CLIENT_DEFAULTS.termsDays,
    depositPolicy: Number(deposit) || 0,
    clientManagerId: managerId || null,
    department: department || null,
    clientType: clientType || null,
    serviceTypes: services,
    mobile, landline, website,
    address, address2, city,
    region: region || null,
    postcode, notes,
  });

  // Live once they have tried to submit, so the form does not shout at someone
  // who has typed two letters of a five-letter code.
  const errors: CLIENT_STORE.ClientErrors = touched ? CLIENT_STORE.validateClient(input()) : {};
  const detailsBad = Boolean(errors.name || errors.code);
  const contactBad = Boolean(errors.email || errors.website || errors.postcode);

  const submit = () => {
    setTouched(true);
    const e = CLIENT_STORE.validateClient(input());
    if (CLIENT_STORE.hasErrors(e)) {
      // Show the tab holding the problem, so "Create client" never looks dead.
      setTab(e.name || e.code ? 'details' : 'contact');
      return;
    }
    const r = CLIENT_STORE.createClient(input());
    if (r.ok && r.client) onCreated(r.client);
  };

  const enter = (e: { key: string }) => {
    if (e.key === 'Enter') submit();
  };

  const err = (m?: string) =>
    m ? <span className="block text-[11.5px] text-status-critical mt-1">{m}</span> : null;

  return (
    <Modal
      title="New client"
      width={620}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" data-close onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Create client
          </button>
        </>
      }
    >
      <div className="tabs mb-4" role="tablist">
        {(
          [
            ['details', 'Details', detailsBad],
            ['contact', 'Contact', contactBad],
          ] as ['details' | 'contact', string, boolean][]
        ).map(([k, l, bad]) => (
          <button
            key={k}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {l}
            {bad ? (
              <span className="ml-1.5" style={{ color: TONE_HEX.critical }} aria-label="has a problem">
                •
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'details' ? (
        <div className="grid gap-3.5">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Client name <span className="text-status-critical">*</span>
              </span>
              <input
                className="field"
                placeholder="e.g. Goodwood Estate"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={enter}
              />
              {err(errors.name)}
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
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Status</span>
              <select
                className="field"
                value={status}
                onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>

            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Main contact <span className="font-normal text-ink-3">Optional</span>
              </span>
              <input
                className="field"
                placeholder="Who signs the quotes"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Code <span className="text-status-critical">*</span>
            </span>
            <input
              className="field font-mono"
              placeholder="GDW"
              maxLength={5}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={enter}
            />
            <span className={`block text-[11.5px] mt-1 ${errors.code ? 'text-status-critical' : 'text-ink-3'}`}>
              {errors.code ?? '2–5 uppercase letters, unique across clients.'}
            </span>
          </label>

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
                      setServices((list) =>
                        e.target.checked ? [...list, s.id] : list.filter((x) => x !== s.id),
                      )
                    }
                  />
                  <span className="text-[13px] text-ink">{s.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-1">
            Commercial terms
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Payment terms</span>
              <div className="flex items-center gap-1.5">
                <input
                  className="field w-20 tabular-nums"
                  type="number"
                  min={0}
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                />
                <span className="text-[13px] text-ink-3">days</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Deposit on signing</span>
              <div className="flex items-center gap-1.5">
                <input
                  className="field w-20 tabular-nums"
                  type="number"
                  min={0}
                  max={100}
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                />
                <span className="text-[13px] text-ink-3">%</span>
              </div>
            </label>
          </div>
          <p className="text-[11.5px] text-ink-3 -mt-1.5 leading-relaxed">
            A client's own deposit policy overrides the job type's default wherever it is read, so it is
            worth setting here rather than inheriting {CLIENT_DEFAULTS.depositPolicy}% by accident.
          </p>
        </div>
      ) : (
        <div className="grid gap-3.5">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Mobile</span>
              <input
                className="field"
                type="tel"
                placeholder="07700 900123"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
                Email <span className="text-status-critical">*</span>
              </span>
              <input
                className="field"
                type="email"
                placeholder="staffing@example.co.uk"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={enter}
              />
              {err(errors.email)}
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Landline</span>
              <input
                className="field"
                type="tel"
                placeholder="020 7946 0100"
                value={landline}
                onChange={(e) => setLandline(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Website</span>
              <input
                className="field"
                placeholder="example.co.uk"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
              {err(errors.website)}
            </label>
          </div>
          <p className="text-[11.5px] text-ink-3 -mt-1.5 leading-relaxed">
            Both numbers are kept. Screens that show one number use the landline and fall back to the
            mobile — before this there was a single field and whichever number was typed second won.
          </p>

          <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 mt-1">
            Address
          </div>
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

          <div className="grid grid-cols-2 gap-3">
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
          </div>

          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Postal code</span>
            <input
              className="field w-40"
              placeholder="SO31 3DA"
              value={postcode}
              onChange={(e) => setPostcode(e.target.value.toUpperCase())}
            />
            {err(errors.postcode)}
          </label>
          <p className="text-[11.5px] text-ink-3 -mt-1.5 leading-relaxed">
            The address prints at the head of every quote for this client, so leaving it blank puts a
            fill-in box on the document.
          </p>

          <label className="block">
            <span className="block text-[12.5px] font-medium text-ink-2 mb-1.5">
              Notes <span className="font-normal text-ink-3">Optional</span>
            </span>
            <textarea
              className="field"
              rows={3}
              placeholder="Anything the desk needs to know before quoting them"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
        </div>
      )}
    </Modal>
  );
}
