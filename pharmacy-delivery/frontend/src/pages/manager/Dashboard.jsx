import { useEffect, useState } from 'react';
import { listDrivers, recordBackgroundCheck, setCdsaAuth, setDriverStatus } from '../../api/client';
import StatusBadge from '../../components/StatusBadge';
import Spinner from '../../components/Spinner';
import Alert from '../../components/Alert';
import StatCard from '../../components/StatCard';

const PHARMACY_ID = import.meta.env.VITE_PHARMACY_ID || '';

function DriverDetail({ driver, onClose, onRefresh }) {
  const [bgForm, setBgForm] = useState({
    criminal_record_check_date: '',
    criminal_record_check_clear: false,
    vulnerable_sector_check_date: '',
    vulnerable_sector_clear: false,
  });
  const [cdsaForm, setCdsaForm] = useState({ authorized: true, training_date: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  async function submitBgCheck(e) {
    e.preventDefault();
    setLoading(true); setError(''); setSuccess('');
    try {
      const r = await recordBackgroundCheck(driver.id, bgForm);
      setSuccess(r.note);
      onRefresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
    } finally { setLoading(false); }
  }

  async function submitCdsa(e) {
    e.preventDefault();
    setLoading(true); setError(''); setSuccess('');
    try {
      const r = await setCdsaAuth(driver.id, cdsaForm);
      setSuccess(r.message);
      onRefresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
    } finally { setLoading(false); }
  }

  async function toggleStatus() {
    setLoading(true);
    try {
      await setDriverStatus(driver.id, !driver.is_active);
      onRefresh();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="card w-full max-w-lg my-4">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="section-title">{driver.first_name} {driver.last_name}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{driver.email}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {error   && <Alert type="error"   message={error}   onDismiss={() => setError('')} />}
          {success && <Alert type="success" message={success} onDismiss={() => setSuccess('')} />}

          {/* Status summary */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="p-3 rounded-lg bg-gray-50">
              <p className="text-xs text-gray-400 font-medium">Criminal record check</p>
              <p className={`font-semibold mt-0.5 ${driver.criminal_record_check_clear ? 'text-green-700' : 'text-red-600'}`}>
                {driver.criminal_record_check_clear === null ? 'Not recorded' : driver.criminal_record_check_clear ? 'Clear' : 'Failed'}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-gray-50">
              <p className="text-xs text-gray-400 font-medium">CDSA Authorization</p>
              <p className={`font-semibold mt-0.5 ${driver.can_deliver_controlled ? 'text-green-700' : 'text-gray-500'}`}>
                {driver.can_deliver_controlled ? 'Authorized' : 'Not authorized'}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-gray-50">
              <p className="text-xs text-gray-400 font-medium">Cold chain capable</p>
              <p className="font-semibold mt-0.5 text-gray-700">{driver.cold_chain_capable ? 'Yes' : 'No'}</p>
            </div>
            <div className="p-3 rounded-lg bg-gray-50">
              <p className="text-xs text-gray-400 font-medium">License expiry</p>
              <p className="font-semibold mt-0.5 text-gray-700">
                {driver.license_expiry ? new Date(driver.license_expiry).toLocaleDateString('en-CA') : '—'}
              </p>
            </div>
          </div>

          {/* Background check form */}
          <form onSubmit={submitBgCheck} className="space-y-3 border border-gray-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Record background check (NCR s.5)</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label text-xs">Check date</label>
                <input type="date" className="input" value={bgForm.criminal_record_check_date}
                  onChange={(e) => setBgForm({...bgForm, criminal_record_check_date: e.target.value})} required />
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-green-600"
                    checked={bgForm.criminal_record_check_clear}
                    onChange={(e) => setBgForm({...bgForm, criminal_record_check_clear: e.target.checked})} />
                  <span className="text-sm text-gray-700">Record clear</span>
                </label>
              </div>
            </div>
            <button type="submit" className="btn-secondary text-sm" disabled={loading}>Record check</button>
          </form>

          {/* CDSA authorization form */}
          <form onSubmit={submitCdsa} className="space-y-3 border border-gray-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">CDSA controlled delivery authorization</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label text-xs">Training completed</label>
                <input type="date" className="input" value={cdsaForm.training_date}
                  onChange={(e) => setCdsaForm({...cdsaForm, training_date: e.target.value})} required />
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-green-600"
                    checked={cdsaForm.authorized}
                    onChange={(e) => setCdsaForm({...cdsaForm, authorized: e.target.checked})} />
                  <span className="text-sm text-gray-700">Authorize</span>
                </label>
              </div>
            </div>
            <button type="submit" className="btn-secondary text-sm" disabled={loading || !driver.criminal_record_check_clear}>
              {driver.criminal_record_check_clear ? 'Save CDSA authorization' : 'Background check required first'}
            </button>
          </form>

          {/* Activate / deactivate */}
          <button
            className={driver.is_active ? 'btn-danger w-full' : 'btn-success w-full'}
            onClick={toggleStatus} disabled={loading}>
            {driver.is_active ? 'Deactivate driver' : 'Activate driver'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ManagerDashboard() {
  const [drivers, setDrivers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState(null);

  function loadDrivers() {
    setLoading(true);
    listDrivers(PHARMACY_ID)
      .then((d) => setDrivers(d.drivers ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(loadDrivers, []);

  const activeCount    = drivers.filter((d) => d.is_active).length;
  const cdsaCount      = drivers.filter((d) => d.can_deliver_controlled).length;
  const coldChainCount = drivers.filter((d) => d.cold_chain_capable).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Pharmacy Manager — Drivers</h1>
        <p className="text-gray-500 text-sm mt-1">Manage delivery drivers, background checks, and CDSA authorizations (NCR s.5).</p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total drivers"       value={drivers.length}  color="blue" />
        <StatCard label="Active"              value={activeCount}     color="green" />
        <StatCard label="CDSA authorized"     value={cdsaCount}       color="purple" />
        <StatCard label="Cold chain capable"  value={coldChainCount}  color="amber" />
      </div>

      <div className="card">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="section-title">Driver roster</h2>
        </div>
        {loading ? <Spinner size="lg" className="my-10" /> : (
          <div className="divide-y divide-gray-50">
            {drivers.length === 0 ? (
              <div className="p-12 text-center text-gray-400 text-sm">No drivers registered.</div>
            ) : drivers.map((d) => (
              <div key={d.id} className="px-6 py-4 flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-900 text-sm">{d.first_name} {d.last_name}</span>
                    {!d.is_active && <span className="text-xs text-gray-400">(inactive)</span>}
                    {d.can_deliver_controlled && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">CDSA</span>
                    )}
                    {d.cold_chain_capable && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">Cold chain</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {d.license_province} DL · CRC: {d.criminal_record_check_clear === null ? 'pending' : d.criminal_record_check_clear ? 'clear' : 'failed'}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${d.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {d.is_active ? 'Active' : 'Inactive'}
                  </span>
                  <button className="btn-secondary text-xs py-1.5 px-3" onClick={() => setSelected(d)}>
                    Manage
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <DriverDetail
          driver={selected}
          onClose={() => setSelected(null)}
          onRefresh={() => { loadDrivers(); setSelected(null); }}
        />
      )}
    </div>
  );
}
