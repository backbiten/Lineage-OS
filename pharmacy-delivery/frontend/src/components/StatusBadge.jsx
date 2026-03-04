export default function StatusBadge({ status }) {
  const map = {
    // Prescription statuses
    RECEIVED:                 'bg-gray-100 text-gray-700',
    TECHNICIAN_REVIEW:        'bg-yellow-100 text-yellow-800',
    PHARMACIST_VERIFICATION:  'bg-blue-100 text-blue-800',
    APPROVED:                 'bg-green-100 text-green-800',
    PARTIALLY_FILLED:         'bg-purple-100 text-purple-800',
    FILLED:                   'bg-teal-100 text-teal-800',
    DISPENSED:                'bg-teal-100 text-teal-800',
    READY_FOR_DELIVERY:       'bg-indigo-100 text-indigo-800',
    OUT_FOR_DELIVERY:         'bg-blue-100 text-blue-800',
    DELIVERED:                'bg-green-100 text-green-800',
    RETURNED:                 'bg-orange-100 text-orange-800',
    REJECTED:                 'bg-red-100 text-red-800',
    CANCELLED:                'bg-gray-100 text-gray-600',
    EXPIRED:                  'bg-red-100 text-red-600',
    // Order statuses
    CREATED:                  'bg-gray-100 text-gray-700',
    PENDING_VERIFICATION:     'bg-yellow-100 text-yellow-800',
    TECHNICIAN_PROCESSING:    'bg-yellow-100 text-yellow-800',
    PHARMACIST_APPROVED:      'bg-green-100 text-green-800',
    PACKING:                  'bg-purple-100 text-purple-800',
    AWAITING_DRIVER:          'bg-indigo-100 text-indigo-800',
    PICKED_UP:                'bg-blue-100 text-blue-800',
    IN_TRANSIT:               'bg-blue-100 text-blue-800',
    DELIVERY_FAILED:          'bg-red-100 text-red-800',
    RETURNED_TO_PHARMACY:     'bg-orange-100 text-orange-800',
    // Driver checks
    true:                     'bg-green-100 text-green-800',
    false:                    'bg-red-100 text-red-800',
  };

  const label = String(status).replace(/_/g, ' ');
  const cls = map[status] ?? 'bg-gray-100 text-gray-600';

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
