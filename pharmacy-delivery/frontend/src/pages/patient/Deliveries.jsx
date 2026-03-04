import { useEffect, useState } from 'react';
import { getMyDeliveries } from '../../api/client';
import StatusBadge from '../../components/StatusBadge';
import Spinner from '../../components/Spinner';

const STATUS_STEPS = [
  { key: 'CREATED',         label: 'Order created' },
  { key: 'PACKING',         label: 'Packing' },
  { key: 'AWAITING_DRIVER', label: 'Awaiting driver' },
  { key: 'PICKED_UP',       label: 'Picked up' },
  { key: 'IN_TRANSIT',      label: 'In transit' },
  { key: 'DELIVERED',       label: 'Delivered' },
];

function stepIndex(status) {
  const i = STATUS_STEPS.findIndex((s) => s.key === status);
  return i === -1 ? 0 : i;
}

function DeliveryTracker({ status }) {
  const current = stepIndex(status);
  const failed  = ['DELIVERY_FAILED','RETURNED_TO_PHARMACY','CANCELLED'].includes(status);

  if (failed) {
    return (
      <div className="mt-3 flex items-center gap-2 text-sm text-red-600">
        <span>✕</span>
        <span>Delivery could not be completed. Your pharmacy will contact you.</span>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="flex items-center">
        {STATUS_STEPS.map((step, i) => (
          <div key={step.key} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i < current ? 'bg-green-500 text-white' :
                i === current ? 'bg-blue-600 text-white ring-4 ring-blue-100' :
                'bg-gray-200 text-gray-400'
              }`}>
                {i < current ? '✓' : i + 1}
              </div>
              <span className={`text-xs whitespace-nowrap ${i === current ? 'text-blue-700 font-medium' : i < current ? 'text-green-600' : 'text-gray-400'}`}>
                {step.label}
              </span>
            </div>
            {i < STATUS_STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mx-1 mb-5 ${i < current ? 'bg-green-500' : 'bg-gray-200'}`} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Deliveries() {
  const [deliveries, setDels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMyDeliveries()
      .then((d) => setDels(d.deliveries ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner size="lg" className="mt-20" />;

  const active = deliveries.filter((d) => !['DELIVERED','RETURNED_TO_PHARMACY','CANCELLED'].includes(d.status));
  const past   = deliveries.filter((d) =>  ['DELIVERED','RETURNED_TO_PHARMACY','CANCELLED'].includes(d.status));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="page-title">My Deliveries</h1>
        <p className="text-gray-500 text-sm mt-1">{deliveries.length} order{deliveries.length !== 1 ? 's' : ''} total</p>
      </div>

      {active.length > 0 && (
        <section>
          <h2 className="section-title mb-3">Active orders</h2>
          <div className="space-y-4">
            {active.map((d) => (
              <div key={d.id} className="card p-6">
                <div className="flex items-start justify-between flex-wrap gap-2">
                  <div>
                    <p className="font-semibold text-gray-900">Order #{d.order_number}</p>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {d.delivery_address_street}, {d.delivery_address_city} {d.delivery_address_province}
                    </p>
                    {d.driver_name && (
                      <p className="text-xs text-gray-400 mt-1">Driver: {d.driver_name}</p>
                    )}
                    {d.estimated_delivery_at && (
                      <p className="text-xs text-blue-600 mt-1">
                        ETA: {new Date(d.estimated_delivery_at).toLocaleString('en-CA')}
                      </p>
                    )}
                  </div>
                  <StatusBadge status={d.status} />
                </div>
                {d.contains_controlled && (
                  <div className="mt-3 flex items-start gap-2 p-3 bg-amber-50 rounded-lg text-sm text-amber-800">
                    <span className="font-bold">⚠</span>
                    <span>This delivery contains controlled medications. Please have valid government-issued photo ID ready at the door.</span>
                  </div>
                )}
                <DeliveryTracker status={d.status} />
              </div>
            ))}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h2 className="section-title mb-3">Past orders</h2>
          <div className="card divide-y divide-gray-100">
            {past.map((d) => (
              <div key={d.id} className="px-6 py-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900 text-sm">Order #{d.order_number}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {d.delivery_address_city}
                    {d.actual_delivery_at && ` · Delivered ${new Date(d.actual_delivery_at).toLocaleDateString('en-CA')}`}
                  </p>
                </div>
                <StatusBadge status={d.status} />
              </div>
            ))}
          </div>
        </section>
      )}

      {deliveries.length === 0 && (
        <div className="card p-12 text-center text-gray-400 text-sm">
          No deliveries yet. Your pharmacy team will schedule a delivery once your prescription is ready.
        </div>
      )}
    </div>
  );
}
