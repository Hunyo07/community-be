import { env } from '../config/env.js';

export const notFoundHandler = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

export const errorHandler = (error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  const response = {
    message: statusCode === 500 ? 'Internal server error' : error.message
  };

  if (env.nodeEnv === 'development') {
    response.details = error.message;
  }

  res.status(statusCode).json(response);
};
