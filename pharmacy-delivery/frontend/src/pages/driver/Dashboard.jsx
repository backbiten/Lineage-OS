import { useEffect, useState } from 'react';
import { getDriverActiveOrders, confirmPickup, recordDeliveryAttempt } from '../../api/client';
import StatusBadge from '../../components/StatusBadge';
import Spinner from '../../components/Spinner';
import Alert from '../../components/Alert';

function PickupModal({ order, onClose, onDone }) {
  const [sealVerified, setSealVerified] = useState(false);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');

  async function handleConfirm() {
    if (!sealVerified) { setError('You must verify the tamper-evident seal before confirming pickup'); return; }
    setLoading(true);
    try {
      await confirmPickup(order.id, true);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Pickup confirmation failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-md p-6">
        <h3 className="section-title mb-2">Confirm Pickup — Order #{order.order_number}</h3>
        {order.contains_controlled && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
            <strong>Controlled substances</strong> — ID verification and signature mandatory at delivery (CDSA s.4).
          </div>
        )}
        <div className="space-y-3 mb-4">
          <label className="flex items-start gap-3 cursor-pointer py-2 px-3 rounded-lg bg-gray-50">
            <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
              checked={sealVerified} onChange={(e) => setSealVerified(e.target.checked)} />
            <span className="text-sm text-gray-700">
              I have inspected the tamper-evident seal and confirmed it is intact
              {order.tamper_evident_seal && ` (Seal #${order.tamper_evident_seal})`}
            </span>
          </label>
        </div>
        {error && <Alert type="error" message={error} className="mb-3" />}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleConfirm} disabled={loading || !sealVerified}>
            {loading ? <Spinner size="sm" className="mr-2" /> : null}
            Confirm pickup
          </button>
        </div>
      </div>
    </div>
  );
}

