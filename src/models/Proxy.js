const mongoose = require('mongoose');

const proxySchema = new mongoose.Schema({
  host: {
    type: String,
    required: true,
    trim: true
  },
  port: {
    type: Number,
    required: true
  },
  username: {
    type: String,
    trim: true,
    default: ''
  },
  password: {
    type: String,
    trim: true,
    default: ''
  },
  protocol: {
    type: String,
    enum: ['http', 'https', 'socks4', 'socks5'],
    default: 'http'
  },
  status: {
    type: String,
    enum: ['active', 'failed', 'testing'],
    default: 'active'
  },
  failCount: {
    type: Number,
    default: 0
  },
  lastUsedAt: {
    type: Date
  },
  isAutoCreated: {
    type: Boolean,
    default: false
  },
  rotationKey: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Proxy', proxySchema);
