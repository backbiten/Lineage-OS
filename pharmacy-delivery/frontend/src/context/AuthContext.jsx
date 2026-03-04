import React, { createContext, useContext, useState, useCallback } from 'react';
import { login as apiLogin } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem('user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback(async (email, password) => {
    const data = await apiLogin(email, password);
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Role helpers
export const ROLES = {
  PATIENT:              'PATIENT',
  TECHNICIAN:           'PHARMACY_TECHNICIAN',
  PHARMACIST:           'PHARMACIST',
  DRIVER:               'DELIVERY_DRIVER',
  MANAGER:              'PHARMACY_MANAGER',
  ADMIN:                'SYSTEM_ADMIN',
  AUDITOR:              'REGULATORY_AUDITOR',
};

export function roleDashboard(role) {
  switch (role) {
    case ROLES.PATIENT:    return '/patient';
    case ROLES.TECHNICIAN: return '/technician';
    case ROLES.PHARMACIST: return '/pharmacist';
    case ROLES.DRIVER:     return '/driver';
    case ROLES.MANAGER:    return '/manager';
    case ROLES.ADMIN:      return '/admin';
    case ROLES.AUDITOR:    return '/audit';
    default:               return '/login';
  }
}
