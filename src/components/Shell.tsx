/* ============================================================================
   EPROSTA — app shell
   ----------------------------------------------------------------------------
   Sidebar is GROUPED (Work orders / Delivery / Reports / Reference data) rather
   than seven flat items mixing daily work with configuration, and the hamburger
   actually collapses it instead of sitting next to a permanently open rail.

   `theme-dark` scopes the dark palette to the rail. Everything inside resolves
   its colours against it; everything outside stays light — one set of component
   classes, two themes.

   Tier enforcement happens in the route guard below rather than on each page,
   so a route cannot be reached by typing its URL while acting as a client or a
   worker.
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { MenuButton, OverflowMenu, type MenuEntry } from './Modal';
import { useToast } from './Toast';
import { TONE_BG, TONE_HEX, statusMeta } from '@/lib/status';
import { eventCoverage } from '@/lib/coverage';
import { money, timing } from '@/lib/format';
import { CHECK_INS, CLIENTS, EMPLOYEES, EVENTS, NOTIFICATIONS } from '@/data/db';
import * as PORTAL from '@/lib/portal';
import * as WOF from '@/lib/wof';
import * as ROLES from '@/lib/roles';
import { useRolesVersion, useTheme, useTier, useWofVersion } from '@/lib/useStore';

/* ------------------------------------------------------------------ badges */

/**
 * A client or a worker must never be handed the operator's counts — the number
 * of outstanding risk assessments is not their business, and a rail that badges
 * a route the tier cannot open is just noise.
 */
function badgeCounts(): Partial<Record<PORTAL.BadgeKey, number>> {
  const tiered = PORTAL.badges();
  if (tiered) return tiered;

  const live = WOF.all().filter((w) => !WOF.isTerminal(w.stage));
  return {
    checkins: CHECK_INS.length,
    notifications: NOTIFICATIONS.filter((n) => n.unread).length,
    // WOF badges are computed here rather than on each page so the sidebar
    // agrees with the reports it links to.
    wofAttention: live.filter((w) => {
      const g = WOF.gate(w);
      return g.block.length || g.warn.length;
    }).length,
    noWof: WOF.calendarRows().filter((r) => !r.wof).length,
    // Counts everything late, received or not, so the badge matches the row
    // count on the Document checklist report's default 'Needs attention' view.
    docsOutstanding: live.reduce((n, w) => n + WOF.docState(w).late, 0),
  };
}

/* ------------------------------------------------------------ global search */

interface Hit {
  kind: string;
  icon: string;
  label: string;
  meta: string;
  href: string;
}

/**
 * One search box, cross-entity. The Staff page had two boxes both saying
 * "Search employees…"; the page-level one is now a filter, and this one is
 * explicitly cross-entity.
 */
