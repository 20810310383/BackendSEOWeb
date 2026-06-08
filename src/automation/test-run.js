require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Campaign = require('../models/Campaign');
const Job = require('../models/Job');
const { runAutomation } = require('./AutomationEngine');

async function testRun() {
  try {
    console.log('Connecting to database for test run...');
    await connectDB();

    // 1. Clean old test campaigns if any, and seed a test campaign
    console.log('Seeding test campaign...');
    let campaign = await Campaign.findOne({ name: 'TEST_CAMPAIGN' });
    if (!campaign) {
      campaign = new Campaign({
        name: 'TEST_CAMPAIGN',
        keyword: 'vuaquiz',
        targetDomain: 'vuaquiz.com',
        maxPageSearch: 3,
        minDuration: 10,
        maxDuration: 20,
        dailyQuota: 5
      });
      await campaign.save();
    } else {
      // Reset daily counts to allow running
      campaign.successCount = 0;
      campaign.failCount = 0;
      await campaign.save();
    }

    console.log(`Campaign initialized: Keyword="${campaign.keyword}", Domain="${campaign.targetDomain}"`);

    // 2. Create a Job
    console.log('Creating execution Job...');
    const job = new Job({
      campaignId: campaign._id,
      status: 'pending',
      logs: [{ level: 'info', message: 'Test execution initialized.' }]
    });
    await job.save();

    console.log(`Job created: ID = ${job._id}`);

    // 3. Execute Automation Engine
    console.log('Starting Automation Engine...');
    await runAutomation(job._id, (logItem) => {
      const levelColors = {
        info: '\x1b[36m%s\x1b[0m', // Cyan
        success: '\x1b[32m%s\x1b[0m', // Green
        warning: '\x1b[33m%s\x1b[0m', // Yellow
        error: '\x1b[31m%s\x1b[0m' // Red
      };
      const color = levelColors[logItem.level] || '%s';
      console.log(color, `[${logItem.level.toUpperCase()}] ${logItem.message}`);
    });

    console.log('Test run execution sequence ended.');
    
    // Fetch final job status
    const finalJob = await Job.findById(job._id);
    console.log(`Final Job Status in DB: ${finalJob.status}`);
    if (finalJob.errorMessage) {
      console.log(`Final Job Error: ${finalJob.errorMessage}`);
    }

  } catch (error) {
    console.error('Test run failed with error:', error.message);
  } finally {
    // Close mongoose connection
    await mongoose.connection.close();
    console.log('Database connection closed.');
    process.exit(0);
  }
}

testRun();
