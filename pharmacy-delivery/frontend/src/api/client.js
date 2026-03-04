import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

// Attach JWT on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401 — clear auth and redirect to login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = (email, password) =>
  api.post('/auth/login', { email, password }).then((r) => r.data);

export const changePassword = (currentPassword, newPassword) =>
  api.post('/auth/change-password', { current_password: currentPassword, new_password: newPassword });

// ── Patient ───────────────────────────────────────────────────────────────────
export const registerPatient = (data) =>
  api.post('/patients/register', data).then((r) => r.data);

export const getMyProfile = () =>
  api.get('/patients/me').then((r) => r.data);

export const updateMyProfile = (data) =>
  api.patch('/patients/me', data).then((r) => r.data);

export const getMyPrescriptions = (page = 1) =>
  api.get('/patients/me/prescriptions', { params: { page, limit: 20 } }).then((r) => r.data);

export const getMyDeliveries = () =>
  api.get('/patients/me/deliveries').then((r) => r.data);

export const requestRefill = (data) =>
  api.post('/patients/me/refill-requests', data).then((r) => r.data);

// ── Prescriptions ─────────────────────────────────────────────────────────────
export const getPrescription = (id) =>
  api.get(`/prescriptions/${id}`).then((r) => r.data);

export const getTechnicianQueue = (pharmacyId) =>
  api.get('/prescriptions/queue/technician', { params: { pharmacy_id: pharmacyId } }).then((r) => r.data);

export const getPharmacistQueue = (pharmacyId) =>
  api.get('/prescriptions/queue/pharmacist', { params: { pharmacy_id: pharmacyId } }).then((r) => r.data);

export const intakePrescription = (data) =>
  api.post('/prescriptions/intake', data).then((r) => r.data);

export const verifyPrescription = (id, decision) =>
  api.post(`/prescriptions/${id}/verify`, decision).then((r) => r.data);

export const narcoticCount = (id, data) =>
  api.post(`/prescriptions/${id}/narcotic-count`, data).then((r) => r.data);

// ── Delivery ──────────────────────────────────────────────────────────────────
export const createDeliveryOrder = (data) =>
  api.post('/delivery/orders', data).then((r) => r.data);

export const getDeliveryOrder = (id) =>
  api.get(`/delivery/orders/${id}`).then((r) => r.data);

export const assignDriver = (orderId, driverId) =>
  api.post(`/delivery/orders/${orderId}/assign-driver`, { driver_id: driverId }).then((r) => r.data);

export const confirmPickup = (orderId, sealVerified) =>
  api.post(`/delivery/orders/${orderId}/pickup`, { seal_verified: sealVerified }).then((r) => r.data);

export const recordDeliveryAttempt = (orderId, data) =>
  api.post(`/delivery/orders/${orderId}/attempt`, data).then((r) => r.data);

export const getDriverActiveOrders = () =>
  api.get('/delivery/driver/active').then((r) => r.data);

// ── Drivers ───────────────────────────────────────────────────────────────────
export const listDrivers = (pharmacyId) =>
  api.get('/drivers', { params: { pharmacy_id: pharmacyId } }).then((r) => r.data);

export const getDriver = (id) =>
  api.get(`/drivers/${id}`).then((r) => r.data);

export const registerDriver = (data) =>
  api.post('/drivers/register', data).then((r) => r.data);

export const recordBackgroundCheck = (id, data) =>
  api.post(`/drivers/${id}/background-check`, data).then((r) => r.data);

export const setCdsaAuth = (id, data) =>
  api.post(`/drivers/${id}/cdsa-authorization`, data).then((r) => r.data);

export const setDriverStatus = (id, isActive) =>
  api.patch(`/drivers/${id}/status`, { is_active: isActive }).then((r) => r.data);

// ── Drugs ─────────────────────────────────────────────────────────────────────
export const searchDrugs = (params) =>
  api.get('/drugs', { params }).then((r) => r.data);

export const getDrug = (id) =>
  api.get(`/drugs/${id}`).then((r) => r.data);

export const getDrugByDin = (din) =>
  api.get(`/drugs/din/${din}`).then((r) => r.data);

// ── Audit log ─────────────────────────────────────────────────────────────────
export const getAuditLog = (params) =>
  api.get('/audit/log', { params }).then((r) => r.data);

// ── Inventory ─────────────────────────────────────────────────────────────────
export const getInventoryTransactions = (params) =>
  api.get('/inventory/transactions', { params }).then((r) => r.data);

// ── Cold chain ────────────────────────────────────────────────────────────────
export const logTemperature = (data) =>
  api.post('/cold-chain/log', data).then((r) => r.data);

export const getColdChainLog = (deliveryOrderId) =>
  api.get(`/cold-chain/${deliveryOrderId}/log`).then((r) => r.data);

export default api;