function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const hits = useMemo<Hit[]>(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const out: Hit[] = [];

    WOF.all()
      .filter((w) => w.title.toLowerCase().includes(s) || w.ref.toLowerCase().includes(s))
      .slice(0, 5)
      .forEach((w) => {
        const st = WOF.stage(w.stage) || WOF.TERMINAL[w.stage as WOF.TerminalId];
        out.push({
          kind: 'WOF', icon: 'fileText', label: `${w.ref} · ${w.title}`,
          meta: `${st?.label ?? w.stage} · ${money(WOF.contractValue(w), { pence: false })}`,
          href: `/wofs/${w.id}`,
        });
      });

    EVENTS.filter((e) => e.name.toLowerCase().includes(s))
      .slice(0, 5)
      .forEach((e) => {
        const cov = eventCoverage(e);
        out.push({
          kind: 'Event', icon: 'events', label: e.name,
          meta: `${cov.filled}/${cov.required} filled · ${timing(e.start, e.end).label}`,
          href: `/events/${e.id}`,
        });
      });

    EMPLOYEES.filter((e) => e.name.toLowerCase().includes(s))
      .slice(0, 5)
      .forEach((e) =>
        out.push({
          kind: 'Staff', icon: 'staff', label: e.name,
          meta: `${e.office} · ${statusMeta(e.status).label}`,
          href: `/staff?id=${e.id}`,
        }),
      );

    CLIENTS.filter((c) => c.name.toLowerCase().includes(s))
      .slice(0, 5)
      .forEach((c) => out.push({ kind: 'Client', icon: 'clients', label: c.name, meta: c.code, href: `/clients?id=${c.id}` }));

    return out;
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName || '';
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
        e.preventDefault();
        boxRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  const show = open && q.trim().length >= 2;

  return (
    <div className="relative flex-1 max-w-lg" ref={wrapRef}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none">
        <Icon name="search" decorative />
      </span>
      <input
        ref={boxRef}
        className="field pl-9"
        type="search"
        placeholder="Search events, staff and clients…"
        aria-label="Search events, staff and clients"
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
        aria-controls="global-search-results"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            boxRef.current?.blur();
          }
          if (e.key === 'Enter' && hits.length) {
            navigate(hits[0].href);
            setOpen(false);
          }
        }}
      />
      <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10.5px] text-ink-3 border border-surface-line rounded px-1.5 py-0.5 pointer-events-none">
        /
      </kbd>
      {show ? (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1.5 card p-1.5 max-h-96 overflow-y-auto z-50"
        >
          {!hits.length ? (
            <div className="px-3 py-4 text-[13px] text-ink-3 text-center">No matches for “{q}”</div>
          ) : (
            hits.map((h, i) => (
              <Link
                key={i}
                to={h.href}
                role="option"
                aria-selected={false}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg no-underline hover:bg-surface-hover"
                onClick={() => setOpen(false)}
              >
                <span className="text-ink-3">
                  <Icon name={h.icon} decorative />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-ink truncate">{h.label}</span>
                  <span className="block text-[11.5px] text-ink-3 truncate">{h.meta}</span>
                </span>
                <span className="text-2xs text-ink-3 uppercase tracking-wider">{h.kind}</span>
              </Link>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- the switcher */

/**
 * Deliberately labelled "Viewing as" and marked as a prototype control. A
 * product would not ship a button that turns an admin into a client; saying so
 * in the menu is cheaper than someone assuming it is a permissions bug.
 *
 * The client tier carries a second choice — WHICH client — because a work order
 * is raised against whichever organisation rang up. Pinning the portal to one
 * account would make every other client's job invisible from their own side.
 *
 * The admin tier carries the same second choice for the same reason, one level
 * down: WHICH member of EP Team. Roles that cannot be seen from the other side
 * are a claim rather than a feature — signing in as the payroll clerk is how
 * you discover that hiding the cash-flow route left its export button live.
 */
function TierSwitcher() {
  const t = PORTAL.tier();
  const now = PORTAL.current();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const actingClientId = PORTAL.actingClientId();
  const actingMemberId = ROLES.actingId();

  const memberItems: MenuEntry[] =
    now === 'admin'
      ? [
          '-',
          { label: 'Signed in as', disabled: true, hint: 'Which member of EP Team, and therefore which permissions' },
          ...ROLES.selectableMembers().map((m) => ({
            label: m.name,
            icon: ROLES.role(m.roleId)?.icon || 'staff',
            badge: m.id === actingMemberId ? 'Current' : ROLES.role(m.roleId)?.label || '',
            hint: `${m.jobTitle} — ${ROLES.role(m.roleId)?.blurb ?? ''}`,
            disabled: m.id === actingMemberId,
            onSelect: () => {
              ROLES.setActing(m.id);
              // Their rail is not yours. Landing on a page the new role cannot
              // open would bounce, and a bounce on switch reads as a crash.
              navigate(PORTAL.home());
            },
          })),
        ]
      : [];

  const clientItems: MenuEntry[] =
    now === 'client'
      ? [
          '-',
          { label: 'Acting as', disabled: true, hint: 'Which of your client accounts to view' },
          ...PORTAL.selectableClients().map((c) => {
            const todo = c.id === actingClientId ? PORTAL.clientTodoCount() : undefined;
            return {
              label: c.name,
              icon: 'building',
              badge: c.id === actingClientId ? (todo ? `${todo} to do` : 'Current') : '',
              disabled: c.id === actingClientId,
              onSelect: () => {
                PORTAL.setActingClient(c.id);
                navigate('/client/jobs');
              },
            };
          }),
        ]
      : [];

  const items: MenuEntry[] = [
    ...PORTAL.ORDER.map((id) => {
      const ti = PORTAL.TIERS[id];
      return {
        label: ti.label,
        icon: ti.icon,
        badge: id === now ? 'Current' : '',
        hint: `${ti.role} — ${ti.blurb}`,
        disabled: id === now,
        onSelect: () => {
          PORTAL.setTier(id);
          navigate(ti.home);
        },
      };
    }),
    ...clientItems,
    ...memberItems,
    '-',
    {
      label: 'Prototype control, not a product feature',
      icon: 'info',
      disabled: true,
      hint: 'In the real system your tier comes from the account you signed in with. This switcher exists so all three can be demonstrated from one build.',
    },
  ];

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn btn-secondary btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Viewing as ${t.label}. Change portal.`}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={t.icon} decorative className="icon-sm" />
        <span className="hidden sm:inline text-[12.5px]">
          <span className="text-ink-3 font-normal">Viewing as </span>
          <span className="font-semibold text-ink">
            {now === 'client' ? PORTAL.actingClient().name : t.label}
          </span>
        </span>
        <Icon name="chevronDown" decorative className="icon-sm" />
      </button>
      {open ? <OverflowMenu anchor={ref.current} items={items} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/* -------------------------------------------------------------------- shell */

export function Shell() {
  const tierId = useTier();
  useWofVersion(); // badges move when a WOF does
  useRolesVersion(); // and the rail itself moves when a permission does
  useTheme(); // and the whole document follows the account's theme choice
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('epteam.nav') === 'collapsed';
    } catch {
      return false;
    }
  });

  const counts = badgeCounts();
  const me = PORTAL.acting();
  const isAdmin = tierId === 'admin';

  // Typing an admin URL while acting as a client bounces you home rather than
  // rendering the page, so the switcher is not a cosmetic filter.
  if (!PORTAL.canAccess(location.pathname)) {
    return <Navigate to={PORTAL.home()} replace />;
  }

  const toggleNav = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem('epteam.nav', next ? 'collapsed' : 'expanded');
      } catch {
        /* private mode */
      }
      return next;
    });
  };

  return (
    <>
      <a href="#main" className="sr-only">
        Skip to main content
      </a>
      <div className="app-shell" data-nav={collapsed ? 'collapsed' : 'expanded'} id="app-shell">
        <aside className="sidebar theme-dark flex flex-col sticky top-0 h-screen">
          <div className="h-14 flex items-center gap-2 px-4 border-b border-surface-line-soft">
            <button
              type="button"
              className="btn-icon"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              aria-controls="app-shell"
              onClick={toggleNav}
            >
              <Icon name="menu" decorative />
            </button>
            <Link
              to={PORTAL.home()}
              className="nav-label font-extrabold tracking-tight text-[17px] text-ink no-underline"
            >
              <img src="/logo.png" alt="EPTEAM" className="h-7 w-auto block" />
              {!isAdmin ? (
                <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-ink-3 -mt-0.5">
                  {PORTAL.tier().label} portal
                </span>
              ) : null}
            </Link>
          </div>

          <nav className="flex-1 overflow-y-auto py-2" aria-label="Main">
            {PORTAL.nav().map((g) => (
              <div key={g.group}>
                <div className="nav-group-label">{g.group}</div>
                {g.items.map((it) => {
                  const n = it.badgeKey ? counts[it.badgeKey] || 0 : 0;
                  return (
                    <NavLink
                      key={it.href}
                      to={it.href}
                      className="nav-item"
                      title={it.label}
                      aria-current={location.pathname === it.href ? 'page' : undefined}
                    >
                      <Icon name={it.icon} decorative />
                      <span className="nav-label flex-1">{it.label}</span>
                      {n ? (
                        <span
                          className="nav-label pill"
                          style={{
                            background: TONE_BG.critical,
                            color: TONE_HEX.critical,
                            padding: '1px 6px',
                            fontSize: 11,
                          }}
                        >
                          {n}
                        </span>
                      ) : null}
                    </NavLink>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="p-3 border-t border-surface-line-soft">
            <MenuButton
              className="nav-item w-full"
              label={`Account menu for ${me.name}`}
              align="left"
              items={[
                {
                  label: 'Team & roles',
                  icon: 'users',
                  hint: isAdmin
                    ? 'Who has access to this console and what each role can do'
                    : undefined,
                  // Shown to every tier so the menu does not change shape, but a
                  // client or a worker has no team to manage and no role that
                  // could grant them one.
                  disabled: !isAdmin || !ROLES.can('team.view'),
                  badge: isAdmin && !ROLES.can('team.view') ? 'No access' : '',
                  onSelect: () => navigate('/settings/team'),
                },
                {
                  /* Offered to every tier, unlike Team & roles. A client
                     contact and a worker both have a name, an email and a
                     preference about dark mode; what they do not have is a
                     console role, and the page drops that panel for them
                     rather than showing an empty one. */
                  label: 'Account settings',
                  icon: 'settings',
                  hint: 'Your details, appearance and what you are notified about',
                  onSelect: () => navigate('/settings/account'),
                },
                '-',
                { label: 'Sign out', icon: 'logout', onSelect: () => toast('Signed out.', { tone: 'info' }) },
              ]}
            >
              <span
                className="avatar"
                aria-hidden="true"
                style={
                  {
                    '--av-hue': `${me.hue}deg`,
                    width: 26,
                    height: 26,
                    fontSize: 10.5,
                  } as React.CSSProperties
                }
              >
                {me.initials}
              </span>
              <span className="nav-label flex-1 text-left leading-tight min-w-0">
                <span className="block text-[13px] font-semibold text-ink truncate">{me.name}</span>
                <span className="block text-[11px] text-ink-3 truncate">{me.sub}</span>
              </span>
              <Icon name="chevronUp" decorative className="icon-sm nav-label" />
            </MenuButton>
          </div>
        </aside>

        <div className="main-col">
          {/* The top bar belongs to the content column, not the rail, so it
              takes the light theme and reads as the top of the page. */}
          <header className="topbar flex items-center gap-3 px-5 sticky top-0 z-40">
            {isAdmin ? (
              /* Cross-entity search is an operator tool. Handing it to a client
                 would let them type another client's name and confirm they
                 exist, so the box is not rendered outside the admin tier at all
                 rather than rendered and filtered. */
              <GlobalSearch />
            ) : (
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold text-ink truncate">{me.name}</div>
                <div className="text-[11.5px] text-ink-3 truncate">{me.detail || me.sub}</div>
              </div>
            )}
            <div className="flex-1" />
            <TierSwitcher />
            <Link
              className="btn-icon relative"
              to={isAdmin ? '/notifications' : PORTAL.home()}
              aria-label={`Notifications, ${counts.notifications || 0} unread`}
            >
              <Icon name="bell" decorative />
              {counts.notifications ? (
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-1 w-2 h-2 rounded-full"
                  style={{ background: TONE_HEX.critical, boxShadow: '0 0 0 2px var(--surface)' }}
                />
              ) : null}
            </Link>
          </header>

          <main className="page-body" id="main" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
