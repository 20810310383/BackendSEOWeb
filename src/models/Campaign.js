const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  keyword: {
    type: String,
    required: true,
    trim: true
  },
  targetDomain: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  maxPageSearch: {
    type: Number,
    default: 5,
    min: 1
  },
  minDuration: {
    type: Number,
    default: 30, // seconds
    min: 5
  },
  maxDuration: {
    type: Number,
    default: 60, // seconds
    min: 5
  },
  dailyQuota: {
    type: Number,
    default: 10,
    min: 1
  },
  status: {
    type: String,
    enum: ['active', 'paused'],
    default: 'active'
  },
  successCount: {
    type: Number,
    default: 0
  },
  failCount: {
    type: Number,
    default: 0
  },
  lastRunAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Campaign', campaignSchema);
