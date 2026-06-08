const Proxy = require('../models/Proxy');
const axios = require('axios');

// Get all proxies
exports.getProxies = async (req, res) => {
  try {
    const proxies = await Proxy.find().sort({ createdAt: -1 });
    res.json(proxies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Create a proxy
exports.createProxy = async (req, res) => {
  try {
    const newProxy = new Proxy(req.body);
    const saved = await newProxy.save();
    res.status(201).json(saved);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Bulk add proxies (accepts plain text block)
exports.bulkCreateProxies = async (req, res) => {
  try {
    const { proxyText, protocol = 'http' } = req.body;
    if (!proxyText) return res.status(400).json({ error: 'Proxy data is required.' });

    const lines = proxyText.split('\n');
    const proxyDocs = [];

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      let host = '';
      let port = 80;
      let username = '';
      let password = '';
      let lineProto = protocol;

      // Check for protocol prefix e.g. socks5://host:port
      if (line.includes('://')) {
        const parts = line.split('://');
        lineProto = parts[0].toLowerCase();
        line = parts[1];
      }

      // Check format: user:pass@host:port
      if (line.includes('@')) {
        const parts = line.split('@');
        const authParts = parts[0].split(':');
        const hostParts = parts[1].split(':');
        
        username = authParts[0] || '';
        password = authParts[1] || '';
        host = hostParts[0] || '';
        port = parseInt(hostParts[1], 10) || 80;
      } 
      // Check format: host:port:user:pass
      else {
        const parts = line.split(':');
        if (parts.length >= 4) {
          host = parts[0];
          port = parseInt(parts[1], 10) || 80;
          username = parts[2];
          password = parts[3];
        } else if (parts.length === 2) {
          host = parts[0];
          port = parseInt(parts[1], 10) || 80;
        } else {
          // invalid line, skip
          continue;
        }
      }

      if (host && port) {
        proxyDocs.push({
          host,
          port,
          username,
          password,
          protocol: ['http', 'https', 'socks4', 'socks5'].includes(lineProto) ? lineProto : 'http'
        });
      }
    }

    if (proxyDocs.length === 0) {
      return res.status(400).json({ error: 'No valid proxies found in the text.' });
    }

    const inserted = await Proxy.insertMany(proxyDocs);
    res.json({ message: `Successfully imported ${inserted.length} proxies.`, inserted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Delete proxy
exports.deleteProxy = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Proxy.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: 'Proxy not found' });
    res.json({ message: 'Proxy deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Check if proxy works (via Node request)
exports.testProxy = async (req, res) => {
  try {
    const { id } = req.params;
    const proxy = await Proxy.findById(id);
    if (!proxy) return res.status(404).json({ error: 'Proxy not found' });

    proxy.status = 'testing';
    await proxy.save();

    // Configure client-side proxy via axios
    const proxyConfig = {
      host: proxy.host,
      port: proxy.port
    };

    if (proxy.username && proxy.password) {
      proxyConfig.auth = {
        username: proxy.username,
        password: proxy.password
      };
    }

    // Set request timeout to 6 seconds
    const start = Date.now();
    
    // axios request
    const response = await axios.get('https://api.ipify.org?format=json', {
      proxy: proxy.protocol.startsWith('http') ? proxyConfig : false, // axios only natively supports HTTP proxying easily
      timeout: 6000
    });

    const duration = Date.now() - start;
    proxy.status = 'active';
    proxy.failCount = 0;
    await proxy.save();

    res.json({ 
      success: true, 
      ip: response.data.ip, 
      responseTime: `${duration}ms`,
      message: 'Proxy connects successfully'
    });

  } catch (error) {
    const { id } = req.params;
    const proxy = await Proxy.findById(id);
    if (proxy) {
      proxy.status = 'failed';
      proxy.failCount = (proxy.failCount || 0) + 1;
      await proxy.save();
    }

    res.status(400).json({ 
      success: false, 
      error: error.message,
      message: 'Proxy connection failed'
    });
  }
};

// Get rotating proxy status
exports.getRotatingProxyStatus = (req, res) => {
  try {
    const ProxyRotator = require('../services/ProxyRotator');
    const status = ProxyRotator.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Force rotate proxy now
exports.forceRotateProxy = async (req, res) => {
  try {
    const { index = 0 } = req.body;
    const ProxyRotator = require('../services/ProxyRotator');
    const status = await ProxyRotator.forceRotate(parseInt(index, 10));
    res.json({ message: 'Xoay Proxy thành công.', status });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

