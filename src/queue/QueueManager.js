const Campaign = require('../models/Campaign');
const Proxy = require('../models/Proxy');
const Job = require('../models/Job');
const { runAutomation } = require('../automation/AutomationEngine');

class QueueManager {
  constructor() {
    this.runningJobs = new Map(); // jobId -> Promise
    this.concurrencyLimit = parseInt(process.env.CONCURRENCY_LIMIT, 10) || 2;
    this.io = null; // Socket.io instance
    this.intervalId = null;
  }

  /**
   * Bind socket server
   */
  initSocket(io) {
    this.io = io;
    console.log('QueueManager Socket.io bound.');
  }

  /**
   * Get active running job counts
   */
  getActiveCount() {
    return this.runningJobs.size;
  }

  /**
   * Start polling loop
   */
  start() {
    if (this.intervalId) return;
    
    console.log('QueueManager scheduler started.');
    // Check every 20 seconds
    this.intervalId = setInterval(() => this.processQueue(), 20000);
    // Initial trigger
    this.processQueue();
  }

  /**
   * Stop polling loop
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('QueueManager scheduler stopped.');
  }

  /**
   * Select least recently used active proxy
   */
  async getNextProxy() {
    const proxy = await Proxy.findOne({ status: 'active' }).sort({ lastUsedAt: 1 });
    if (proxy) {
      // Temporarily touch lastUsedAt to avoid race conditions in simultaneous task launches
      proxy.lastUsedAt = new Date();
      await proxy.save();
    }
    return proxy;
  }

  /**
   * Manual reset of daily quotas at midnight (or simple check reset)
   * For this system, we can clear counters daily, or simple check based on Date.
   * To keep it simple and robust, we check daily reset logic or let campaigns reset when daily quota is updated.
   * A clean way is: if last run was yesterday, reset today's counts.
   */
  async verifyDailyReset(campaign) {
    if (!campaign.lastRunAt) return;
    
    const lastRun = new Date(campaign.lastRunAt);
    const today = new Date();
    
    // Check if day matches
    if (lastRun.getDate() !== today.getDate() || 
        lastRun.getMonth() !== today.getMonth() || 
        lastRun.getFullYear() !== today.getFullYear()) {
      
      console.log(`Resetting daily counters for campaign: ${campaign.name}`);
      campaign.successCount = 0;
      campaign.failCount = 0;
      await campaign.save();
    }
  }

  /**
   * Polling scheduler executor
   */
  async processQueue() {
    // Check if auto-scheduler is enabled. Default to false as requested.
    if (process.env.AUTO_SCHEDULER !== 'true') {
      return;
    }

    try {
      if (this.getActiveCount() >= this.concurrencyLimit) {
        console.log(`QueueManager: Concurrency limit reached (${this.getActiveCount()}/${this.concurrencyLimit}). Postponing schedule check.`);
        return;
      }

      // Find active campaigns
      const campaigns = await Campaign.find({ status: 'active' });
      for (const campaign of campaigns) {
        // Double check concurrency limit within loop
        if (this.getActiveCount() >= this.concurrencyLimit) break;

        await this.verifyDailyReset(campaign);

        const currentTotalRuns = (campaign.successCount || 0) + (campaign.failCount || 0);
        if (currentTotalRuns >= campaign.dailyQuota) {
          // Campaign daily quota hit, skip
          continue;
        }

        // Check if there is already a running job for this campaign to prevent duplicates
        const runningCampaignJob = Array.from(this.runningJobs.values()).some(j => j.campaignId === campaign._id.toString());
        if (runningCampaignJob) {
          continue;
        }

        // Trigger job
        await this.triggerJob(campaign._id);
      }
    } catch (error) {
      console.error('QueueManager processQueue error:', error.message);
    }
  }

