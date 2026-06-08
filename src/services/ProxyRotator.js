const axios = require('axios');
const Proxy = require('../models/Proxy');

class ProxyRotator {
  constructor() {
    this.rotators = []; // Array of rotator objects
    this.io = null;
    this.enabled = false;
  }

  init(io) {
    this.io = io;
    
    // Support either multiple comma-separated URLs or single fallback URL
    const urlsStr = process.env.PROXY_ROTATION_API_URLS || process.env.PROXY_ROTATION_API_URL;
    
    if (urlsStr) {
      const urls = urlsStr.split(',').map(u => u.trim()).filter(Boolean);
      this.enabled = urls.length > 0;
      
      this.rotators = urls.map((url, index) => ({
        index,
        url,
        timerId: null,
        status: {
          index,
          enabled: true,
          lastFetched: null,
          success: false,
          error: null,
          timeChangeRemain: 0,
          nextRunTime: null,
          currentIp: null,
          currentPort: null,
          planTimeOfChange: 240,
          isTesting: false,
          testSuccess: false
        }
      }));
      
      console.log(`[ProxyRotator] Initialized with ${urls.length} concurrent rotating proxy URLs.`);
    } else {
      console.log('[ProxyRotator] Disabled: No PROXY_ROTATION_API_URLS or PROXY_ROTATION_API_URL defined in .env');
    }
  }

  start() {
    if (!this.enabled) return;
    
    console.log('[ProxyRotator] Starting background services...');
    this.rotators.forEach(rotator => {
      this.runRotator(rotator);
    });
  }

  stop() {
    this.rotators.forEach(rotator => {
      if (rotator.timerId) {
        clearTimeout(rotator.timerId);
        rotator.timerId = null;
      }
    });
    console.log('[ProxyRotator] Stopped all rotators.');
  }

  getStatus() {
    if (!this.enabled) {
      return { enabled: false, rotators: [] };
    }
    
    const rotatorsStatus = this.rotators.map(r => {
      const timeChangeRemain = r.status.nextRunTime
        ? Math.max(0, Math.round((r.status.nextRunTime.getTime() - Date.now()) / 1000))
        : 0;
      return {
        ...r.status,
        timeChangeRemain
      };
    });

    return {
      enabled: true,
      rotators: rotatorsStatus
    };
  }

  broadcastStatus() {
    if (this.io) {
      this.io.emit('proxy_rotation_status', this.getStatus());
    }
  }

  async forceRotate(index) {
    if (!this.enabled) {
      throw new Error('Chức năng xoay proxy tự động chưa được bật (.env thiếu PROXY_ROTATION_API_URLS)');
    }
    
    const rotator = this.rotators.find(r => r.index === index);
    if (!rotator) {
      throw new Error(`Không tìm thấy cấu hình xoay proxy tại index: ${index}`);
    }

    if (rotator.timerId) {
      clearTimeout(rotator.timerId);
      rotator.timerId = null;
    }

    await this.runRotator(rotator, true);
    return this.getStatus();
  }

  // Recursive connectivity verification routine with retry mechanism
  async testProxyConnectivity(host, port, attempt = 1, maxAttempts = 3) {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    try {
      console.log(`[ProxyRotator] Testing connection for ${host}:${port} (Attempt ${attempt}/${maxAttempts})...`);
      
      const proxyConfig = {
        host: host,
        port: port
      };
      
      // Simple IP lookup test routed through the proxy
      await axios.get('https://api.ipify.org?format=json', {
        proxy: proxyConfig, // since protocol is HTTP
        timeout: 7000
      });
      
      console.log(`[ProxyRotator] Connection test PASSED for ${host}:${port}`);
      return true;
    } catch (error) {
      console.warn(`[ProxyRotator] Connection test FAILED for ${host}:${port} on attempt ${attempt}: ${error.message}`);
      
      if (attempt < maxAttempts) {
        console.log(`[ProxyRotator] Waiting 3 seconds before next connection test attempt...`);
        await delay(3000);
        return await this.testProxyConnectivity(host, port, attempt + 1, maxAttempts);
      }
      
      return false;
    }
  }

