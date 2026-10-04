import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace the real config (which reads .env) with a plain object we can change per test.
vi.mock('../src/config/env.js', () => ({
  env: { nodeEnv: 'production' },
}));

import { env } from '../src/config/env.js';
import { notFoundHandler, errorHandler } from '../src/middleware/errorHandler.js';

// Builds a fake Express response. status() returns res so calls can be chained.
const createRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

// Builds an error with an optional HTTP status code.
const createError = (message, statusCode) =>
  Object.assign(new Error(message), statusCode ? { statusCode } : {});

beforeEach(() => {
  env.nodeEnv = 'production';
});

describe('notFoundHandler', () => {
  it('responds with status 404', () => {
    const res = createRes();
    notFoundHandler({ method: 'GET', originalUrl: '/nope' }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('names the method and URL in the message', () => {
    const res = createRes();
    notFoundHandler({ method: 'POST', originalUrl: '/api/missing' }, res);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Route not found: POST /api/missing',
    });
  });

  it('includes the query string from the original URL', () => {
    const res = createRes();
    notFoundHandler({ method: 'GET', originalUrl: '/api/x?page=2' }, res);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Route not found: GET /api/x?page=2',
    });
  });
});

describe('errorHandler: status code', () => {
  it('uses the statusCode on the error', () => {
    const res = createRes();
    errorHandler(createError('Not allowed', 403), {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('defaults to 500 when the error has no statusCode', () => {
    const res = createRes();
    errorHandler(createError('Something broke'), {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('errorHandler: message', () => {
  it('shows the real message for client errors', () => {
    const res = createRes();
    errorHandler(createError('Invalid resident gender', 400), {}, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid resident gender' });
  });

  it('hides the real message for unexpected errors', () => {
    const res = createRes();
    errorHandler(createError('connect ECONNREFUSED 127.0.0.1:3306'), {}, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ message: 'Internal server error' });
  });

  it('hides the real message when the statusCode is explicitly 500', () => {
    const res = createRes();
    errorHandler(createError('Secret detail', 500), {}, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ message: 'Internal server error' });
  });
});

describe('errorHandler: details', () => {
  it('adds no details in production', () => {
    env.nodeEnv = 'production';
    const res = createRes();
    errorHandler(createError('Bad input', 400), {}, res, vi.fn());
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('details');
  });

  it('adds no details in the test environment', () => {
    env.nodeEnv = 'test';
    const res = createRes();
    errorHandler(createError('Bad input', 400), {}, res, vi.fn());
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('details');
  });

  it('adds details in development', () => {
    env.nodeEnv = 'development';
    const res = createRes();
    errorHandler(createError('Bad input', 400), {}, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({
      message: 'Bad input',
      details: 'Bad input',
    });
  });

  it('shows the real reason in details for crashes in development', () => {
    env.nodeEnv = 'development';
    const res = createRes();
    errorHandler(createError('connect ECONNREFUSED 127.0.0.1:3306'), {}, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({
      message: 'Internal server error',
      details: 'connect ECONNREFUSED 127.0.0.1:3306',
    });
  });

  it('leaks nothing about a crash in production', () => {
    env.nodeEnv = 'production';
    const res = createRes();
    errorHandler(createError('connect ECONNREFUSED 127.0.0.1:3306'), {}, res, vi.fn());
    expect(res.json.mock.calls[0][0]).toEqual({ message: 'Internal server error' });
  });
});

describe('errorHandler: behavior', () => {
  it('sends exactly one response', () => {
    const res = createRes();
    errorHandler(createError('Oops', 400), {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('does not pass the error on to next', () => {
    const res = createRes();
    const next = vi.fn();
    errorHandler(createError('Oops', 400), {}, res, next);
    expect(next).not.toHaveBeenCalled();
  });
});