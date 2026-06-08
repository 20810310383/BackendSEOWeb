const Job = require('../models/Job');
const QueueManager = require('../queue/QueueManager');

// Get all jobs (paginated/limited to 50 recent runs)
exports.getJobs = async (req, res) => {
  try {
    const jobs = await Job.find()
      .populate('campaignId', 'name keyword targetDomain')
      .populate('proxyId', 'host port protocol')
      .sort({ startedAt: -1, _id: -1 })
      .limit(50);
    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get single job details with complete logs
exports.getJobDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await Job.findById(id)
      .populate('campaignId')
      .populate('proxyId');
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Manually trigger a job for a campaign
exports.triggerJob = async (req, res) => {
  try {
    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID is required.' });

    const job = await QueueManager.triggerJob(campaignId, true);
    res.json({ message: 'Job triggered successfully', job });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Get hourly clicks success statistics for today
exports.getHourlyStats = async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const stats = await Job.aggregate([
      {
        $match: {
          status: 'success',
          completedAt: { $gte: startOfDay, $lte: endOfDay }
        }
      },
      {
        $group: {
          _id: { $hour: { date: '$completedAt', timezone: 'Asia/Ho_Chi_Minh' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const hourlyData = Array.from({ length: 24 }, (_, i) => ({
      hour: `${String(i).padStart(2, '0')}:00`,
      clicks: 0
    }));

    stats.forEach(s => {
      const hr = s._id;
      if (hr >= 0 && hr < 24) {
        hourlyData[hr].clicks = s.count;
      }
    });

    res.json(hourlyData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Rotate proxy for a job and relaunch it (safely closes browser if currently active)
exports.rotateJobProxy = async (req, res) => {
  try {
    const { id } = req.params;

    // Safety check: close active browser for this job before resetting and relaunching
    const { killJobBrowser } = require('../automation/AutomationEngine');
    await killJobBrowser(id);

    const Proxy = require('../models/Proxy'); // Import model
    const job = await Job.findById(id);
    if (!job) return res.status(404).json({ error: 'Tác vụ không tồn tại.' });

    // Mark current proxy as failed if it exists
    if (job.proxyId) {
      await Proxy.findByIdAndUpdate(job.proxyId, { status: 'failed', $inc: { failCount: 1 } });
    }

    // Get a new proxy
    const newProxy = await QueueManager.getNextProxy();
    
    // Reset job details
    job.proxyId = newProxy ? newProxy._id : null;
    job.status = 'pending';
    job.ipAddress = '';
    job.errorMessage = '';
    job.logs = [{ level: 'info', message: 'Hệ thống tự động đổi Proxy mới và khởi chạy lại tác vụ này.' }];
    await job.save();

    // Relaunch the job
    await QueueManager.relaunchJob(job._id);

    res.json({ message: 'Đã đổi Proxy và khởi chạy lại tác vụ thành công.', job });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Rotate proxy and relaunch all jobs that failed (failed, captcha_blocked)
exports.rotateAllJobsProxy = async (req, res) => {
  try {
    const Job = require('../models/Job');
    const Proxy = require('../models/Proxy');
    const { killJobBrowser } = require('../automation/AutomationEngine');

    // Find all jobs that are failed or captcha_blocked
    const jobsToRerun = await Job.find({ status: { $in: ['failed', 'captcha_blocked'] } });
    if (jobsToRerun.length === 0) {
      return res.json({ message: 'Không có tác vụ thất bại nào cần chạy lại.', count: 0 });
    }

    const relaunchedJobs = [];
    for (const job of jobsToRerun) {
      try {
        // Kill active browser if running (should not be running since they failed, but keep for safety)
        await killJobBrowser(job._id.toString());

        // Mark current proxy as failed if it exists
        if (job.proxyId) {
          await Proxy.findByIdAndUpdate(job.proxyId, { status: 'failed', $inc: { failCount: 1 } });
        }

        // Get a new proxy
        const newProxy = await QueueManager.getNextProxy();

        // Reset job details
        job.proxyId = newProxy ? newProxy._id : null;
        job.status = 'pending';
        job.ipAddress = '';
        job.errorMessage = '';
        job.logs = [{ level: 'info', message: 'Hệ thống tự động đổi Proxy mới và chạy lại tác vụ thất bại.' }];
        await job.save();

        // Relaunch the job
        await QueueManager.relaunchJob(job._id);
        relaunchedJobs.push(job._id);
      } catch (err) {
        console.error(`Error relaunching job ${job._id} in bulk rotate:`, err.message);
      }
    }

    res.json({ 
      message: `Đã đổi Proxy và khởi chạy lại thành công ${relaunchedJobs.length} tác vụ thất bại.`, 
      count: relaunchedJobs.length 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Pause all running jobs and campaigns
exports.pauseAllJobs = async (req, res) => {
  try {
    const Campaign = require('../models/Campaign');
    const Job = require('../models/Job');
    const { stopAllJobs } = require('../automation/AutomationEngine');

    // 1. Update all campaigns status to paused
    await Campaign.updateMany({ status: 'active' }, { status: 'paused' });

    // 2. Find all jobs with status running or pending
    const runningJobs = await Job.find({ status: { $in: ['running', 'pending'] } });
    
    // Mark them in db first
    for (const job of runningJobs) {
      job.status = 'failed';
      job.errorMessage = 'Tác vụ bị tạm dừng bởi người dùng';
      if (!job.logs) job.logs = [];
      job.logs.push({ 
        timestamp: new Date(),
        level: 'warning', 
        message: 'Tác vụ bị tạm dừng bởi người dùng.' 
      });
      await job.save();
    }

    // 3. Close their browsers
    await stopAllJobs();

    res.json({ 
      message: 'Đã tạm dừng tất cả các luồng và chiến dịch thành công.',
      count: runningJobs.length 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