  async runRotator(rotator, isManual = false) {
    const { index, url } = rotator;
    
    try {
      console.log(`[ProxyRotator Slot #${index}] Fetching proxy... (Manual: ${isManual})`);
      const response = await axios.get(url, { timeout: 15000 });
      
      rotator.status.lastFetched = new Date();

      if (response.data && response.data.success && response.data.data) {
        const data = response.data.data;
        const proxyHttp = data.proxyHttp; // e.g. "116.96.160.54:15843"
        
        if (!proxyHttp) {
          throw new Error('API returned success but proxyHttp field is empty.');
        }

        const [host, portStr] = proxyHttp.split(':');
        const port = parseInt(portStr, 10);

        rotator.status.success = true;
        rotator.status.error = null;
        rotator.status.currentIp = host;
        rotator.status.currentPort = port;
        rotator.status.planTimeOfChange = data.planTimeOfChange || 240;

        let remainSeconds = typeof data.timeChangeRemain === 'number' ? data.timeChangeRemain : 240;
        
        // Cooldown safeguard
        if (remainSeconds === 0) {
          remainSeconds = 15; 
        }

        rotator.status.nextRunTime = new Date(Date.now() + remainSeconds * 1000);

        // Check if DB record already exists
        const existingProxy = await Proxy.findOne({ host, port, rotationKey: url, isAutoCreated: true });
        
        if (!existingProxy) {
          console.log(`[ProxyRotator Slot #${index}] New IP detected: ${host}:${port}. Performing auto-testing connectivity check...`);
          
          rotator.status.isTesting = true;
          this.broadcastStatus();
          
          // Automatically test the proxy before marking active
          const testResult = await this.testProxyConnectivity(host, port);
          
          rotator.status.isTesting = false;
          rotator.status.testSuccess = testResult;

          // Mark ALL older proxies from this specific key slot as failed
          await Proxy.updateMany(
            { rotationKey: url, isAutoCreated: true, status: { $ne: 'failed' } },
            { status: 'failed' }
          );

          // Save the new proxy record to MongoDB
          const newProxy = new Proxy({
            host,
            port,
            protocol: 'http',
            status: testResult ? 'active' : 'failed',
            isAutoCreated: true,
            rotationKey: url,
            createdAt: new Date()
          });
          await newProxy.save();

          console.log(`[ProxyRotator Slot #${index}] Saved proxy ${host}:${port} as status: "${testResult ? 'active' : 'failed'}"`);

          if (this.io) {
            this.io.emit('proxy_updated');
          }
        } else {
          // If the proxy is already stored, ensure its test success syncs to state
          rotator.status.testSuccess = existingProxy.status === 'active';
          console.log(`[ProxyRotator Slot #${index}] Active proxy is still ${host}:${port}. No DB update needed.`);
        }

        this.scheduleRotator(rotator, remainSeconds * 1000);
      } else {
        const errorMsg = response.data ? response.data.message || 'API request failed' : 'Empty response';
        throw new Error(errorMsg);
      }
    } catch (err) {
      // Check if it's a cooldown error (400 Bad Request with success: false)
      if (err.response && err.response.data && err.response.data.success === false) {
        const data = err.response.data;
        const messageStr = data.message || '';
        console.log(`[ProxyRotator Slot #${index}] API is currently on cooldown: ${messageStr}`);
        
        // Extract remaining seconds using regex
        const match = messageStr.match(/(\d+)\s*giây/i);
        let remainSeconds = 60; // default fallback
        if (match) {
          remainSeconds = parseInt(match[1], 10);
        }
        
        rotator.status.success = true; // Mark as successful API communications
        rotator.status.error = null;
        rotator.status.isTesting = false;
        rotator.status.nextRunTime = new Date(Date.now() + remainSeconds * 1000);
        
        // Restore last known IP/port from MongoDB if memory is empty
        if (!rotator.status.currentIp) {
          try {
            const lastProxy = await Proxy.findOne({ rotationKey: url, isAutoCreated: true }).sort({ createdAt: -1 });
            if (lastProxy) {
              rotator.status.currentIp = lastProxy.host;
              rotator.status.currentPort = lastProxy.port;
              rotator.status.testSuccess = lastProxy.status === 'active';
            }
          } catch (dbErr) {
            console.error(`[ProxyRotator Slot #${index}] Error retrieving last proxy from DB:`, dbErr.message);
          }
        }
        
        this.scheduleRotator(rotator, remainSeconds * 1000);
        return;
      }

      console.error(`[ProxyRotator Slot #${index}] Failed to fetch proxy:`, err.message);
      rotator.status.success = false;
      rotator.status.error = err.message;
      rotator.status.isTesting = false;
      
      // Restore last known IP/port from MongoDB if memory is empty so the UI doesn't look blank
      if (!rotator.status.currentIp) {
        try {
          const lastProxy = await Proxy.findOne({ rotationKey: url, isAutoCreated: true }).sort({ createdAt: -1 });
          if (lastProxy) {
            rotator.status.currentIp = lastProxy.host;
            rotator.status.currentPort = lastProxy.port;
            rotator.status.testSuccess = lastProxy.status === 'active';
          }
        } catch (dbErr) {}
      }

      // Retry in 30 seconds
      rotator.status.nextRunTime = new Date(Date.now() + 30000);
      this.scheduleRotator(rotator, 30000);
    } finally {
      this.broadcastStatus();
    }
  }

  scheduleRotator(rotator, ms) {
    if (rotator.timerId) clearTimeout(rotator.timerId);
    
    // Add 2s padding to ensure remote cooldown resets fully
    const delay = ms + 2000;
    console.log(`[ProxyRotator Slot #${rotator.index}] Next fetch scheduled in ${Math.round(delay / 1000)} seconds.`);
    rotator.timerId = setTimeout(() => this.runRotator(rotator), delay);
  }
}

module.exports = new ProxyRotator();
