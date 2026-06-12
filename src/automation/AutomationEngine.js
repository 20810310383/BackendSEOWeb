const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { getRandomFingerprint } = require('./fingerprints');
const { solveReCaptcha } = require('./CaptchaSolver');
const Job = require('../models/Job');
const Campaign = require('../models/Campaign');
const Proxy = require('../models/Proxy');

// Use stealth plugin
puppeteer.use(StealthPlugin());

// Active browsers tracking map (jobId -> browser)
const activeBrowsers = new Map();

/**
 * Extract root domain helper
 */
function getRootDomain(url) {
  let domain = url.replace(/^(https?:\/\/)?(www\.)?/, '');
  domain = domain.split('/')[0];
  return domain;
}

/**
 * Natural delay helper
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Type characters like a human with random delays
 */
async function typeLikeHuman(page, selector, text, log) {
  try {
    await page.focus(selector);
    for (const char of text) {
      const charDelay = Math.floor(Math.random() * 80) + 70; // 70-150ms delay
      await page.keyboard.sendCharacter(char);
      await delay(charDelay);
    }
  } catch (error) {
    log('error', `Không thể mô phỏng gõ chữ tự nhiên: ${error.message}`);
    // fallback
    await page.type(selector, text, { delay: 100 });
  }
}

/**
 * Move virtual mouse across coordinates to click
 */
async function clickLikeHuman(page, x, y, log) {
  log('info', `Đang di chuyển chuột ảo tới tọa độ liên kết mục tiêu: (${x}, ${y})`);
  // Start mouse at random position
  const startX = Math.floor(Math.random() * 200);
  const startY = Math.floor(Math.random() * 200);
  await page.mouse.move(startX, startY);

  // Move in random curved/segmented steps
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    // Simple linear interpolation with slight noise
    const currentX = startX + (x - startX) * progress + (Math.random() * 4 - 2);
    const currentY = startY + (y - startY) * progress + (Math.random() * 4 - 2);
    await page.mouse.move(Math.round(currentX), Math.round(currentY));
    await delay(Math.floor(Math.random() * 10) + 10);
  }

  // Click
  await page.mouse.click(x, y);
  log('success', 'Đã click vào link mục tiêu bằng đường di chuyển chuột ảo.');
}

/**
 * Accept Google Consent if prompted
 */
async function acceptGoogleConsent(page, log) {
  try {
    // Check common Google Accept buttons
    // L2AGLb is English/European common ID.
    // Also look for buttons containing "Accept all", "Tôi đồng ý", "I agree"
    const consentSelectors = [
      'button#L2AGLb',
      'button[aria-label="Accept all"]',
      'button[aria-label="Tôi đồng ý"]',
      'div[role="none"] button' // Generic button search fallback
    ];

    for (const selector of consentSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        const text = await page.evaluate(el => el.innerText, btn);
        if (text.toLowerCase().includes('accept') || text.toLowerCase().includes('đồng ý') || text.toLowerCase().includes('agree') || selector === 'button#L2AGLb') {
          log('info', `Phát hiện bảng hỏi sự đồng ý của Google. Đang bấm chọn: "${text.trim()}"`);
          await btn.click();
          await delay(2000);
          return;
        }
      }
    }
  } catch (err) {
    log('info', `Bỏ qua hoặc không hiển thị bảng hỏi đồng ý của Google: ${err.message}`);
  }
}

/**
 * Detect Google CAPTCHA page and attempt solving
 */
