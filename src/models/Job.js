const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true
  },
  proxyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Proxy'
  },
  status: {
    type: String,
    enum: ['pending', 'running', 'success', 'failed', 'captcha_blocked'],
    default: 'pending'
  },
  logs: [
    {
      timestamp: { type: Date, default: Date.now },
      level: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
      message: { type: String, required: true }
    }
  ],
  startedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  },
  errorMessage: {
    type: String
  },
  duration: {
    type: Number // seconds
  },
  pagesSearched: {
    type: Number,
    default: 0
  },
  ipAddress: {
    type: String
  },
  botState: {
    type: String
  }
});

module.exports = mongoose.model('Job', jobSchema);
