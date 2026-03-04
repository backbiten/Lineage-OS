import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth, roleDashboard } from '../context/AuthContext';
import Alert from '../components/Alert';
import Spinner from '../components/Spinner';

export default function Login() {
  const { login } = useAuth();
  const navigate   = useNavigate();
  const [form, setForm]     = useState({ email: '', password: '' });
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await login(form.email, form.password);
      navigate(roleDashboard(user.role), { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4 shadow-lg">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v8m0 0v8m0-8h8m-8 0H4" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">PharmaCare Delivery</h1>
          <p className="text-gray-500 text-sm mt-1">Regulated pharmacy-to-patient delivery</p>
        </div>

        <div className="card p-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">Sign in to your account</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <Alert type="error" message={error} onDismiss={() => setError('')} />}

            <div>
              <label className="label">Email address</label>
              <input
                type="email"
                className="input"
                placeholder="you@example.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                autoFocus
              />
            </div>

            <div>
              <label className="label">Password</label>
              <input
                type="password"
                className="input"
                placeholder="••••••••••••"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
              />
            </div>

            <button type="submit" className="btn-primary w-full mt-2" disabled={loading}>
              {loading ? <Spinner size="sm" className="mr-2" /> : null}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-6">
            New patient?{' '}
            <Link to="/register" className="text-blue-600 font-medium hover:underline">
              Create an account
            </Link>
          </p>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          CDSA · PIPEDA · PHIPA compliant &bull; Powered by PharmaCare
        </p>
      </div>
    </div>
  );
}
