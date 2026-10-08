import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config/db.js', () => ({
  pool: { execute: vi.fn(), query: vi.fn() },
}));
vi.mock('../src/realtime/socket.js', () => ({
  emitRealtimeEvent: vi.fn(),
}));
vi.mock('../src/utils/auditLogger.js', () => ({
  logAudit: vi.fn(),
}));
vi.mock('../src/utils/password.js', () => ({
  hashPassword: vi.fn(() => 'hashed'),
  verifyPassword: vi.fn(),
}));

import { pool } from '../src/config/db.js';
import { verifyPassword } from '../src/utils/password.js';
import { createStaff, deleteOwnAdminAccount, listStaff } from '../src/controllers/moduleController.js';

const createRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const cityAdmin = { id: 1, role: 'admin', barangay: null, accountType: 'staff' };
const atiocAdmin = { id: 8, role: 'admin', barangay: 'Atioc', accountType: 'staff' };

const run = async (handler, req) => {
  const res = createRes();
  const next = vi.fn();
  await handler(req, res, next);
  return { res, next };
};

beforeEach(() => {
  pool.execute.mockReset();
  verifyPassword.mockReset();
});

describe('listStaff barangay scope', () => {
  it('returns every staff account to a city-wide admin', async () => {
    pool.execute.mockResolvedValueOnce([[]]);
    await run(listStaff, { user: cityAdmin });
    expect(pool.execute.mock.calls[0][0]).not.toContain('WHERE sa.barangay');
  });

  it('limits an Atioc admin to Atioc staff', async () => {
    pool.execute.mockResolvedValueOnce([[]]);
    await run(listStaff, { user: atiocAdmin });
    expect(pool.execute.mock.calls[0][0]).toContain('WHERE sa.barangay = ?');
    expect(pool.execute.mock.calls[0][1]).toEqual(['Atioc']);
  });
});

describe('createStaff barangay lock', () => {
  const body = {
    name: 'Ana Cruz',
    email: 'ana.cruz@example.com',
    barangay: 'San Vicente',
    role: 'admin',
  };

  it('saves the creator barangay when a barangay admin picks another one', async () => {
    pool.execute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 4 }]);
    const { res, next } = await run(createStaff, { user: atiocAdmin, body });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const insertCall = pool.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO staff_accounts'));
    expect(insertCall[1][2]).toBe('Atioc');
  });

  it('rejects a name with a special character', async () => {
    const { next } = await run(createStaff, { user: cityAdmin, body: { ...body, name: 'Ana#' } });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(next.mock.calls[0][0].message).toMatch(/Name can only contain letters/);
  });
});

describe('deleteOwnAdminAccount', () => {
  it('rejects the wrong password', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 8, password_hash: 'hash', role: 'admin', barangay: 'Atioc' }]]);
    verifyPassword.mockReturnValue(false);
    const { res } = await run(deleteOwnAdminAccount, { user: atiocAdmin, body: { password: 'wrong' } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Password is incorrect' });
  });

  it('deletes only the signed-in admin', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 8, password_hash: 'hash', role: 'admin', barangay: 'Atioc' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    verifyPassword.mockReturnValue(true);
    const { res } = await run(deleteOwnAdminAccount, {
      user: atiocAdmin,
      params: { id: 99 },
      body: { password: 'Secret123' },
    });
    expect(res.json).toHaveBeenCalledWith({ message: 'Account deleted' });
    const deleteCall = pool.execute.mock.calls.find(([sql]) => sql.includes('DELETE FROM staff_accounts'));
    expect(deleteCall[1]).toEqual([8, 'admin']);
  });

  it('refuses to delete the last city-wide admin', async () => {
    pool.execute
      .mockResolvedValueOnce([[{ id: 1, password_hash: 'hash', role: 'admin', barangay: null }]])
      .mockResolvedValueOnce([[{ total: 1 }]]);
    verifyPassword.mockReturnValue(true);
    const { res } = await run(deleteOwnAdminAccount, { user: cityAdmin, body: { password: 'Secret123' } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'The last city-wide admin account cannot be deleted' });
  });

  it('rejects a request from someone who is not an admin', async () => {
    const { res } = await run(deleteOwnAdminAccount, {
      user: { id: 3, role: 'barangay_staff', barangay: 'Atioc' },
      body: { password: 'Secret123' },
    });
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
