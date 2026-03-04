import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getMyPrescriptions, requestRefill } from '../../api/client';
import StatusBadge from '../../components/StatusBadge';
import Spinner from '../../components/Spinner';
import Alert from '../../components/Alert';

function RefillModal({ rx, onClose, onSuccess }) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  async function handleRefill() {
    setLoading(true);
    setError('');
    try {
      await requestRefill({ prescription_id: rx.id, pharmacy_id: rx.pharmacy_id });
      onSuccess();
    } catch (err) {
      setError(err.response?.data?.error || 'Refill request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-md p-6">
        <h3 className="section-title mb-2">Request Refill</h3>
        <p className="text-sm text-gray-600 mb-4">
          You are requesting a refill for <strong>{rx.brand_name}</strong> ({rx.rx_number}).
          Your pharmacist will review the request before dispensing.
        </p>
        {error && <Alert type="error" message={error} className="mb-3" />}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleRefill} disabled={loading}>
            {loading ? <Spinner size="sm" className="mr-2" /> : null}
            {loading ? 'Submitting…' : 'Submit refill request'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Prescriptions() {
  const [searchParams] = useSearchParams();
  const [rxs, setRxs]         = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [success, setSuccess]   = useState('');
  const [page, setPage]         = useState(1);

  useEffect(() => {
    setLoading(true);
    getMyPrescriptions(page)
      .then((d) => setRxs(d.prescriptions ?? []))
      .finally(() => setLoading(false));
  }, [page]);

  // Auto-open refill modal if linked from dashboard
  useEffect(() => {
    const id = searchParams.get('refill');
    if (id && rxs.length > 0) {
      const rx = rxs.find((r) => r.id === id);
      if (rx) setSelected(rx);
    }
  }, [searchParams, rxs]);

  function handleRefillSuccess() {
    setSelected(null);
    setSuccess('Refill request submitted. Your pharmacist will review it shortly.');
    getMyPrescriptions(page).then((d) => setRxs(d.prescriptions ?? []));
  }

  if (loading) return <Spinner size="lg" className="mt-20" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">My Prescriptions</h1>
        <p className="text-gray-500 text-sm mt-1">{rxs.length} prescription{rxs.length !== 1 ? 's' : ''} on file</p>
      </div>

      {success && <Alert type="success" message={success} onDismiss={() => setSuccess('')} />}

      <div className="card divide-y divide-gray-100">
        {rxs.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">No prescriptions found.</div>
        ) : rxs.map((rx) => (
          <div key={rx.id} className="p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-gray-900">{rx.brand_name}</span>
                  {rx.generic_name !== rx.brand_name && (
                    <span className="text-sm text-gray-500">({rx.generic_name})</span>
                  )}
                  {rx.is_controlled && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                      Controlled
                    </span>
                  )}
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-0.5 text-sm text-gray-500">
                  <span>Rx #{rx.rx_number}</span>
                  <span>{rx.dosage_form} · {rx.strength}</span>
                  <span>Qty: {rx.quantity_prescribed} {rx.quantity_unit}</span>
                  {rx.directions && <span className="col-span-2 text-xs italic mt-0.5">{rx.directions}</span>}
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-gray-400">
                  <span>Pharmacy: {rx.pharmacy_name}</span>
                  {rx.refills_remaining > 0 && (
                    <span className="text-green-600 font-medium">
                      {rx.refills_remaining} refill{rx.refills_remaining !== 1 ? 's' : ''} remaining
                    </span>
                  )}
                  <span>Expires: {new Date(rx.expiry_date).toLocaleDateString('en-CA')}</span>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <StatusBadge status={rx.status} />
                {['DELIVERED','DISPENSED','FILLED'].includes(rx.status) && rx.refills_remaining > 0 && !rx.is_controlled && (
                  <button
                    className="btn-primary text-xs py-1.5 px-3"
                    onClick={() => setSelected(rx)}
                  >
                    Refill
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <div className="flex justify-between items-center text-sm text-gray-500">
        <button className="btn-secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
          Previous
        </button>
        <span>Page {page}</span>
        <button className="btn-secondary" onClick={() => setPage((p) => p + 1)} disabled={rxs.length < 20}>
          Next
        </button>
      </div>

      {selected && (
        <RefillModal rx={selected} onClose={() => setSelected(null)} onSuccess={handleRefillSuccess} />
      )}
    </div>
  );
}
