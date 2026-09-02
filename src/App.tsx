/* ============================================================================
   EPROSTA — routes
   ----------------------------------------------------------------------------
   The `.html` files of the vanilla build become routes under one shell. Two
   things move as a result:

     · `/` lands on the home page of whichever portal you were last in, which is
       what the old index.html did with a meta-refresh fallback;
     · tier enforcement lives in <Shell>, so every route below inherits it and
       no page has to remember to check.

   `rating`, `flags` and `clients` are imported for their side effects: rating
   publishes derived scores back onto the staff register, flags rehydrates the
   stored flag map, clients replays locally created and edited accounts over the
   seeded register, and hop hands the Order gate its stock check. All four must
   happen before the first screen renders.
   ========================================================================== */

import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/Toast';
import * as PORTAL from './lib/portal';
import './lib/rating';
import './lib/flags';
import './lib/clients';
import './lib/roles';
// Replays charge lines added on the stock register over the seeded rate card.
import './lib/charges';
// Registers the stock guard on the Order gate. See `registerStockGuard`.
import './lib/hop';

import WofsPage from './pages/Wofs';
import WofDetailPage from './pages/WofDetail';
import CalendarPage from './pages/Calendar';
import EventsPage from './pages/Events';
import EventDetailPage from './pages/EventDetail';
import CheckInApprovalsPage from './pages/CheckInApprovals';
import AttendancePage from './pages/Attendance';
import CashflowReport from './pages/ReportCashflow';
import CostingReport from './pages/ReportCosting';
import PayrollReport from './pages/ReportPayroll';
import DocumentsReport from './pages/ReportDocuments';
import ChargesPage from './pages/Charges';
import ClientsPage from './pages/Clients';
import SchedulesPage from './pages/Schedules';
import StaffPage from './pages/Staff';
import JobTypesPage from './pages/JobTypes';
import NotificationsPage from './pages/Notifications';
import KitJobsPage from './pages/warehouse/KitJobs';
import StockPage from './pages/warehouse/Stock';
import TeamSettingsPage from './pages/settings/Team';
import AccountSettingsPage from './pages/settings/Account';
import ClientJobsPage from './pages/ClientJobs';
import ClientJobDetailPage from './pages/ClientJobDetail';
import ClientEventsPage from './pages/ClientEvents';
import ClientAttendancePage from './pages/ClientAttendance';
import StaffJobsPage from './pages/StaffJobs';
import StaffShiftsPage from './pages/StaffShifts';
import StaffPayPage from './pages/StaffPay';
import StaffDocumentsPage from './pages/StaffDocuments';

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route element={<Shell />}>
          {/* Land on the home page of whichever portal you were last in. */}
          <Route index element={<Navigate to={PORTAL.home()} replace />} />

          {/* --- admin ---------------------------------------------------- */}
          <Route path="wofs" element={<WofsPage />} />
          <Route path="wofs/:id" element={<WofDetailPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="events/:id" element={<EventDetailPage />} />
          <Route path="check-in-approvals" element={<CheckInApprovalsPage />} />
          <Route path="attendance" element={<AttendancePage />} />
          <Route path="reports/cashflow" element={<CashflowReport />} />
          <Route path="reports/costing" element={<CostingReport />} />
          <Route path="reports/payroll" element={<PayrollReport />} />
          <Route path="reports/documents" element={<DocumentsReport />} />
          <Route path="warehouse" element={<KitJobsPage />} />
          <Route path="warehouse/stock" element={<StockPage />} />
          <Route path="charges" element={<ChargesPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="schedules" element={<SchedulesPage />} />
          <Route path="staff" element={<StaffPage />} />
          <Route path="job-types" element={<JobTypesPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="settings/team" element={<TeamSettingsPage />} />
          {/* Not tier-guarded: every tier has an account. See `ALWAYS` in portal.ts. */}
          <Route path="settings/account" element={<AccountSettingsPage />} />

          {/* --- client portal -------------------------------------------- */}
          <Route path="client/jobs" element={<ClientJobsPage />} />
          <Route path="client/jobs/:id" element={<ClientJobDetailPage />} />
          <Route path="client/events" element={<ClientEventsPage />} />
          <Route path="client/hours" element={<ClientAttendancePage />} />

          {/* --- staff portal --------------------------------------------- */}
          <Route path="my/jobs" element={<StaffJobsPage />} />
          <Route path="my/shifts" element={<StaffShiftsPage />} />
          <Route path="my/pay" element={<StaffPayPage />} />
          <Route path="my/documents" element={<StaffDocumentsPage />} />

          <Route path="*" element={<Navigate to={PORTAL.home()} replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
