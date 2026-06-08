const express = require('express');
const router = express.Router();

// Controllers
const campaignController = require('../controllers/campaignController');
const proxyController = require('../controllers/proxyController');
const jobController = require('../controllers/jobController');

// Campaign routes
router.get('/campaigns', campaignController.getCampaigns);
router.post('/campaigns', campaignController.createCampaign);
router.put('/campaigns/:id', campaignController.updateCampaign);
router.delete('/campaigns/:id', campaignController.deleteCampaign);
router.patch('/campaigns/:id/toggle', campaignController.toggleCampaignStatus);

// Proxy routes
router.get('/proxies', proxyController.getProxies);
router.post('/proxies', proxyController.createProxy);
router.post('/proxies/bulk', proxyController.bulkCreateProxies);
router.get('/proxies/rotating/status', proxyController.getRotatingProxyStatus);
router.post('/proxies/rotating/rotate', proxyController.forceRotateProxy);
router.delete('/proxies/:id', proxyController.deleteProxy);
router.post('/proxies/:id/test', proxyController.testProxy);

// Job routes
router.get('/jobs/stats', jobController.getHourlyStats);
router.get('/jobs', jobController.getJobs);
router.get('/jobs/:id', jobController.getJobDetails);
router.post('/jobs/trigger', jobController.triggerJob);
router.post('/jobs/rotate-proxy/all', jobController.rotateAllJobsProxy);
router.post('/jobs/pause-all', jobController.pauseAllJobs);
router.post('/jobs/:id/rotate-proxy', jobController.rotateJobProxy);

module.exports = router;
