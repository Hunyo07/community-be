// Shared error helpers: 404 for unknown routes and a JSON error formatter.
import { env } from '../config/env.js';

// Responds when no route matched the request URL.
export const notFoundHandler = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

// Turns known database faults into a sentence the form can show.
const databaseClientError = (error) => {
  if (error.code === 'ER_DUP_ENTRY') {
    return { statusCode: 409, message: 'A record with this value already exists.' };
  }

  if (error.code === 'ER_DATA_TOO_LONG') {
    return { statusCode: 400, message: 'One of the values is too long for its field.' };
  }

  if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
    return { statusCode: 400, message: 'A selected value is not recognized.' };
  }

  if (
    error.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' ||
    error.code === 'ER_TRUNCATED_WRONG_VALUE'
  ) {
    return { statusCode: 400, message: 'One of the values has an invalid format.' };
  }

  return null;
};

// Turns thrown errors into a consistent JSON response for the client.
export const errorHandler = (error, req, res, next) => {
  const mapped = error.statusCode ? null : databaseClientError(error);
  const statusCode = error.statusCode || mapped?.statusCode || 500;
  const response = {
    message: statusCode === 500 ? 'Internal server error' : mapped?.message || error.message
  };

  if (env.nodeEnv === 'development') {
    response.details = error.message;
  }

  res.status(statusCode).json(response);
};
