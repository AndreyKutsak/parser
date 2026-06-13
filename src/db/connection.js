/**
 * MongoDB connection with retry logic
 */
const mongoose = require('mongoose');
const logger = require('../utils/logger');

let isConnected = false;

const connect = async () => {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/webparser';

  mongoose.connection.on('connected', () => {
    isConnected = true;
    logger.info('MongoDB connected', { uri: uri.replace(/\/\/.*@/, '//***@') });
  });

  mongoose.connection.on('reconnected', () => {
    isConnected = true;
    logger.info('MongoDB reconnected');
  });

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', { error: err.message });
  });

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('MongoDB disconnected — Mongoose will retry automatically');
  });

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5_000,   // fail fast if no server found
    connectTimeoutMS:         10_000,  // initial TCP connect timeout
    socketTimeoutMS:          45_000,  // max time to wait for a response
    heartbeatFrequencyMS:     10_000,  // detect disconnects in ≤10s (default: 10s, explicit)
    retryWrites:              true,    // auto-retry transient write failures
    maxIdleTimeMS:            60_000,  // close idle connections after 1 min
    autoIndex:                false,   // never rebuild indexes in production
  });
};

const disconnect = async () => {
  if (!isConnected) return;
  await mongoose.disconnect();
};

module.exports = { connect, disconnect };