async function checkAndSolveGoogleCaptcha(page, provider, apiKey, log) {
  const pageUrl = page.url();
  const isSorryPage = pageUrl.includes('google.com/sorry/');

  // Check for recaptcha selector
  const hasCaptchaEl = await page.evaluate(() => {
    return !!(document.querySelector('.g-recaptcha') ||
      document.querySelector('iframe[src*="recaptcha"]') ||
      document.querySelector('#recaptcha'));
  });

  if (!isSorryPage && !hasCaptchaEl) {
    return false;
  }

  log('warning', 'Phát hiện trang Google CAPTCHA! Đang khởi tạo bộ giải tự động...');

  // Extract Sitekey
  const siteKey = await page.evaluate(() => {
    const element = document.querySelector('.g-recaptcha');
    if (element && element.getAttribute('data-sitekey')) {
      return element.getAttribute('data-sitekey');
    }
    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    if (iframe) {
      const url = new URL(iframe.src);
      return url.searchParams.get('k');
    }
    // Try to find inside script or other elements
    const captchaDiv = document.querySelector('#recaptcha');
    if (captchaDiv && captchaDiv.getAttribute('data-sitekey')) {
      return captchaDiv.getAttribute('data-sitekey');
    }
    return null;
  });

  if (!siteKey) {
    log('error', 'Không thể trích xuất mã recaptcha sitekey từ trang Google CAPTCHA.');
    return false;
  }

  log('info', `Đã trích xuất mã sitekey: ${siteKey}`);

  if (!provider || provider === 'none' || !apiKey) {
    log('error', 'Gặp CAPTCHA nhưng chưa cấu hình API giải mã trong file .env. Hãy tự giải tay hoặc mua key API.');
    return false;
  }

  const token = await solveReCaptcha(pageUrl, siteKey, provider, apiKey, log);
  if (!token) {
    log('error', 'Hệ thống giải CAPTCHA thất bại, không trả về token kết quả.');
    return false;
  }

  log('info', 'Đang nạp token kết quả và gửi xác nhận vượt CAPTCHA...');

  const submitSuccess = await page.evaluate((tokenVal) => {
    try {
      const responseArea = document.querySelector('#g-recaptcha-response');
      if (responseArea) {
        responseArea.value = tokenVal;
      }

      // Look for forms and submit buttons on sorry page
      const sorryForm = document.querySelector('form[action="index"]');
      if (sorryForm) {
        sorryForm.submit();
        return true;
      }

      // Fallback: search for submit button and click it
      const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
      if (submitBtn) {
        submitBtn.click();
        return true;
      }

      return false;
    } catch (e) {
      return false;
    }
  }, token);

  if (submitSuccess) {
    log('info', 'Đã gửi CAPTCHA đã giải. Đang chờ chuyển hướng...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
    return true;
  } else {
    log('error', 'Không tìm thấy form hoặc nút nhấn gửi CAPTCHA trên trang.');
    return false;
  }
}

/**
 * Execute automation run
 */
async function runAutomation(jobId, onLog) {
  let browser = null;
  let job = null;
  let campaign = null;
  let proxy = null;
  let startTime = Date.now();
  let page = null;
  let currentTargetDomain = '';

  // Custom log broadcaster helper
  const log = async (level, message, botState = '') => {
    console.log(`[Job ${jobId}][${level.toUpperCase()}] ${message}`);

    // Broadcast via socket.io client callback
    if (onLog) {
      onLog({ timestamp: new Date(), level, message, botState });
    }

    // Persist log inside MongoDB
    try {
      const updateData = {
        $push: { logs: { timestamp: new Date(), level, message } }
      };
      if (botState) {
        updateData.botState = botState;
      }
      await Job.findByIdAndUpdate(jobId, updateData);
    } catch (err) {
      console.error('Không thể lưu log vào MongoDB:', err.message);
    }
  };

  try {
    job = await Job.findById(jobId).populate('proxyId');
    if (!job) throw new Error('Không tìm thấy tác vụ (job) trong cơ sở dữ liệu.');

    campaign = await Campaign.findById(job.campaignId);
    if (!campaign) throw new Error('Không tìm thấy chiến dịch (campaign) tương ứng.');

    proxy = job.proxyId;

    // Parse target domain list (supports single line or multi-line)
    const targetDomainsList = campaign.targetDomain.split(/\r?\n/).map(d => d.trim()).filter(Boolean);
    const currentRunIndex = (campaign.successCount || 0) + (campaign.failCount || 0);
    currentTargetDomain = targetDomainsList.length > 0
      ? targetDomainsList[currentRunIndex % targetDomainsList.length]
      : campaign.targetDomain;
    const rootDomain = getRootDomain(currentTargetDomain);

    startTime = Date.now();
    await Job.findByIdAndUpdate(jobId, { status: 'running', startedAt: new Date(startTime) });
    await log('info', `Bắt đầu tiến trình SEO cho từ khóa: "${campaign.keyword}" -> Tên miền đích: "${currentTargetDomain}" (Lượt chạy: ${currentRunIndex + 1})`, 'launching');

    // Fingerprint setup
    const fingerprint = getRandomFingerprint();
    await log('info', `Đã chọn cấu hình vân tay trình duyệt: UA="${fingerprint.userAgent}" Độ phân giải=${fingerprint.viewport.width}x${fingerprint.viewport.height}`, 'launching');

    // Launch configurations
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--window-size=${fingerprint.viewport.width},${fingerprint.viewport.height}`
    ];

    if (proxy) {
      const proxyUrl = `${proxy.protocol}://${proxy.host}:${proxy.port}`;
      launchArgs.push(`--proxy-server=${proxyUrl}`);
      await log('info', `Đang định tuyến lưu lượng qua Proxy: ${proxyUrl}`, 'launching');
    } else {
      await log('warning', 'Không cấu hình proxy. Chạy trực tiếp bằng IP mạng nội bộ.', 'launching');
    }

    // Launch browser
    // Default to headed mode (headless: false) for easy tracking, unless explicitly set to true in .env
    const runHeadless = process.env.HEADLESS === 'true';
    await log('info', `Đang khởi chạy trình duyệt (Chạy ngầm: ${runHeadless})`, 'launching');
    browser = await puppeteer.launch({
      headless: runHeadless,
      args: launchArgs,
      defaultViewport: null
    });
    activeBrowsers.set(jobId.toString(), browser);

    page = (await browser.pages())[0] || (await browser.newPage());

    // Set custom screen size & UA
    await page.setViewport(fingerprint.viewport);
    await page.setUserAgent(fingerprint.userAgent);

    // Proxy authentication if credentials exist
    if (proxy && proxy.username && proxy.password) {
      await log('info', `Đang xác thực proxy với tài khoản: "${proxy.username}"`);
      await page.authenticate({
        username: proxy.username,
        password: proxy.password
      });
    }

    // Check IP address via external site to verify proxy works
    try {
      await log('info', 'Đang xác thực địa chỉ IP chiều đi...', 'network');
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2', timeout: 20000 });
      const ipJson = await page.evaluate(() => JSON.parse(document.body.innerText));
      await log('success', `Proxy hoạt động ổn định. IP chiều đi: ${ipJson.ip}`, 'network');
      await Job.findByIdAndUpdate(jobId, { ipAddress: ipJson.ip });
    } catch (err) {
      await log('warning', `Không thể xác minh IP của proxy: ${err.message}. Vẫn tiếp tục thực hiện.`, 'network');
    }

    // Load Google
    await log('info', 'Đang truy cập trang chủ Google...', 'searching');
    await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 30000 });

    // Accept Google consent overlay if it shows
    await acceptGoogleConsent(page, log);

    // Load captcha configurations from environment
    const captchaProvider = process.env.CAPTCHA_PROVIDER || 'none';
    const captchaApiKey = process.env.CAPTCHA_API_KEY || '';

    // Check if initial load is CAPTCHA-blocked
    let solved = await checkAndSolveGoogleCaptcha(page, captchaProvider, captchaApiKey, (lvl, msg) => log(lvl, msg, 'captcha'));
    if (solved) {
      await log('success', 'Đã vượt qua lớp CAPTCHA ban đầu của Google.', 'searching');
    }

    // Identify Google input box
    let searchInputSelector = 'textarea[name="q"]';
    let inputExists = await page.$(searchInputSelector);

    if (!inputExists) {
      searchInputSelector = 'input[name="q"]';
      inputExists = await page.$(searchInputSelector);
    }

    if (!inputExists) {
      throw new Error('Không tìm thấy thanh tìm kiếm của Google. Giao diện trang có thể đã thay đổi.');
    }

    // human typing
    await log('info', `Đang mô phỏng gõ từ khóa: "${campaign.keyword}"...`, 'searching');
    await typeLikeHuman(page, searchInputSelector, campaign.keyword, log);
    await delay(Math.floor(Math.random() * 500) + 300);

    // Press Enter to search
    await log('info', 'Nhấn Enter để gửi truy vấn tìm kiếm...', 'searching');
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });

    // Check for CAPTCHA after search
    solved = await checkAndSolveGoogleCaptcha(page, captchaProvider, captchaApiKey, (lvl, msg) => log(lvl, msg, 'captcha'));
    if (solved) {
      await log('success', 'Đã vượt qua lớp CAPTCHA khi gửi truy vấn.', 'searching');
    }

    // Scroll Google results page slowly (human behavior)
    let pageIndex = 1;
    let foundLink = false;

    while (pageIndex <= campaign.maxPageSearch && !foundLink) {
      await log('info', `Đang quét kết quả Google trang thứ ${pageIndex} để tìm tên miền "${rootDomain}" (Đích: "${currentTargetDomain}")...`);
      await Job.findByIdAndUpdate(jobId, { pagesSearched: pageIndex });

      // Human-like scrolls down the search results
      for (let s = 0; s < 4; s++) {
        const scrollDist = Math.floor(Math.random() * 150) + 150;
        await page.evaluate((d) => window.scrollBy(0, d), scrollDist);
        await delay(Math.floor(Math.random() * 600) + 400);
      }

      // Check results for target domain in anchor tags
      const results = await page.evaluate((domain) => {
        const list = [];
        const links = document.querySelectorAll('a');
        links.forEach((a, index) => {
          const href = a.href || '';
          if (href.toLowerCase().includes(domain.toLowerCase())) {
            // Find bounding box coordinate data
            const rect = a.getBoundingClientRect();
            list.push({
              index,
              href,
              text: a.innerText,
              x: rect.x + window.scrollX,
              y: rect.y + window.scrollY,
              width: rect.width,
              height: rect.height,
              isVisible: rect.width > 0 && rect.height > 0
            });
          }
        });
        return list;
      }, rootDomain);

      // Filter visible links
      const targetLinks = results.filter(r => r.isVisible);

      if (targetLinks.length > 0) {
        foundLink = true;
        const target = targetLinks[0];
        await log('success', `Đã tìm thấy link tên miền mục tiêu! Href: "${target.href}" tại trang kết quả thứ ${pageIndex}`);

        // Scroll target link into view
        await page.evaluate((y) => {
          window.scrollTo({ top: y - 200, behavior: 'smooth' });
        }, target.y);
        await delay(1500);

        // Click target link
        const box = await page.evaluate((idx) => {
          const el = document.querySelectorAll('a')[idx];
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }, target.index);

        // Track new targets (tabs) that might open
        const newTargetPromise = new Promise(resolve => browser.once('targetcreated', targetObj => resolve(targetObj.page())));

        if (box && box.w > 0 && box.h > 0) {
          const clickX = Math.round(box.x + box.w / 2);
          const clickY = Math.round(box.y + box.h / 2);
          await clickLikeHuman(page, clickX, clickY, log);
        } else {
          await log('warning', 'Không định vị được tọa độ liên kết. Kích hoạt click thông thường.');
          await page.evaluate((idx) => {
            document.querySelectorAll('a')[idx].click();
          }, target.index);
        }

        // Wait to see if a new tab was opened, or if the current tab is navigating
        let activePage = page;

        try {
          // Wait up to 5s for a new tab
          const newTabPage = await Promise.race([
            newTargetPromise,
            delay(5000).then(() => null)
          ]);

          if (newTabPage) {
            await log('info', 'Phát hiện liên kết mở ở tab mới. Đang chuyển hướng sang tab mới...');
            activePage = newTabPage;
            await activePage.bringToFront();
          }
        } catch (err) {
          await log('info', 'Không mở tab mới, tiếp tục theo dõi trên tab hiện tại.');
        }

        // Wait for page to fully redirect/load target domain
        await log('info', 'Đang đợi trang tải dữ liệu và xác định đúng tên miền...');

        let loadedTarget = false;
        for (let check = 0; check < 15; check++) {
          await delay(2000);
          const currentUrl = activePage.url();
          if (currentUrl.toLowerCase().includes(rootDomain.toLowerCase())) {
            loadedTarget = true;
            break;
          }
        }

        if (!loadedTarget) {
          // If navigation is slow, wait network idle
          await activePage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
        }

        // Double check if we are on the target domain. If not, redirect directly.
        const finalUrl = activePage.url();
        if (!finalUrl.toLowerCase().includes(currentTargetDomain.toLowerCase())) {
          let targetUrl = currentTargetDomain;
          if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = 'https://' + targetUrl;
          }
          await log('warning', `Địa chỉ hiện tại (${finalUrl}) chưa khớp với liên kết đích. Tiến hành chuyển hướng trực tiếp tới: ${targetUrl}`);
          await activePage.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 25000 }).catch(err => {
            log('error', `Điều hướng trực tiếp thất bại: ${err.message}`);
          });
        }

        // Assign the active page to page variable for the subsequent onsite interaction
        page = activePage;
        break;
      }

      // If not found, go to the next page
      if (pageIndex < campaign.maxPageSearch) {
        pageIndex++;

        // Scroll down to the bottom to find pagination
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1500);

        // Look for next page button
        const nextBtnSelector = '#pnnext, a[aria-label="Next page"], a[aria-label="Trang sau"]';
        const nextBtn = await page.$(nextBtnSelector);

        if (nextBtn) {
          await log('info', 'Đang click nút "Trang sau" để tiếp tục tìm kiếm.', 'searching');
          await nextBtn.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });

          // Check for CAPTCHA on page transition
          solved = await checkAndSolveGoogleCaptcha(page, captchaProvider, captchaApiKey, (lvl, msg) => log(lvl, msg, 'captcha'));
          if (solved) {
            await log('success', 'Đã vượt qua lớp CAPTCHA phân trang của Google.', 'captcha');
          }
        } else {
          await log('warning', 'Không tìm thấy nút "Trang sau" trên phân trang Google. Dừng tìm kiếm.', 'searching');
          break;
        }
      } else {
        break;
      }
    }

    if (!foundLink) {
      throw new Error(`Không tìm thấy tên miền mục tiêu "${currentTargetDomain}" trong kết quả tìm kiếm cho đến trang ${campaign.maxPageSearch}.`);
    }

    // Simulate Onsite Behavior
    const randomDuration = Math.floor(Math.random() * (campaign.maxDuration - campaign.minDuration + 1)) + campaign.minDuration;
    await log('info', `Đã truy cập trang mục tiêu thành công. Tiêu đề trang: "${await page.title()}"`, `onsite:${randomDuration}`);

    // Simulate reading/onsite activity
    const activityEndTime = Date.now() + (randomDuration * 1000);
    while (Date.now() < activityEndTime) {
      // Scroll down
      const distance = Math.floor(Math.random() * 200) + 100;
      const direction = Math.random() > 0.15 ? 1 : -1; // mostly down
      await page.evaluate((dist) => window.scrollBy(0, dist), distance * direction);

      const restTime = Math.floor(Math.random() * 3000) + 2000; // 2 to 5 seconds rest
      const remainingSeconds = Math.max(0, Math.round((activityEndTime - Date.now()) / 1000));
      await log('info', `Đang mô phỏng đọc nội dung... cuộn chuột ${direction > 0 ? 'xuống' : 'lên'} ${distance}px. Tạm dừng nghỉ ${Math.round(restTime / 1000)} giây`, `onsite:${remainingSeconds}`);
      await delay(restTime);
    }

    // Success final updates
    await log('success', 'Hoàn thành toàn bộ tiến trình SEO thành công! Đã thỏa mãn thời gian onsite.', 'success');

    await Job.findByIdAndUpdate(jobId, {
      status: 'success',
      completedAt: new Date(),
      duration: Math.round((Date.now() - startTime) / 1000)
    });

    // Update campaign counters
    await Campaign.findByIdAndUpdate(campaign._id, {
      $inc: { successCount: 1 },
      lastRunAt: new Date()
    });

    if (proxy) {
      await Proxy.findByIdAndUpdate(proxy._id, {
        lastUsedAt: new Date(),
        failCount: 0,
        status: 'active'
      });
    }

  } catch (error) {
    let finalErrorMessage = error.message;
    let wasUserStopped = false;
    try {
      const dbJob = await Job.findById(jobId);
      if (dbJob && dbJob.errorMessage === 'Tác vụ bị tạm dừng bởi người dùng') {
        wasUserStopped = true;
        finalErrorMessage = 'Tác vụ bị tạm dừng bởi người dùng';
      }
    } catch (dbErr) {
      console.error('Error checking user stop status:', dbErr.message);
    }

    await log('error', `Tiến trình SEO thất bại: ${finalErrorMessage}`, 'failed');

    let jobStatus = 'failed';
    if (finalErrorMessage.includes('CAPTCHA')) {
      jobStatus = 'captcha_blocked';
    }

    await Job.findByIdAndUpdate(jobId, {
      status: jobStatus,
      completedAt: new Date(),
      duration: Math.round((Date.now() - startTime) / 1000),
      errorMessage: finalErrorMessage
    });

    // Update campaign metrics
    if (campaign && !wasUserStopped) {
      await Campaign.findByIdAndUpdate(campaign._id, {
        $inc: { failCount: 1 },
        lastRunAt: new Date()
      });
    }

    // Update proxy metrics
    if (proxy && !wasUserStopped) {
      const nextFailCount = (proxy.failCount || 0) + 1;
      await Proxy.findByIdAndUpdate(proxy._id, {
        lastUsedAt: new Date(),
        failCount: nextFailCount,
        status: nextFailCount >= 3 ? 'failed' : 'active'
      });
    }

  } finally {
    activeBrowsers.delete(jobId.toString());
    if (browser) {
      await log('info', 'Đang đóng trình duyệt.');
      await browser.close().catch(() => { });
    }
  }
}

async function killJobBrowser(jobId) {
  const browser = activeBrowsers.get(jobId.toString());
  if (browser) {
    console.log(`[AutomationEngine] Terminating active browser for job ${jobId}`);
    try {
      await browser.close();
    } catch (e) {
      console.error(`[AutomationEngine] Error closing browser for job ${jobId}:`, e.message);
    }
    activeBrowsers.delete(jobId.toString());
  }
}

async function stopAllJobs() {
  const jobIds = Array.from(activeBrowsers.keys());
  console.log(`[AutomationEngine] Terminating all active browsers. Count: ${jobIds.length}`);
  for (const jobId of jobIds) {
    const browser = activeBrowsers.get(jobId);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error(`[AutomationEngine] Error closing browser for job ${jobId}:`, e.message);
      }
    }
  }
  activeBrowsers.clear();
}

module.exports = {
  runAutomation,
  killJobBrowser,
  stopAllJobs
};
