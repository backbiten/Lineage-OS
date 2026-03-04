import { useEffect, useState } from 'react';
import { getAuditLog } from '../api/client';
import Spinner from '../components/Spinner';

export default function AuditLog() {
  const [logs, setLogs]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    resource_type: '', actor_id: '', from: '', to: '', controlled_only: false,
  });
  const [applied, setApplied] = useState({});

  function load(f = applied) {
    setLoading(true);
    const params = {};
    if (f.resource_type)  params.resource_type   = f.resource_type;
    if (f.actor_id)       params.actor_id        = f.actor_id;
    if (f.from)           params.from            = f.from;
    if (f.to)             params.to              = f.to;
    if (f.controlled_only) params.controlled_only = 'true';
    getAuditLog(params)
      .then((d) => setLogs(d.log ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load({}); }, []);

  function applyFilters(e) {
    e.preventDefault();
    setApplied({ ...filters });
    load(filters);
  }

  function resetFilters() {
    const blank = { resource_type: '', actor_id: '', from: '', to: '', controlled_only: false };
    setFilters(blank);
    setApplied(blank);
    load(blank);
  }

  const actionColors = {
    PRESCRIPTION_VIEW: 'text-blue-600',
    DISPENSE_NARCOTIC: 'text-red-600',
    AUDIT_LOG_ACCESSED: 'text-purple-600',
    PATIENT_REGISTERED: 'text-green-600',
    DRIVER_CDSA_AUTHORIZED: 'text-purple-600',
    COLD_CHAIN_EXCURSION: 'text-orange-600',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Audit Log</h1>
        <p className="text-gray-500 text-sm mt-1">
          Immutable regulatory audit trail — CDSA, PIPEDA, PHIPA compliant.
          Access to this log is itself recorded.
        </p>
      </div>

      {/* Filters */}
      <form onSubmit={applyFilters} className="card p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className="label text-xs">Resource type</label>
            <select className="input text-sm" value={filters.resource_type}
              onChange={(e) => setFilters({...filters, resource_type: e.target.value})}>
              <option value="">All types</option>
              {['prescription','delivery_order','patient','delivery_driver','audit_log'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs">From date</label>
            <input type="datetime-local" className="input text-sm" value={filters.from}
              onChange={(e) => setFilters({...filters, from: e.target.value})} />
          </div>
          <div>
            <label className="label text-xs">To date</label>
            <input type="datetime-local" className="input text-sm" value={filters.to}
              onChange={(e) => setFilters({...filters, to: e.target.value})} />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 cursor-pointer mb-0.5">
              <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-red-600"
                checked={filters.controlled_only}
                onChange={(e) => setFilters({...filters, controlled_only: e.target.checked})} />
              <span className="text-sm text-gray-700">Controlled only</span>
            </label>
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <button type="submit" className="btn-primary text-sm">Apply filters</button>
          <button type="button" className="btn-secondary text-sm" onClick={resetFilters}>Reset</button>
          <span className="ml-auto text-xs text-gray-400 self-center">{logs.length} events (max 500)</span>
        </div>
      </form>

      {/* Log table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Time</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Role</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Resource</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">IP</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Flags</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr><td colSpan={7} className="py-12"><Spinner size="lg" /></td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={7} className="py-12 text-center text-gray-400">No audit events found.</td></tr>
            ) : logs.map((entry) => (
              <tr key={entry.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap font-mono">
                  {new Date(entry.event_time).toLocaleString('en-CA')}
                </td>
                <td className="px-4 py-3">
                  <span className={`font-medium text-xs font-mono ${actionColors[entry.action] ?? 'text-gray-700'}`}>
                    {entry.action}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                  {entry.actor_role?.replace('_', ' ') ?? '—'}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {entry.resource_type && (
                    <span>{entry.resource_type}<br />
                      <span className="font-mono text-gray-400">{entry.resource_id?.slice(0, 8)}…</span>
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-gray-400 font-mono">{entry.ip_address}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1 flex-wrap">
                    {entry.is_phi_access && (
                      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">PHI</span>
                    )}
                    {entry.is_controlled_substance_event && (
                      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">Ctrl</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    entry.success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                  }`}>
                    {entry.success ? 'OK' : 'FAIL'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
