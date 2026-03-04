import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth, ROLES, roleDashboard } from './context/AuthContext';
import Layout from './components/Layout';

// Pages
import Login    from './pages/Login';
import Register from './pages/Register';
import AuditLog from './pages/AuditLog';

import PatientDashboard   from './pages/patient/Dashboard';
import Prescriptions      from './pages/patient/Prescriptions';
import Deliveries         from './pages/patient/Deliveries';

import PharmacistDashboard from './pages/pharmacist/Dashboard';
import TechnicianDashboard from './pages/technician/Dashboard';
import DriverDashboard     from './pages/driver/Dashboard';
import ManagerDashboard    from './pages/manager/Dashboard';

// ── Route guards ──────────────────────────────────────────────────────────────

function RequireAuth({ children, allowedRoles }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to={roleDashboard(user.role)} replace />;
  }
  return <Layout>{children}</Layout>;
}

function PublicOnly({ children }) {
  const { user } = useAuth();
  if (user) return <Navigate to={roleDashboard(user.role)} replace />;
  return children;
}

// ── App ───────────────────────────────────────────────────────────────────────

function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login"    element={<PublicOnly><Login /></PublicOnly>} />
      <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />

      {/* Patient portal */}
      <Route path="/patient" element={
        <RequireAuth allowedRoles={[ROLES.PATIENT]}>
          <PatientDashboard />
        </RequireAuth>
      } />
      <Route path="/patient/prescriptions" element={
        <RequireAuth allowedRoles={[ROLES.PATIENT]}>
          <Prescriptions />
        </RequireAuth>
      } />
      <Route path="/patient/deliveries" element={
        <RequireAuth allowedRoles={[ROLES.PATIENT]}>
          <Deliveries />
        </RequireAuth>
      } />

      {/* Pharmacy technician */}
      <Route path="/technician" element={
        <RequireAuth allowedRoles={[ROLES.TECHNICIAN]}>
          <TechnicianDashboard />
        </RequireAuth>
      } />

      {/* Pharmacist */}
      <Route path="/pharmacist" element={
        <RequireAuth allowedRoles={[ROLES.PHARMACIST, ROLES.MANAGER]}>
          <PharmacistDashboard />
        </RequireAuth>
      } />
      <Route path="/pharmacist/drivers" element={
        <RequireAuth allowedRoles={[ROLES.PHARMACIST, ROLES.MANAGER]}>
          <ManagerDashboard />
        </RequireAuth>
      } />

      {/* Driver */}
      <Route path="/driver" element={
        <RequireAuth allowedRoles={[ROLES.DRIVER]}>
          <DriverDashboard />
        </RequireAuth>
      } />

      {/* Manager */}
      <Route path="/manager" element={
        <RequireAuth allowedRoles={[ROLES.MANAGER, ROLES.ADMIN]}>
          <ManagerDashboard />
        </RequireAuth>
      } />
      <Route path="/manager/drivers" element={
        <RequireAuth allowedRoles={[ROLES.MANAGER, ROLES.ADMIN]}>
          <ManagerDashboard />
        </RequireAuth>
      } />

      {/* Audit log */}
      <Route path="/audit" element={
        <RequireAuth allowedRoles={[ROLES.PHARMACIST, ROLES.MANAGER, ROLES.ADMIN, ROLES.AUDITOR]}>
          <AuditLog />
        </RequireAuth>
      } />

      {/* Admin */}
      <Route path="/admin" element={
        <RequireAuth allowedRoles={[ROLES.ADMIN]}>
          <AuditLog />
        </RequireAuth>
      } />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
