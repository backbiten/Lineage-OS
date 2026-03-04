import { useEffect, useState } from 'react';
import { getTechnicianQueue, searchDrugs, intakePrescription } from '../../api/client';
import StatusBadge from '../../components/StatusBadge';
import Spinner from '../../components/Spinner';
import Alert from '../../components/Alert';
import StatCard from '../../components/StatCard';

const PHARMACY_ID = import.meta.env.VITE_PHARMACY_ID || '';

function IntakeModal({ onClose, onDone }) {
  const [step, setStep]       = useState(1);
  const [drugSearch, setDrugSearch] = useState('');
  const [drugs, setDrugs]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const [form, setForm] = useState({
    drug_id: '', patient_id: '', prescriber_id: '',
    pharmacy_id: PHARMACY_ID,
    written_date: '', expiry_date: '',
    quantity_prescribed: '', quantity_unit: 'tablet',
    directions: '', refills_authorized: '0',
    // Intake checklist
    patient_identity_confirmed: false,
    allergy_check_performed: false,
    drug_interaction_check: false,
    prescriber_valid: false,
    rx_not_expired: false,
    original_rx_obtained: false,
    notes: '',
  });

  async function handleDrugSearch() {
    if (drugSearch.length < 2) return;
    setLoading(true);
    const data = await searchDrugs({ q: drugSearch, limit: 10 });
    setDrugs(data.drugs ?? []);
    setLoading(false);
  }

  function set(field, val) { setForm((f) => ({ ...f, [field]: val })); }

  async function handleSubmit(e) {
    e.preventDefault();
    const allChecked = form.patient_identity_confirmed && form.allergy_check_performed &&
      form.drug_interaction_check && form.prescriber_valid;
    if (!allChecked) { setError('Complete all intake checklist items before submitting'); return; }

    setLoading(true);
    setError('');
    try {
      const result = await intakePrescription({
        drug_id:             form.drug_id,
        patient_id:          form.patient_id,
        prescriber_id:       form.prescriber_id,
        pharmacy_id:         form.pharmacy_id,
        written_date:        form.written_date,
        expiry_date:         form.expiry_date,
        quantity_prescribed: parseFloat(form.quantity_prescribed),
        quantity_unit:       form.quantity_unit,
        directions:          form.directions,
        refills_authorized:  parseInt(form.refills_authorized, 10),
      });
      onDone(result);
    } catch (err) {
      setError(err.response?.data?.error || 'Intake failed');
    } finally {
      setLoading(false);
    }
  }

  const CheckItem = ({ field, label }) => (
    <label className="flex items-start gap-3 cursor-pointer py-2 px-3 rounded-lg hover:bg-gray-50">
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
        checked={form[field]} onChange={() => set(field, !form[field])} />
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="card w-full max-w-2xl my-4">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="section-title">New Prescription Intake</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4">
            {error && <Alert type="error" message={error} onDismiss={() => setError('')} />}

            {/* Drug search */}
            <div>
              <label className="label">Drug / Medication</label>
              <div className="flex gap-2">
                <input className="input flex-1" placeholder="Search by name or DIN…"
                  value={drugSearch} onChange={(e) => setDrugSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleDrugSearch())} />
                <button type="button" className="btn-secondary" onClick={handleDrugSearch}>Search</button>
              </div>
              {drugs.length > 0 && (
                <div className="mt-1 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-40 overflow-y-auto">
                  {drugs.map((d) => (
                    <button key={d.id} type="button"
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors ${form.drug_id === d.id ? 'bg-blue-50 text-blue-700' : ''}`}
                      onClick={() => { set('drug_id', d.id); setDrugs([]); setDrugSearch(`${d.brand_name} (${d.generic_name}) ${d.strength}`); }}>
                      <span className="font-medium">{d.brand_name}</span>
                      <span className="text-gray-500"> — {d.generic_name} {d.strength}</span>
                      {d.is_narcotic && <span className="ml-2 text-xs text-red-600 font-medium">Narcotic</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Patient ID (UUID)</label>
                <input className="input font-mono text-xs" placeholder="patient UUID"
                  value={form.patient_id} onChange={(e) => set('patient_id', e.target.value)} required />
              </div>
              <div>
                <label className="label">Prescriber ID (UUID)</label>
                <input className="input font-mono text-xs" placeholder="prescriber UUID"
                  value={form.prescriber_id} onChange={(e) => set('prescriber_id', e.target.value)} required />
              </div>
              <div>
                <label className="label">Written date</label>
                <input type="date" className="input" value={form.written_date} onChange={(e) => set('written_date', e.target.value)} required />
              </div>
              <div>
                <label className="label">Expiry date</label>
                <input type="date" className="input" value={form.expiry_date} onChange={(e) => set('expiry_date', e.target.value)} required />
              </div>
              <div>
                <label className="label">Quantity</label>
                <input type="number" step="0.001" className="input" value={form.quantity_prescribed}
                  onChange={(e) => set('quantity_prescribed', e.target.value)} required min="0.001" />
              </div>
              <div>
                <label className="label">Unit</label>
                <select className="input" value={form.quantity_unit} onChange={(e) => set('quantity_unit', e.target.value)}>
                  {['tablet','capsule','mL','g','patch','unit','vial'].map((u) => <option key={u}>{u}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="label">Directions (sig)</label>
              <textarea className="input" rows={2} value={form.directions}
                onChange={(e) => set('directions', e.target.value)} required
                placeholder="e.g. Take 1 tablet by mouth twice daily with food" />
            </div>

            <div>
              <label className="label">Refills authorized</label>
              <input type="number" className="input w-24" min="0" max="12" value={form.refills_authorized}
                onChange={(e) => set('refills_authorized', e.target.value)} />
            </div>

            {/* Intake checklist */}
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                Intake checklist (NAPRA Model Standards s.3.0)
              </p>
              <div className="space-y-0.5">
                <CheckItem field="patient_identity_confirmed" label="Patient identity confirmed" />
                <CheckItem field="allergy_check_performed"    label="Allergy and intolerance check performed" />
                <CheckItem field="drug_interaction_check"     label="Drug interaction check performed" />
                <CheckItem field="prescriber_valid"           label="Prescriber identity and authority verified" />
                <CheckItem field="original_rx_obtained"       label="Original written prescription obtained (required for narcotics)" />
              </div>
            </div>

            <div>
              <label className="label">Notes for pharmacist (optional)</label>
              <textarea className="input" rows={2} value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="Any flags or concerns for the verifying pharmacist…" />
            </div>
          </div>

          <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? <Spinner size="sm" className="mr-2" /> : null}
              {loading ? 'Submitting…' : 'Submit for pharmacist review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function TechnicianDashboard() {
  const [queue, setQueue]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showIntake, setShowIntake] = useState(false);
  const [toast, setToast]       = useState('');

  function loadQueue() {
    setLoading(true);
    getTechnicianQueue(PHARMACY_ID)
      .then((d) => setQueue(d.queue ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(loadQueue, []);

  function handleIntakeDone(result) {
    setShowIntake(false);
    setToast(`Rx #${result.rx_number} received and routed to pharmacist for verification.`);
    loadQueue();
    setTimeout(() => setToast(''), 5000);
  }

  const pendingCount   = queue.filter((r) => r.status === 'RECEIVED').length;
  const controlledCount = queue.filter((r) => r.is_controlled).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="page-title">Technician Intake Queue</h1>
          <p className="text-gray-500 text-sm mt-1">
            Step 1 of the dispensing workflow — RPhT intake and data entry (NAPRA s.3.0).
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowIntake(true)}>
          + New Intake
        </button>
      </div>

      {toast && <Alert type="success" message={toast} onDismiss={() => setToast('')} />}

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="In queue"          value={queue.length}     color="blue" />
        <StatCard label="Pending intake"    value={pendingCount}     color="amber" />
        <StatCard label="Controlled drugs"  value={controlledCount}  color="red" />
      </div>

      <div className="card">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="section-title">Work queue</h2>
          <p className="text-xs text-gray-400 mt-0.5">Controlled substances prioritized, then by intake time</p>
        </div>

        {loading ? <Spinner size="lg" className="my-10" /> : (
          <div className="divide-y divide-gray-50">
            {queue.length === 0 ? (
              <div className="p-12 text-center text-gray-400 text-sm">Queue is clear.</div>
            ) : queue.map((rx) => (
              <div key={rx.id} className="px-6 py-4 flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900 text-sm">{rx.brand_name}</span>
                    {rx.generic_name !== rx.brand_name && <span className="text-sm text-gray-500">({rx.generic_name})</span>}
                    {rx.is_controlled && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-red-100 text-red-700">
                        Controlled
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Rx #{rx.rx_number} · Patient: {rx.patient_name}
                    · Received: {new Date(rx.created_at).toLocaleString('en-CA')}
                  </p>
                </div>
                <StatusBadge status={rx.status} />
              </div>
            ))}
          </div>
        )}
      </div>

      {showIntake && <IntakeModal onClose={() => setShowIntake(false)} onDone={handleIntakeDone} />}
    </div>
  );
}
