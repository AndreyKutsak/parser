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

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', { error: err.message });
  });

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('MongoDB disconnected');
  });

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
};

const disconnect = async () => {
  if (!isConnected) return;
  await mongoose.disconnect();
};

module.exports = { connect, disconnect };
