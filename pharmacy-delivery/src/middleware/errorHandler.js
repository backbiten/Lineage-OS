'use strict';

const logger = require('../utils/logger');

// Global error handler — must have 4 params for Express to treat as error middleware
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status  = err.status || 500;
  const message = err.message || 'Internal server error';

  logger.error('Unhandled error', {
    status,
    message,
    stack:  err.stack,
    path:   req.path,
    method: req.method,
    userId: req.user?.id,
  });

  // Never expose stack traces or internal details in production
  res.status(status).json({
    error:   message,
    ...(err.details ? { details: err.details } : {}),
    ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
}

module.exports = errorHandler;
