import { useEffect, useState } from 'react';
import { getPharmacistQueue, getPrescription, verifyPrescription } from '../../api/client';
import StatusBadge from '../../components/StatusBadge';
import Spinner from '../../components/Spinner';
import Alert from '../../components/Alert';
import StatCard from '../../components/StatCard';

const PHARMACY_ID = import.meta.env.VITE_PHARMACY_ID || '';

function VerifyModal({ rx, onClose, onDone }) {
  const [decision, setDecision] = useState({
    approved: null,
    clinical_appropriateness_verified: false,
    dose_within_range: false,
    no_contraindications: false,
    patient_counselling_provided: false,
    rx_authentic: false,
    prescriber_authority_confirmed: false,
    rejection_reason: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const allChecked = decision.clinical_appropriateness_verified &&
    decision.dose_within_range &&
    decision.no_contraindications &&
    decision.patient_counselling_provided &&
    (!rx.is_narcotic || (decision.rx_authentic && decision.prescriber_authority_confirmed));

  async function submit(approved) {
    setLoading(true);
    setError('');
    try {
      await verifyPrescription(rx.id, { ...decision, approved });
      onDone(approved ? 'approved' : 'rejected');
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  function check(field) {
    setDecision((d) => ({ ...d, [field]: !d[field] }));
  }

  const CheckItem = ({ field, label, required = true }) => (
    <label className={`flex items-start gap-3 cursor-pointer py-2 px-3 rounded-lg hover:bg-gray-50 ${required && !decision[field] ? '' : ''}`}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-green-600"
        checked={decision[field]} onChange={() => check(field)} />
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="card w-full max-w-2xl my-4">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="section-title">Pharmacist Verification — Rx #{rx.rx_number}</h3>
          <p className="text-sm text-gray-500 mt-1">
            {rx.brand_name} ({rx.generic_name}) · {rx.strength} · {rx.dosage_form}
          </p>
          {rx.is_narcotic && (
            <div className="mt-2 flex items-center gap-2 text-xs font-medium text-red-700 bg-red-50 px-3 py-2 rounded-lg">
              ⚠ CDSA Controlled Substance — additional verification required
            </div>
          )}
        </div>

        <div className="px-6 py-4 space-y-1">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Clinical checklist</p>
          <CheckItem field="clinical_appropriateness_verified" label="Clinical appropriateness verified — drug, dose, and indication are appropriate for this patient" />
          <CheckItem field="dose_within_range"                 label="Dose is within accepted therapeutic range" />
          <CheckItem field="no_contraindications"              label="No contraindications or clinically significant interactions identified" />
          <CheckItem field="patient_counselling_provided"      label="Patient counselling provided or arranged (FDA s.9)" />
          {rx.is_narcotic && (
            <>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-4 mb-2">Controlled substance requirements (NCR)</p>
              <CheckItem field="rx_authentic"                  label="Original written prescription received and verified as authentic" />
              <CheckItem field="prescriber_authority_confirmed" label="Prescriber's authority to prescribe controlled substances confirmed" />
            </>
          )}
        </div>

        {error && <div className="px-6 pb-2"><Alert type="error" message={error} /></div>}

        <div className="px-6 py-4 border-t border-gray-100 space-y-3">
          {!allChecked && (
            <p className="text-xs text-amber-600">Complete all checklist items before approving.</p>
          )}
          <div className="flex gap-3">
            <button className="btn-secondary flex-1" onClick={onClose} disabled={loading}>Cancel</button>
            <button className="btn-danger flex-1" onClick={() => submit(false)} disabled={loading}>
              {loading ? <Spinner size="sm" className="mr-1" /> : null} Reject
            </button>
            <button className="btn-success flex-1" onClick={() => submit(true)} disabled={loading || !allChecked}>
              {loading ? <Spinner size="sm" className="mr-1" /> : null} Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PharmacistDashboard() {
  const [queue, setQueue]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState(null);
  const [rxDetail, setRxDetail] = useState(null);
  const [toast, setToast]       = useState('');

  function loadQueue() {
    setLoading(true);
    getPharmacistQueue(PHARMACY_ID)
      .then((d) => setQueue(d.queue ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(loadQueue, []);

  async function openVerify(rx) {
    const detail = await getPrescription(rx.id);
    setRxDetail(detail);
    setSelected(rx);
  }

  function handleDone(result) {
    setSelected(null);
    setRxDetail(null);
    setToast(result === 'approved' ? 'Prescription approved and queued for dispensing.' : 'Prescription rejected.');
    loadQueue();
    setTimeout(() => setToast(''), 4000);
  }

  const narcoticCount = queue.filter((r) => r.is_narcotic).length;
  const urgentCount   = queue.filter((r) => r.is_controlled).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Pharmacist Verification Queue</h1>
        <p className="text-gray-500 text-sm mt-1">
          All prescriptions require mandatory clinical review before dispensing (CDSA s.31 / FDA s.9.1).
        </p>
      </div>

      {toast && <Alert type={toast.includes('rejected') ? 'warning' : 'success'} message={toast} />}

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Pending Review"    value={queue.length}   color="blue" />
        <StatCard label="Controlled Drugs"  value={urgentCount}    color="amber" />
        <StatCard label="Narcotics"         value={narcoticCount}  color="red" />
      </div>

      <div className="card">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="section-title">Prescriptions awaiting review</h2>
          <p className="text-xs text-gray-400 mt-0.5">Sorted by controlled substance priority, then intake time (oldest first)</p>
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
                    {rx.generic_name !== rx.brand_name && (
                      <span className="text-sm text-gray-500">({rx.generic_name})</span>
                    )}
                    {rx.is_narcotic && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-red-100 text-red-700">
                        NARCOTIC
                      </span>
                    )}
                    {rx.is_controlled && !rx.is_narcotic && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                        Controlled
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Rx #{rx.rx_number} · Patient: {rx.patient_name}
                    · Intake: {new Date(rx.created_at).toLocaleString('en-CA')}
                  </p>
                  {rx.controlled_substance_flags && (
                    <p className="text-xs text-amber-700 mt-1">⚠ Tech note: {rx.controlled_substance_flags}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <StatusBadge status={rx.status} />
                  <button className="btn-primary text-xs py-1.5 px-3" onClick={() => openVerify(rx)}>
                    Verify
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && rxDetail && (
        <VerifyModal rx={rxDetail} onClose={() => { setSelected(null); setRxDetail(null); }} onDone={handleDone} />
      )}
    </div>
  );
}
