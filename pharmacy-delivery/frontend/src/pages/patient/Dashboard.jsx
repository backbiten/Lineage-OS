import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMyPrescriptions, getMyDeliveries } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import StatusBadge from '../../components/StatusBadge';
import Spinner from '../../components/Spinner';
import StatCard from '../../components/StatCard';

export default function PatientDashboard() {
  const { user } = useAuth();
  const [rxs, setRxs]         = useState([]);
  const [deliveries, setDels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getMyPrescriptions(), getMyDeliveries()])
      .then(([rxData, delData]) => {
        setRxs(rxData.prescriptions ?? []);
        setDels(delData.deliveries ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner size="lg" className="mt-20" />;

  const activeRxs  = rxs.filter((r) => !['DELIVERED','CANCELLED','EXPIRED','REJECTED'].includes(r.status));
  const activeDels = deliveries.filter((d) => ['AWAITING_DRIVER','PICKED_UP','IN_TRANSIT'].includes(d.status));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="page-title">Welcome back, {user.first_name}</h1>
        <p className="text-gray-500 text-sm mt-1">Here's an overview of your prescriptions and deliveries.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Active Prescriptions" value={activeRxs.length} color="blue" />
        <StatCard label="Total Prescriptions"  value={rxs.length}       color="purple" />
        <StatCard label="Active Deliveries"    value={activeDels.length} color="amber" />
        <StatCard label="Total Deliveries"     value={deliveries.length} color="green" />
      </div>

      {/* Active deliveries */}
      {activeDels.length > 0 && (
        <div className="card">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="section-title">Deliveries in progress</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {activeDels.map((d) => (
              <div key={d.id} className="px-6 py-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900 text-sm">Order #{d.order_number}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {d.delivery_address_city}, {d.delivery_address_province}
                    {d.driver_name && ` · Driver: ${d.driver_name}`}
                  </p>
                  {d.contains_controlled && (
                    <p className="text-xs text-amber-600 mt-0.5 font-medium">⚠ ID required at door</p>
                  )}
                </div>
                <StatusBadge status={d.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent prescriptions */}
      <div className="card">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="section-title">Recent prescriptions</h2>
          <Link to="/patient/prescriptions" className="text-sm text-blue-600 hover:underline font-medium">
            View all
          </Link>
        </div>
        {rxs.length === 0 ? (
          <div className="px-6 py-12 text-center text-gray-400 text-sm">
            No prescriptions on file. Your pharmacist will add them when processed.
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {rxs.slice(0, 5).map((rx) => (
              <div key={rx.id} className="px-6 py-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900 text-sm">
                    {rx.brand_name}
                    {rx.generic_name !== rx.brand_name && (
                      <span className="text-gray-500 font-normal"> ({rx.generic_name})</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Rx #{rx.rx_number} · {rx.dosage_form} · {rx.strength}
                    {rx.refills_remaining > 0 && ` · ${rx.refills_remaining} refill${rx.refills_remaining !== 1 ? 's' : ''} left`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={rx.status} />
                  {['DELIVERED','DISPENSED','FILLED'].includes(rx.status) && rx.refills_remaining > 0 && !rx.is_controlled && (
                    <Link to={`/patient/prescriptions?refill=${rx.id}`}
                      className="text-xs text-blue-600 hover:underline">
                      Request refill
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
