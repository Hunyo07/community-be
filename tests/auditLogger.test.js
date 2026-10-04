import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Replace both dependencies with fakes before auditLogger.js loads.
vi.mock('../src/config/db.js', () => ({
  pool: { execute: vi.fn() },
}));
vi.mock('../src/realtime/socket.js', () => ({
  emitRealtimeEvent: vi.fn(),
}));

import { pool } from '../src/config/db.js';
import { emitRealtimeEvent } from '../src/realtime/socket.js';
import { logAudit } from '../src/utils/auditLogger.js';

let errorSpy;

beforeEach(() => {
  pool.execute.mockReset();
  emitRealtimeEvent.mockReset();
  pool.execute.mockResolvedValue([{}]);
  // Silence console.error and let the tests check what was logged.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('logAudit: saving the row', () => {
  it('saves every value in the right order', async () => {
    await logAudit({
      user: { id: 5, role: 'admin' },
      action: 'create',
      entityType: 'resident',
      entityId: 12,
      details: { name: 'Ana' },
    });

    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_logs');
    expect(params).toEqual([5, 'admin', 'create', 'resident', 12, '{"name":"Ana"}']);
  });

  it('keeps the values out of the SQL text (safe parameterized query)', async () => {
    await logAudit({
      user: { id: 5, role: 'admin' },
      action: 'delete-everything',
      entityType: 'resident',
    });

    const [sql] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('delete-everything');
    expect(sql).toContain('?');
  });

  it('records the role as "system" when there is no user', async () => {
    await logAudit({ action: 'cleanup', entityType: 'session' });

    const [, params] = pool.execute.mock.calls[0];
    expect(params[0]).toBeNull();
    expect(params[1]).toBe('system');
  });

  it('records the role as "system" when the user has no role', async () => {
    await logAudit({
      user: { id: 7 },
      action: 'update',
      entityType: 'profile',
    });

    const [, params] = pool.execute.mock.calls[0];
    expect(params[0]).toBe(7);
    expect(params[1]).toBe('system');
  });

  it('uses null for entityId and details when they are not given', async () => {
    await logAudit({
      user: { id: 1, role: 'admin' },
      action: 'login',
      entityType: 'auth',
    });

    const [, params] = pool.execute.mock.calls[0];
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
  });

  it('stores details as a JSON string', async () => {
    await logAudit({
      user: { id: 1, role: 'admin' },
      action: 'update',
      entityType: 'service',
      entityId: 3,
      details: { fields: ['name', 'office'], count: 2 },
    });

    const [, params] = pool.execute.mock.calls[0];
    expect(typeof params[5]).toBe('string');
    expect(JSON.parse(params[5])).toEqual({
      fields: ['name', 'office'],
      count: 2,
    });
  });
});

describe('logAudit: realtime event', () => {
  it('sends an audit:changed event with the action, type, and id', async () => {
    await logAudit({
      user: { id: 1, role: 'admin' },
      action: 'update',
      entityType: 'service',
      entityId: 3,
      details: { secret: 'not broadcast' },
    });

    expect(emitRealtimeEvent).toHaveBeenCalledWith('audit:changed', {
      action: 'update',
      entityType: 'service',
      entityId: 3,
    });
  });

  it('sends entityId as null when none is given', async () => {
    await logAudit({ action: 'login', entityType: 'auth' });

    expect(emitRealtimeEvent).toHaveBeenCalledWith('audit:changed', {
      action: 'login',
      entityType: 'auth',
      entityId: null,
    });
  });

  it('sends exactly one event per audit entry', async () => {
    await logAudit({ action: 'create', entityType: 'post' });
    expect(emitRealtimeEvent).toHaveBeenCalledTimes(1);
  });

  it('sends the event only after the row is saved', async () => {
    await logAudit({ action: 'create', entityType: 'post' });

    const saved = pool.execute.mock.invocationCallOrder[0];
    const sent = emitRealtimeEvent.mock.invocationCallOrder[0];
    expect(saved).toBeLessThan(sent);
  });
});

describe('logAudit: failures', () => {
  it('does not throw when the database fails', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    await expect(
      logAudit({ action: 'create', entityType: 'post' }),
    ).resolves.toBeUndefined();
  });

  it('logs the error message when the database fails', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    await logAudit({ action: 'create', entityType: 'post' });

    expect(errorSpy).toHaveBeenCalledWith(
      'Audit log failed:',
      'Database is down',
    );
  });

  it('does not send a realtime event when the row was not saved', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    await logAudit({ action: 'create', entityType: 'post' });

    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  });

  it('does not throw when the realtime event fails', async () => {
    emitRealtimeEvent.mockImplementation(() => {
      throw new Error('Socket not ready');
    });

    await expect(
      logAudit({ action: 'create', entityType: 'post' }),
    ).resolves.toBeUndefined();
  });

  it('logs the error message when the realtime event fails', async () => {
    emitRealtimeEvent.mockImplementation(() => {
      throw new Error('Socket not ready');
    });

    await logAudit({ action: 'create', entityType: 'post' });

    expect(errorSpy).toHaveBeenCalledWith(
      'Audit log failed:',
      'Socket not ready',
    );
  });

  it('logs nothing when everything works', async () => {
    await logAudit({ action: 'create', entityType: 'post' });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});