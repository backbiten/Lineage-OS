import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { registerPatient } from '../api/client';
import Alert from '../components/Alert';
import Spinner from '../components/Spinner';

const PROVINCES = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];

export default function Register() {
  const { login } = useAuth();
  const navigate   = useNavigate();
  const [step, setStep]   = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    email: '', password: '', confirmPassword: '',
    first_name: '', last_name: '', date_of_birth: '', phone: '',
    address_street: '', address_city: '', address_postal: '', address_province: 'ON',
    marketing_consent: false,
    consent_controlled_delivery: false,
  });

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (form.password.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }
    setLoading(true);
    try {
      const { token, user } = await registerPatient({
        email:            form.email,
        password:         form.password,
        first_name:       form.first_name,
        last_name:        form.last_name,
        date_of_birth:    form.date_of_birth,
        phone:            form.phone || undefined,
        address_street:   form.address_street,
        address_city:     form.address_city,
        address_postal:   form.address_postal,
        address_province: form.address_province,
        marketing_consent:              form.marketing_consent,
        consent_controlled_delivery:    form.consent_controlled_delivery,
      });
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      navigate('/patient', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-600 rounded-xl mb-3">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v8m0 0v8m0-8h8m-8 0H4" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Create your account</h1>
          <p className="text-gray-500 text-sm">PharmaCare Delivery — Patient Portal</p>
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                step >= s ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'
              }`}>{s}</div>
              {s < 3 && <div className={`w-8 h-0.5 ${step > s ? 'bg-blue-600' : 'bg-gray-200'}`} />}
            </div>
          ))}
        </div>

        <div className="card p-8">
          {error && <Alert type="error" message={error} onDismiss={() => setError('')} className="mb-4" />}

          <form onSubmit={step < 3 ? (e) => { e.preventDefault(); setStep(step + 1); } : handleSubmit}
                className="space-y-4">

            {/* Step 1 — Account */}
            {step === 1 && (
              <>
                <h2 className="section-title mb-4">Account credentials</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">First name</label>
                    <input className="input" value={form.first_name} onChange={(e) => set('first_name', e.target.value)} required />
                  </div>
                  <div>
                    <label className="label">Last name</label>
                    <input className="input" value={form.last_name} onChange={(e) => set('last_name', e.target.value)} required />
                  </div>
                </div>
                <div>
                  <label className="label">Email address</label>
                  <input type="email" className="input" value={form.email} onChange={(e) => set('email', e.target.value)} required />
                </div>
                <div>
                  <label className="label">Password <span className="text-gray-400 font-normal">(min. 12 characters)</span></label>
                  <input type="password" className="input" value={form.password} onChange={(e) => set('password', e.target.value)} required minLength={12} />
                </div>
                <div>
                  <label className="label">Confirm password</label>
                  <input type="password" className="input" value={form.confirmPassword} onChange={(e) => set('confirmPassword', e.target.value)} required />
                </div>
              </>
            )}

            {/* Step 2 — Personal info */}
            {step === 2 && (
              <>
                <h2 className="section-title mb-4">Personal information</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Date of birth</label>
                    <input type="date" className="input" value={form.date_of_birth} onChange={(e) => set('date_of_birth', e.target.value)} required />
                  </div>
                  <div>
                    <label className="label">Phone (optional)</label>
                    <input type="tel" className="input" placeholder="416-555-0100" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                  </div>
                </div>
                <div>
                  <label className="label">Street address</label>
                  <input className="input" value={form.address_street} onChange={(e) => set('address_street', e.target.value)} required />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="label">City</label>
                    <input className="input" value={form.address_city} onChange={(e) => set('address_city', e.target.value)} required />
                  </div>
                  <div>
                    <label className="label">Province</label>
                    <select className="input" value={form.address_province} onChange={(e) => set('address_province', e.target.value)}>
                      {PROVINCES.map((p) => <option key={p}>{p}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label">Postal code</label>
                  <input className="input uppercase w-40" placeholder="A1A 1A1" value={form.address_postal} onChange={(e) => set('address_postal', e.target.value.toUpperCase())} required maxLength={7} />
                </div>
              </>
            )}

            {/* Step 3 — Consent */}
            {step === 3 && (
              <>
                <h2 className="section-title mb-1">Consent and privacy</h2>
                <p className="text-sm text-gray-500 mb-4">
                  Your privacy is protected under PIPEDA and applicable provincial legislation.
                </p>
                <div className="space-y-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      checked={form.consent_controlled_delivery}
                      onChange={(e) => set('consent_controlled_delivery', e.target.checked)} />
                    <span className="text-sm text-gray-700">
                      <strong>Controlled substance delivery consent</strong> — I consent to the delivery of
                      controlled medications to my registered address. I understand I must present valid
                      government-issued photo ID at delivery (CDSA s.4).
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      checked={form.marketing_consent}
                      onChange={(e) => set('marketing_consent', e.target.checked)} />
                    <span className="text-sm text-gray-700">
                      <strong>Marketing consent (optional)</strong> — I agree to receive health tips and
                      pharmacy promotions by email. I can unsubscribe at any time (CASL).
                    </span>
                  </label>
                </div>
                <div className="mt-4 p-3 bg-blue-50 rounded-lg text-xs text-blue-700">
                  By creating an account you agree to our Terms of Service and acknowledge our
                  Privacy Policy. Your personal health information is protected and will not be
                  disclosed without your consent except as required by law.
                </div>
              </>
            )}

            <div className="flex gap-3 pt-2">
              {step > 1 && (
                <button type="button" className="btn-secondary flex-1" onClick={() => setStep(step - 1)}>
                  Back
                </button>
              )}
              <button type="submit" className="btn-primary flex-1" disabled={loading}>
                {loading && <Spinner size="sm" className="mr-2" />}
                {step < 3 ? 'Continue' : loading ? 'Creating account…' : 'Create account'}
              </button>
            </div>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-4">
          Already have an account?{' '}
          <Link to="/login" className="text-blue-600 font-medium hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
