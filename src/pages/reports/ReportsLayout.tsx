/* ============================================================================
   REPORTS — one rail item, one tab per report
   ----------------------------------------------------------------------------
   The three money reports used to be three rail items. They are the same kind
   of page — read, filter, export — so they share one "Reports" entry and sit
   side by side as tabs. Each keeps its own URL (/reports/cashflow …), so links
   from the work order and old bookmarks still land on the right tab.

   The Document checklist is NOT here on purpose: it is a to-do list with a
   badge, and a badge buried in a tab stops doing its job. It lives under Work
   orders at /documents.

   Tabs answer to the same capability as the route behind them — a tab the role
   cannot open is not drawn, and with only one report left there is no tab bar.
   ========================================================================== */

import { NavLink, Navigate, Outlet } from 'react-router-dom';
import * as ROLES from '@/lib/roles';
import * as PORTAL from '@/lib/portal';
import { useRolesVersion } from '@/lib/useStore';

export const REPORT_TABS: { href: string; label: string; cap: ROLES.Capability }[] = [
  { href: '/reports/cashflow', label: 'Cash flow', cap: 'report.cashflow' },
  { href: '/reports/costing', label: 'Job costing', cap: 'report.costing' },
  { href: '/reports/payroll', label: 'Payroll output', cap: 'report.payroll' },
];

export const REPORT_CAPS: ROLES.Capability[] = REPORT_TABS.map((t) => t.cap);

const visibleTabs = () => REPORT_TABS.filter((t) => ROLES.can(t.cap));

export function ReportsLayout() {
  useRolesVersion();
  const tabs = visibleTabs();
  return (
    <>
      {tabs.length > 1 ? (
        <nav className="tabs mb-5" aria-label="Reports">
          {tabs.map((t) => (
            <NavLink key={t.href} to={t.href} className="tab">
              {t.label}
            </NavLink>
          ))}
        </nav>
      ) : null}
      <Outlet />
    </>
  );
}

/** `/reports` on its own: the first report this role can open. */
export function ReportsIndex() {
  useRolesVersion();
  const first = visibleTabs()[0];
  return <Navigate to={first ? first.href : PORTAL.home()} replace />;
}
