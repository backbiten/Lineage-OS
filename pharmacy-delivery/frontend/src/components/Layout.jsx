import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth, ROLES } from '../context/AuthContext';

const navItems = {
  [ROLES.PATIENT]: [
    { to: '/patient',                  label: 'Dashboard',      icon: '⊞' },
    { to: '/patient/prescriptions',    label: 'Prescriptions',  icon: '⬡' },
    { to: '/patient/deliveries',       label: 'Deliveries',     icon: '⊡' },
  ],
  [ROLES.TECHNICIAN]: [
    { to: '/technician',               label: 'Intake Queue',   icon: '⊞' },
  ],
  [ROLES.PHARMACIST]: [
    { to: '/pharmacist',               label: 'Verify Queue',   icon: '⊞' },
    { to: '/pharmacist/drivers',       label: 'Drivers',        icon: '⊡' },
  ],
  [ROLES.DRIVER]: [
    { to: '/driver',                   label: 'My Deliveries',  icon: '⊡' },
  ],
  [ROLES.MANAGER]: [
    { to: '/manager',                  label: 'Overview',       icon: '⊞' },
    { to: '/manager/drivers',          label: 'Drivers',        icon: '⊡' },
    { to: '/audit',                    label: 'Audit Log',      icon: '☰' },
    { to: '/manager/inventory',        label: 'Inventory',      icon: '⬡' },
  ],
  [ROLES.ADMIN]: [
    { to: '/admin',                    label: 'Overview',       icon: '⊞' },
    { to: '/audit',                    label: 'Audit Log',      icon: '☰' },
  ],
  [ROLES.AUDITOR]: [
    { to: '/audit',                    label: 'Audit Log',      icon: '☰' },
  ],
};

function CrossIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v8m0 0v8m0-8h8m-8 0H4" />
    </svg>
  );
}

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const items = navItems[user?.role] ?? [];

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const roleLabel = {
    [ROLES.PATIENT]:    'Patient',
    [ROLES.TECHNICIAN]: 'Pharmacy Technician',
    [ROLES.PHARMACIST]: 'Pharmacist',
    [ROLES.DRIVER]:     'Delivery Driver',
    [ROLES.MANAGER]:    'Pharmacy Manager',
    [ROLES.ADMIN]:      'System Admin',
    [ROLES.AUDITOR]:    'Regulatory Auditor',
  }[user?.role] ?? user?.role;

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col shrink-0">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2.5">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <CrossIcon />
          </div>
          <div>
            <p className="font-bold text-gray-900 text-sm leading-tight">PharmaCare</p>
            <p className="text-xs text-gray-500 leading-tight">Delivery Platform</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/patient' || item.to === '/pharmacist' || item.to === '/technician' || item.to === '/driver' || item.to === '/manager' || item.to === '/admin'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`
              }
            >
              <span className="text-base leading-none">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User info + logout */}
        <div className="px-3 py-4 border-t border-gray-100">
          <div className="px-3 py-2 mb-1">
            <p className="text-sm font-medium text-gray-900 truncate">
              {user?.first_name} {user?.last_name}
            </p>
            <p className="text-xs text-gray-500 truncate">{roleLabel}</p>
          </div>
          <button
            onClick={handleLogout}
            className="w-full text-left px-3 py-2 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
