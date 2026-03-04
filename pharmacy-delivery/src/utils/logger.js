'use strict';

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    // Rotating file — regulatory logs retained per CDSA (2-year minimum)
    new transports.DailyRotateFile({
      filename:     'logs/app-%DATE%.log',
      datePattern:  'YYYY-MM-DD',
      maxFiles:     '730d',   // 2 years — CDSA / provincial requirement
      zippedArchive: true,
    }),
    new transports.DailyRotateFile({
      filename:     'logs/error-%DATE%.log',
      datePattern:  'YYYY-MM-DD',
      level:        'error',
      maxFiles:     '730d',
      zippedArchive: true,
    }),
    ...(process.env.NODE_ENV !== 'production'
      ? [new transports.Console({ format: format.combine(format.colorize(), format.simple()) })]
      : []),
  ],
});

module.exports = logger;
