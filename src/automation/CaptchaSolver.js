const axios = require('axios');

/**
 * Delay helper
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Solve reCAPTCHA using selected provider
 */
async function solveReCaptcha(pageUrl, siteKey, provider, apiKey, log) {
  if (!provider || provider === 'none' || !apiKey) {
    log('warning', 'Phát hiện thấy reCAPTCHA, nhưng chưa cấu hình dịch vụ giải captcha tự động trong .env.');
    return null;
  }

  log('info', `Đang gửi yêu cầu giải reCAPTCHA lên nhà cung cấp: ${provider}...`);
  try {
    if (provider === '2captcha') {
      return await solve2Captcha(pageUrl, siteKey, apiKey, log);
    } else if (provider === 'anticaptcha') {
      return await solveAntiCaptcha(pageUrl, siteKey, apiKey, log);
    } else if (provider === 'capsolver') {
      return await solveCapsolver(pageUrl, siteKey, apiKey, log);
    } else {
      log('error', `Nhà cung cấp giải CAPTCHA không hợp lệ hoặc chưa được hỗ trợ: ${provider}`);
      return null;
    }
  } catch (error) {
    log('error', `Lỗi hệ thống giải CAPTCHA tự động: ${error.message}`);
    return null;
  }
}

/**
 * 2Captcha Implementation
 */
async function solve2Captcha(pageUrl, siteKey, apiKey, log) {
  // 1. Submit captcha
  const submitRes = await axios.get('http://2captcha.com/in.php', {
    params: {
      key: apiKey,
      method: 'userrecaptcha',
      googlekey: siteKey,
      pageurl: pageUrl,
      json: 1
    }
  });

  if (submitRes.data.status !== 1) {
    throw new Error(`2Captcha gửi yêu cầu thất bại: ${submitRes.data.request}`);
  }

  const taskId = submitRes.data.request;
  log('info', `Đã tạo tác vụ 2Captcha. ID: ${taskId}. Đang đợi phản hồi...`);

  // 2. Poll for solution
  for (let attempt = 1; attempt <= 20; attempt++) {
    await delay(5000);
    const pollRes = await axios.get('http://2captcha.com/res.php', {
      params: {
        key: apiKey,
        action: 'get',
        id: taskId,
        json: 1
      }
    });

    if (pollRes.data.status === 1) {
      log('success', '2Captcha đã giải mã CAPTCHA thành công.');
      return pollRes.data.request;
    }

    if (pollRes.data.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2Captcha báo lỗi: ${pollRes.data.request}`);
    }

    log('info', `Đang lấy kết quả giải 2Captcha (lần thứ ${attempt}/20): Chưa giải xong, đang đợi...`);
  }

  throw new Error('Hết thời gian chờ kết quả giải 2Captcha (quá 100 giây).');
}

/**
 * Anti-Captcha Implementation
 */
async function solveAntiCaptcha(pageUrl, siteKey, apiKey, log) {
  // 1. Submit captcha
  const submitRes = await axios.post('https://api.anti-captcha.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'NoCaptchaTaskProxyless',
      websiteURL: pageUrl,
      websiteKey: siteKey
    }
  });

  if (submitRes.data.errorId !== 0) {
    throw new Error(`Anti-Captcha gửi yêu cầu thất bại: ${submitRes.data.errorDescription}`);
  }

  const taskId = submitRes.data.taskId;
  log('info', `Đã tạo tác vụ Anti-Captcha. ID: ${taskId}. Đang đợi phản hồi...`);

  // 2. Poll for solution
  for (let attempt = 1; attempt <= 20; attempt++) {
    await delay(5000);
    const pollRes = await axios.post('https://api.anti-captcha.com/getTaskResult', {
      clientKey: apiKey,
      taskId: taskId
    });

    if (pollRes.data.errorId !== 0) {
      throw new Error(`Anti-Captcha báo lỗi: ${pollRes.data.errorDescription}`);
    }

    if (pollRes.data.status === 'ready') {
      log('success', 'Anti-Captcha đã giải mã CAPTCHA thành công.');
      return pollRes.data.solution.gRecaptchaResponse;
    }

    log('info', `Đang lấy kết quả giải Anti-Captcha (lần thứ ${attempt}/20): Chưa giải xong, đang đợi...`);
  }

  throw new Error('Hết thời gian chờ kết quả giải Anti-Captcha (quá 100 giây).');
}

/**
 * Capsolver Implementation
 */
async function solveCapsolver(pageUrl, siteKey, apiKey, log) {
  // 1. Submit captcha
  const submitRes = await axios.post('https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL: pageUrl,
      websiteKey: siteKey
    }
  });

  if (submitRes.data.errorId !== 0) {
    throw new Error(`Capsolver gửi yêu cầu thất bại: ${submitRes.data.errorDescription}`);
  }

  const taskId = submitRes.data.taskId;
  log('info', `Đã tạo tác vụ Capsolver. ID: ${taskId}. Đang đợi phản hồi...`);

  // 2. Poll for solution
  for (let attempt = 1; attempt <= 20; attempt++) {
    await delay(5000);
    const pollRes = await axios.post('https://api.capsolver.com/getTaskResult', {
      clientKey: apiKey,
      taskId: taskId
    });

    if (pollRes.data.errorId !== 0) {
      throw new Error(`Capsolver báo lỗi: ${pollRes.data.errorDescription}`);
    }

    if (pollRes.data.status === 'ready') {
      log('success', 'Capsolver đã giải mã CAPTCHA thành công.');
      return pollRes.data.solution.gRecaptchaResponse;
    }

    log('info', `Đang lấy kết quả giải Capsolver (lần thứ ${attempt}/20): Chưa giải xong, đang đợi...`);
  }

  throw new Error('Hết thời gian chờ kết quả giải Capsolver (quá 100 giây).');
}

module.exports = {
  solveReCaptcha
};