  /**
   * Trigger automation task
   */
  async triggerJob(campaignId, isManual = false) {
    try {
      const campaign = await Campaign.findById(campaignId);
      if (!campaign) throw new Error('Campaign not found');

      // Check concurrency for manual runs as well (to prevent server crash)
      if (this.getActiveCount() >= this.concurrencyLimit + 2) { // Allow slight buffer for manual triggers
        throw new Error('Server concurrency capacity saturated. Try again shortly.');
      }

      // Fetch Proxy
      const proxy = await this.getNextProxy();
      
      // Create pending Job
      const job = new Job({
        campaignId: campaign._id,
        proxyId: proxy ? proxy._id : null,
        status: 'pending',
        logs: [{ level: 'info', message: 'Job initialized by queue scheduler.' }]
      });
      await job.save();

      // Broadcast socket update
      if (this.io) {
        this.io.emit('job_created', { jobId: job._id, campaignId: campaign._id });
      }

      // Launch Async Automation Runner
      const jobPromise = runAutomation(job._id, (logItem) => {
        // Socket log stream emitter
        if (this.io) {
          this.io.emit(`logs:${job._id}`, logItem);
          this.io.emit('job_updated', { jobId: job._id, campaignId: campaign._id, status: 'running' });
          this.io.emit('global_log', {
            jobId: job._id,
            campaignId: campaign._id,
            campaignName: campaign.name,
            keyword: campaign.keyword,
            targetDomain: campaign.targetDomain,
            proxy: proxy ? `${proxy.protocol}://${proxy.host}:${proxy.port}` : 'Local IP',
            timestamp: logItem.timestamp || new Date(),
            level: logItem.level,
            message: logItem.message,
            botState: logItem.botState || ''
          });
        }
      }).then(async () => {
        // Finished successfully or failed
        this.runningJobs.delete(job._id.toString());
        if (this.io) {
          const finishedJob = await Job.findById(job._id);
          this.io.emit('job_finished', { 
            jobId: job._id, 
            campaignId: campaign._id, 
            status: finishedJob.status 
          });
        }
        // Reprocess queue immediately to fill freed slot
        this.processQueue();
      });

      // Track running job metadata
      jobPromise.campaignId = campaign._id.toString();
      this.runningJobs.set(job._id.toString(), jobPromise);

      console.log(`Triggered job ${job._id} for campaign "${campaign.name}" (${isManual ? 'Manual' : 'Schedule'})`);
      return job;

    } catch (error) {
      console.error(`Failed to trigger job for campaign ${campaignId}:`, error.message);
      throw error;
    }
  }

  /**
   * Relaunch a job directly (usually after proxy rotation)
   */
  async relaunchJob(jobId) {
    try {
      const job = await Job.findById(jobId).populate('proxyId');
      if (!job) throw new Error('Job not found');

      const campaign = await Campaign.findById(job.campaignId);
      if (!campaign) throw new Error('Campaign not found');

      const campaignId = campaign._id;
      const proxy = job.proxyId;

      if (this.io) {
        this.io.emit('job_created', { jobId: job._id, campaignId });
      }

      // Launch Async Automation Runner
      const jobPromise = runAutomation(job._id, (logItem) => {
        if (this.io) {
          this.io.emit(`logs:${job._id}`, logItem);
          this.io.emit('job_updated', { jobId: job._id, campaignId, status: 'running' });
          this.io.emit('global_log', {
            jobId: job._id,
            campaignId: campaignId,
            campaignName: campaign.name,
            keyword: campaign.keyword,
            targetDomain: campaign.targetDomain,
            proxy: proxy ? `${proxy.protocol}://${proxy.host}:${proxy.port}` : 'Local IP',
            timestamp: logItem.timestamp || new Date(),
            level: logItem.level,
            message: logItem.message,
            botState: logItem.botState || ''
          });
        }
      }).then(async () => {
        this.runningJobs.delete(job._id.toString());
        if (this.io) {
          const finishedJob = await Job.findById(job._id);
          this.io.emit('job_finished', { 
            jobId: job._id, 
            campaignId, 
            status: finishedJob.status 
          });
        }
        this.processQueue();
      });

      jobPromise.campaignId = campaignId.toString();
      this.runningJobs.set(job._id.toString(), jobPromise);
      return job;
    } catch (error) {
      console.error(`Failed to relaunch job ${jobId}:`, error.message);
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new QueueManager();
