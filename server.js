const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
app.use(express.json());

app.post('/sign', async (req, res) => {
  const { viewerLink, otpCode } = req.body;
  
  if (!viewerLink || !otpCode) {
    return res.status(400).json({ success: false, error: 'viewerLink and otpCode are required' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    
    console.log('Opening ViewerLink:', viewerLink);
    await page.goto(viewerLink, { waitUntil: 'networkidle2', timeout: 30000 });

    // Ждём появления поля OTP
    console.log('Waiting for OTP input...');
    await page.waitForSelector('input[type="text"], input[type="number"], input[type="tel"]', { timeout: 15000 });
    
    // Небольшая пауза для полной загрузки
    await new Promise(r => setTimeout(r, 2000));

    // Находим поле ввода OTP и вводим код
    const otpInput = await page.$('input[type="text"], input[type="number"], input[type="tel"]');
    await otpInput.click({ clickCount: 3 });
    await otpInput.type(String(otpCode), { delay: 100 });
    
    console.log('OTP entered:', otpCode);
    await new Promise(r => setTimeout(r, 1000));

    // Ищем кнопку подтверждения и нажимаем
    const buttons = await page.$$('button');
    for (const button of buttons) {
      const text = await page.evaluate(el => el.textContent.toLowerCase(), button);
      if (text.includes('confirm') || text.includes('sign') || 
          text.includes('submit') || text.includes('ok') ||
          text.includes('weiter') || text.includes('bestätigen')) {
        await button.click();
        console.log('Clicked button:', text);
        break;
      }
    }

    await new Promise(r => setTimeout(r, 3000));
    
    // Скриншот для дебага
    await page.screenshot({ path: '/tmp/sign_result.png' });
    
    console.log('Signing completed successfully');
    res.json({ success: true, message: 'Document signed successfully' });

  } catch (error) {
    console.error('Error during signing:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Signing service running on port ${PORT}`));
