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
  CLIENT_DEPARTMENTS, CLIENT_REGIONS, CLIENT_TYPES, EMPLOYEES, EVENTS, LEGAL_STRUCTURES, MANAGERS,
  PAYMENT_METHODS, SERVICE_TYPES, TAGS, client as clientById, manager as managerById,
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

  /* Company */
  const [legalName, setLegalName] = useState(c.legalName ?? '');
  const [name, setName] = useState(c.name);
  const [companyNumber, setCompanyNumber] = useState(c.companyNumber ?? '');
  const [legalStructure, setLegalStructure] = useState<string>(c.legalStructure ?? '');

  /* Account (how EP runs the account — read across the app) */
  const [code, setCode] = useState(c.code);
  const [status, setStatus] = useState(c.status);
  const [email, setEmail] = useState(c.email);
  const [managerId, setManagerId] = useState(c.clientManagerId ?? '');
  const [department, setDepartment] = useState(c.department ?? '');
  const [clientType, setClientType] = useState(c.clientType ?? '');
  const [services, setServices] = useState<string[]>(c.serviceTypes ?? []);

  /* Registered address */
  const [regAddress, setRegAddress] = useState(c.regAddress ?? '');
  const [regAddress2, setRegAddress2] = useState(c.regAddress2 ?? '');
  const [regCity, setRegCity] = useState(c.regCity ?? '');
  const [regPostcode, setRegPostcode] = useState(c.regPostcode ?? '');

  /* Trading / operational address */
  const tradingMatches =
    !!c.regAddress &&
    (c.address ?? '') === (c.regAddress ?? '') &&
    (c.address2 ?? '') === (c.regAddress2 ?? '') &&
    (c.city ?? '') === (c.regCity ?? '') &&
    (c.postcode ?? '') === (c.regPostcode ?? '');
  const [tradingSame, setTradingSame] = useState(tradingMatches);
  const [address, setAddress] = useState(c.address ?? '');
  const [address2, setAddress2] = useState(c.address2 ?? '');
  const [city, setCity] = useState(c.city ?? '');
  const [region, setRegion] = useState(c.region ?? '');
  const [postcode, setPostcode] = useState(c.postcode ?? '');

  /* Billing */
  const [billingSameAs, setBillingSameAs] = useState<'registered' | 'trading' | 'other'>(c.billingSameAs ?? 'other');
  const [billAddress, setBillAddress] = useState(c.billAddress ?? '');
  const [billAddress2, setBillAddress2] = useState(c.billAddress2 ?? '');
  const [billCity, setBillCity] = useState(c.billCity ?? '');
  const [billPostcode, setBillPostcode] = useState(c.billPostcode ?? '');
  const [vatNumber, setVatNumber] = useState(c.vatNumber ?? '');
  const [termsDays, setTermsDays] = useState(String(c.termsDays ?? 30));
  const [creditLimit, setCreditLimit] = useState(String(c.creditLimit ?? 0));
  const [deposit, setDeposit] = useState(String(c.depositPolicy ?? 0));
  const [invoiceName, setInvoiceName] = useState(c.invoiceContactName ?? '');
  const [invoiceEmail, setInvoiceEmail] = useState(c.billingEmail ?? '');
  const [invoicePhone, setInvoicePhone] = useState(c.invoiceContactPhone ?? '');
  const [paymentMethod, setPaymentMethod] = useState<string>(c.paymentMethod ?? '');

  /* Bank */
  const [bankAccountName, setBankAccountName] = useState(c.bankAccountName ?? '');
  const [bankAccountNumber, setBankAccountNumber] = useState(c.bankAccountNumber ?? '');
  const [bankSortCode, setBankSortCode] = useState(c.bankSortCode ?? '');
  const [bankName, setBankName] = useState(c.bankName ?? '');
  const [bankBranch, setBankBranch] = useState(c.bankBranch ?? '');
  const [iban, setIban] = useState(c.iban ?? '');
  const [swift, setSwift] = useState(c.swift ?? '');

  const [notes, setNotes] = useState(c.notes ?? '');
  const [touched, setTouched] = useState(false);

  const S = CLIENT_STORE;
  const v = <T,>(x: T) => (touched ? x : null);
  const nameError = v(S.validateName(name, c.id));
  const codeError = v(S.validateCode(code, c.id));
  // An account that predates the required-email rule is not made unsaveable by
  // it; an edit only has to leave what is there valid.
  const emailError = v(S.validateEmail(email));
  const companyNumberError = v(S.validateCompanyNumber(companyNumber));
  const regPostcodeError = v(S.validatePostcode(regPostcode));
  const postcodeError = v(tradingSame ? null : S.validatePostcode(postcode));
  const billPostcodeError = v(billingSameAs === 'other' ? S.validatePostcode(billPostcode) : null);
  const vatError = v(S.validateVat(vatNumber));
  const invoiceEmailError = v(S.validateEmail(invoiceEmail));
  const sortCodeError = v(S.validateSortCode(bankSortCode));
  const accountNumberError = v(S.validateAccountNumber(bankAccountNumber));
  const ibanError = v(S.validateIban(iban));
  const swiftError = v(S.validateSwift(swift));
  const num = (s: string, min: number, max: number) => {
    const n = Number(s);
    return s.trim() !== '' && Number.isFinite(n) && n >= min && n <= max ? null : `${min}–${max.toLocaleString('en-GB')}`;
  };
  const termsError = v(num(termsDays, 0, 180));
  const creditError = v(num(creditLimit, 0, 10_000_000));
  const depositError = v(num(deposit, 0, 100));
  const issue = S.codeIssue(c);

  const save = () => {
    setTouched(true);
    if (num(termsDays, 0, 180) || num(creditLimit, 0, 10_000_000) || num(deposit, 0, 100)) {
      toast('Nothing was saved — the fields marked in red need fixing first.', { tone: 'critical' });
      return;
    }
    const t = (x: string) => x.trim() || null;
    const r = S.updateClient(c.id, {
      legalName: t(legalName),
      name,
      companyNumber: t(companyNumber),
      legalStructure: (legalStructure || null) as Client['legalStructure'],

      code, status, email,
      clientManagerId: managerId || null,
      department: department || null,
      clientType: clientType || null,
      serviceTypes: services,

      regAddress: t(regAddress),
      regAddress2: t(regAddress2),
      regCity: t(regCity),
      regPostcode: t(regPostcode),

      // "Same as registered" is stored as a copy, not a pointer: quotes print
      // the trading address, and they should not change under a sent document
      // because someone later corrected the registered office.
      address: tradingSame ? t(regAddress) : t(address),
      address2: tradingSame ? t(regAddress2) : t(address2),
      city: tradingSame ? t(regCity) : t(city),
      region: region || null,
      postcode: tradingSame ? t(regPostcode) : t(postcode),

      billingSameAs: billingSameAs === 'other' ? null : billingSameAs,
      billAddress: t(billAddress),
      billAddress2: t(billAddress2),
      billCity: t(billCity),
      billPostcode: t(billPostcode),
      vatNumber: t(vatNumber),
      termsDays: Math.round(Number(termsDays)),
      creditLimit: Number(creditLimit),
      depositPolicy: Number(deposit),
      invoiceContactName: t(invoiceName),
      billingEmail: t(invoiceEmail),
      invoiceContactPhone: t(invoicePhone),
      paymentMethod: (paymentMethod || null) as Client['paymentMethod'],

      bankAccountName: t(bankAccountName),
      bankAccountNumber: t(bankAccountNumber),
      bankSortCode: t(bankSortCode),
      bankName: t(bankName),
      bankBranch: t(bankBranch),
      iban: t(iban),
      swift: t(swift),

      notes: t(notes),
    });
    toast(
      r.ok ? `${name} saved.` : 'Nothing was saved — the fields marked in red need fixing first.',
      { tone: r.ok ? 'healthy' : 'critical' },
    );
  };

  return (
    <div className="card p-5">
      <div className="grid gap-3.5" style={{ maxWidth: 720 }}>
        {/* ------------------------------------------------------- company */}
        <Section title="Company" first />
        <div className="grid grid-cols-2 gap-3">
          <F label="Full legal name" hint="Company or individual — who the contract is with.">
            <input className="field" placeholder="e.g. Festival Republic Ltd" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </F>
          <F label="Trading name" hint="If different. This is the name shown across EP Roster." error={nameError}>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </F>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <F label="Registered company number" hint="Companies House." error={companyNumberError}>
            <input
              className="field font-mono"
              placeholder="Not set"
              value={companyNumber}
              maxLength={10}
              onChange={(e) => setCompanyNumber(e.target.value.toUpperCase())}
            />
          </F>
          <F label="Legal structure">
            <select className="field" value={legalStructure} onChange={(e) => setLegalStructure(e.target.value)}>
              <option value="">Not set</option>
              {LEGAL_STRUCTURES.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
          </F>
        </div>

        {/* ------------------------------------------------------ addresses */}
        <Section title="Registered address" hint="For legal notices." />
        <AddressFields
          line1={regAddress} setLine1={setRegAddress}
          line2={regAddress2} setLine2={setRegAddress2}
          city={regCity} setCity={setRegCity}
          postcode={regPostcode} setPostcode={setRegPostcode}
          postcodeError={regPostcodeError}
        />

        <Section title="Trading / operational address" hint="Printed on quotes." />
        <label className="flex items-center gap-2.5 text-[13px] text-ink cursor-pointer -mt-1">
          <input type="checkbox" checked={tradingSame} onChange={(e) => setTradingSame(e.target.checked)} />
          Same as registered address
        </label>
        {tradingSame ? null : (
          <AddressFields
            line1={address} setLine1={setAddress}
            line2={address2} setLine2={setAddress2}
            city={city} setCity={setCity}
            postcode={postcode} setPostcode={setPostcode}
            postcodeError={postcodeError}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <F label="Province/Region">
            <select className="field" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">Not set</option>
              {CLIENT_REGIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </F>
        </div>

        {/* -------------------------------------------------------- billing */}
        <Section title="Billing" />
        <F label="Billing address">
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-ink">
            {(
              [
                ['registered', 'Same as registered'],
                ['trading', 'Same as trading'],
                ['other', 'Different address'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="billingSameAs" checked={billingSameAs === k} onChange={() => setBillingSameAs(k)} />
                {l}
              </label>
            ))}
          </div>
        </F>
        {billingSameAs === 'other' ? (
          <AddressFields
            line1={billAddress} setLine1={setBillAddress}
            line2={billAddress2} setLine2={setBillAddress2}
            city={billCity} setCity={setBillCity}
            postcode={billPostcode} setPostcode={setBillPostcode}
            postcodeError={billPostcodeError}
          />
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <F label="VAT number" error={vatError}>
            <input className="field font-mono" placeholder="e.g. GB123456789" value={vatNumber} onChange={(e) => setVatNumber(e.target.value.toUpperCase())} />
          </F>
          <F label="Preferred payment method">
            <select className="field" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="">Not set</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </F>
        </div>

        <div className="text-[12.5px] font-medium text-ink-2 -mb-1.5">Credit terms</div>
        <div className="grid grid-cols-3 gap-3">
          <F label="Payment terms (days)" error={termsError} small>
            <input className="field tabular-nums" inputMode="numeric" value={termsDays} onChange={(e) => setTermsDays(e.target.value)} />
          </F>
          <F label="Credit limit (£)" error={creditError} small>
            <input className="field tabular-nums" inputMode="numeric" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
          </F>
          <F label="Deposit on signing (%)" error={depositError} small>
            <input className="field tabular-nums" inputMode="numeric" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </F>
        </div>

        <div className="text-[12.5px] font-medium text-ink-2 -mb-1.5">Invoice contact</div>
        <div className="grid grid-cols-3 gap-3">
          <F label="Name" small>
            <input className="field" placeholder="Not set" value={invoiceName} onChange={(e) => setInvoiceName(e.target.value)} />
          </F>
          <F label="Email" error={invoiceEmailError} small>
            <input className="field" type="email" placeholder="Not set" value={invoiceEmail} onChange={(e) => setInvoiceEmail(e.target.value)} />
          </F>
          <F label="Phone" small>
            <input className="field" type="tel" placeholder="Not set" value={invoicePhone} onChange={(e) => setInvoicePhone(e.target.value)} />
          </F>
        </div>

        {/* ----------------------------------------------------------- bank */}
        <Section title="Bank details" />
        <F label="Bank account name">
          <input className="field" placeholder="As it appears on the account" value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} />
        </F>
        <div className="grid grid-cols-2 gap-3">
          <F label="Account number" error={accountNumberError}>
            <input className="field font-mono" inputMode="numeric" maxLength={10} placeholder="8 digits" value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} />
          </F>
          <F label="Sort code" error={sortCodeError}>
            <input className="field font-mono" inputMode="numeric" maxLength={8} placeholder="00-00-00" value={bankSortCode} onChange={(e) => setBankSortCode(e.target.value)} />
          </F>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <F label="Bank name">
            <input className="field" placeholder="Not set" value={bankName} onChange={(e) => setBankName(e.target.value)} />
          </F>
          <F label="Branch">
            <input className="field" placeholder="Not set" value={bankBranch} onChange={(e) => setBankBranch(e.target.value)} />
          </F>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <F label="IBAN" hint="If international." error={ibanError}>
            <input className="field font-mono" placeholder="Not set" value={iban} onChange={(e) => setIban(e.target.value.toUpperCase())} />
          </F>
          <F label="SWIFT / BIC" hint="If international." error={swiftError}>
            <input className="field font-mono" maxLength={11} placeholder="Not set" value={swift} onChange={(e) => setSwift(e.target.value.toUpperCase())} />
          </F>
        </div>

        {/* -------------------------------------------------------- account */}
        <Section title="Account" hint="How EP runs this client." />
        <div className="grid grid-cols-2 gap-3">
          <F label="Code" error={codeError} hint={codeError ? undefined : issue ?? '2–5 uppercase letters, unique.'} hintTone={issue ? 'atRisk' : undefined}>
            <input className="field font-mono" value={code} maxLength={5} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </F>
          <F label="Status">
            <select className="field" value={status} onChange={(e) => setStatus(e.target.value as Client['status'])}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </F>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <F label="Client manager">
            <select className="field" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">Unassigned</option>
              {MANAGERS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.role}
                </option>
              ))}
            </select>
          </F>
          <F label="General email" error={emailError}>
            <input className="field" type="email" value={email} placeholder="Not set" onChange={(e) => setEmail(e.target.value)} />
          </F>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <F label="Department">
            <select className="field" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">Not set</option>
              {CLIENT_DEPARTMENTS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </F>
          <F label="Type">
            <select className="field" value={clientType} onChange={(e) => setClientType(e.target.value)}>
              <option value="">Not set</option>
              {CLIENT_TYPES.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
          </F>
        </div>
        <div>
          <div className="block text-[12.5px] font-medium text-ink-2 mb-1.5">Service types</div>
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

        <F label="Notes">
          <textarea className="field" rows={3} placeholder="Not set" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </F>

        <div className="flex justify-end pt-1">
          <button type="button" className="btn btn-primary" {...ROLES.gate('clients.edit')} onClick={save}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

/* Small layout pieces for the details form — one label/hint/error pattern so
   thirty-odd fields cannot drift into five slightly different ones. */

function Section({ title, hint, first }: { title: string; hint?: string; first?: boolean }) {
  return (
    <div className={first ? '' : 'border-t border-surface-line-soft pt-4 mt-2'}>
      <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3">
        {title}
        {hint ? <span className="normal-case tracking-normal font-normal ml-2">{hint}</span> : null}
      </div>
    </div>
  );
}

function F({
  label, hint, error, hintTone, small, children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  hintTone?: 'atRisk';
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className={`block font-medium text-ink-2 mb-1.5 ${small ? 'text-[12px]' : 'text-[12.5px]'}`}>{label}</span>
      {children}
      {error ? (
        <span className="block text-[11.5px] text-status-critical mt-1">{error}</span>
      ) : hint ? (
        <span className="block text-[11.5px] text-ink-3 mt-1" style={hintTone ? { color: TONE_HEX[hintTone] } : undefined}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function AddressFields(p: {
  line1: string; setLine1: (v: string) => void;
  line2: string; setLine2: (v: string) => void;
  city: string; setCity: (v: string) => void;
  postcode: string; setPostcode: (v: string) => void;
  postcodeError: string | null;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <F label="Address line 1">
          <input className="field" placeholder="Building and street" value={p.line1} onChange={(e) => p.setLine1(e.target.value)} />
        </F>
        <F label="Address line 2">
          <input className="field" value={p.line2} onChange={(e) => p.setLine2(e.target.value)} />
        </F>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <F label="Town / city">
          <input className="field" value={p.city} onChange={(e) => p.setCity(e.target.value)} />
        </F>
        <F label="Postcode" error={p.postcodeError}>
          <input className="field" value={p.postcode} onChange={(e) => p.setPostcode(e.target.value.toUpperCase())} />
        </F>
      </div>
    </>
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