function AttemptModal({ order, onClose, onDone }) {
  const [form, setForm] = useState({
    result: 'SUCCESS',
    id_verified: false,
    id_type: '',
    notes: '',
    gps_lat: '', gps_lon: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  function set(field, val) { setForm((f) => ({ ...f, [field]: val })); }

  const needsIdVerification = order.contains_controlled && form.result === 'SUCCESS';

  async function handleSubmit(e) {
    e.preventDefault();
    if (needsIdVerification && !form.id_verified) {
      setError('ID verification is mandatory for controlled substance deliveries (CDSA s.4)');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await recordDeliveryAttempt(order.id, {
        result:       form.result,
        id_verified:  form.id_verified,
        id_type:      form.id_type || undefined,
        notes:        form.notes || undefined,
        gps_lat:      form.gps_lat ? parseFloat(form.gps_lat) : undefined,
        gps_lon:      form.gps_lon ? parseFloat(form.gps_lon) : undefined,
      });
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record attempt');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="card w-full max-w-md my-4 p-6">
        <h3 className="section-title mb-4">Record Delivery — Order #{order.order_number}</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Delivery result</label>
            <select className="input" value={form.result} onChange={(e) => set('result', e.target.value)}>
              <option value="SUCCESS">Delivered successfully</option>
              <option value="NO_ANSWER">No answer</option>
              <option value="WRONG_ADDRESS">Wrong address</option>
              <option value="REFUSED">Refused at door</option>
              <option value="ID_VERIFICATION_FAILED">ID verification failed</option>
              <option value="SIGNATURE_REFUSED">Signature refused</option>
            </select>
          </div>

          {form.result === 'SUCCESS' && (
            <>
              {order.contains_controlled && (
                <div>
                  <label className="flex items-start gap-3 cursor-pointer py-2 px-3 bg-amber-50 rounded-lg">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
                      checked={form.id_verified} onChange={(e) => set('id_verified', e.target.checked)} />
                    <span className="text-sm text-gray-700">
                      <strong>ID verified</strong> — Government-issued photo ID checked (CDSA s.4 — mandatory for controlled substances)
                    </span>
                  </label>
                  {form.id_verified && (
                    <div className="mt-2">
                      <label className="label">ID type presented</label>
                      <input className="input" placeholder="e.g. Ontario Driver's License, Passport"
                        value={form.id_type} onChange={(e) => set('id_type', e.target.value)} />
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">GPS Latitude (optional)</label>
                  <input className="input" type="number" step="0.0000001" placeholder="43.6532"
                    value={form.gps_lat} onChange={(e) => set('gps_lat', e.target.value)} />
                </div>
                <div>
                  <label className="label">GPS Longitude (optional)</label>
                  <input className="input" type="number" step="0.0000001" placeholder="-79.3832"
                    value={form.gps_lon} onChange={(e) => set('gps_lon', e.target.value)} />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="label">Notes (optional)</label>
            <textarea className="input" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>

          {error && <Alert type="error" message={error} />}

          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? <Spinner size="sm" className="mr-2" /> : null}
              Submit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function DriverDashboard() {
  const [orders, setOrders]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [pickupOrder, setPickup] = useState(null);
  const [attemptOrder, setAttempt] = useState(null);
  const [toast, setToast]       = useState('');

  function loadOrders() {
    setLoading(true);
    getDriverActiveOrders()
      .then((d) => setOrders(d.orders ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(loadOrders, []);

  function handleDone(msg) {
    setPickup(null);
    setAttempt(null);
    setToast(msg);
    loadOrders();
    setTimeout(() => setToast(''), 4000);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">My Active Deliveries</h1>
        <p className="text-gray-500 text-sm mt-1">{orders.length} order{orders.length !== 1 ? 's' : ''} assigned to you</p>
      </div>

      {toast && <Alert type="success" message={toast} onDismiss={() => setToast('')} />}

      {loading ? <Spinner size="lg" className="mt-20" /> : (
        orders.length === 0 ? (
          <div className="card p-12 text-center text-gray-400 text-sm">
            No active deliveries. Check back when orders are assigned to you.
          </div>
        ) : (
          <div className="space-y-4">
            {orders.map((order) => (
              <div key={order.id} className="card p-6">
                <div className="flex items-start justify-between flex-wrap gap-2 mb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-gray-900">Order #{order.order_number}</p>
                      <StatusBadge status={order.status} />
                    </div>
                    <p className="text-sm text-gray-600 mt-1">
                      {order.patient_name}
                      {order.patient_phone && ` · ${order.patient_phone}`}
                    </p>
                  </div>
                  {order.estimated_delivery_at && (
                    <div className="text-right text-xs text-gray-500">
                      <p className="font-medium text-blue-600">
                        ETA: {new Date(order.estimated_delivery_at).toLocaleString('en-CA')}
                      </p>
                    </div>
                  )}
                </div>

                {/* Address */}
                <div className="flex items-start gap-2 text-sm text-gray-700 mb-3">
                  <span className="mt-0.5 text-gray-400">⊡</span>
                  <div>
                    <p>{order.delivery_address_street}</p>
                    <p className="text-gray-500">{order.delivery_address_city}, {order.delivery_address_postal}</p>
                    {order.delivery_notes && <p className="text-xs text-gray-400 mt-1">{order.delivery_notes}</p>}
                  </div>
                </div>

                {/* Controlled substance warning */}
                {order.contains_controlled && (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                    <strong>⚠ Controlled substances</strong> — Verify government-issued photo ID and
                    obtain signature at delivery (CDSA s.4). Do NOT leave with a third party.
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-3">
                  {order.status === 'AWAITING_DRIVER' && (
                    <button className="btn-primary" onClick={() => setPickup(order)}>
                      Confirm pickup
                    </button>
                  )}
                  {['PICKED_UP','IN_TRANSIT'].includes(order.status) && (
                    <button className="btn-primary" onClick={() => setAttempt(order)}>
                      Record delivery attempt
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {pickupOrder && (
        <PickupModal
          order={pickupOrder}
          onClose={() => setPickup(null)}
          onDone={() => handleDone('Pickup confirmed. Safe travels!')}
        />
      )}
      {attemptOrder && (
        <AttemptModal
          order={attemptOrder}
          onClose={() => setAttempt(null)}
          onDone={() => handleDone('Delivery recorded successfully.')}
        />
      )}
    </div>
  );
}
