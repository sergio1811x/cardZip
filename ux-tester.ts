import { chromium, Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SCREENSHOTS_DIR = path.join(__dirname, 'ux-screenshots');
const TEST_LINK = 'https://detail.1688.com/offer/915601257818.html';
const BOT_USERNAME = 'cardzip_bot';

interface LogEntry { step: string; ts: string; notes?: string; screenshot?: string }
interface RawMsg { from: 'user' | 'bot'; text: string; ts: string; buttons?: string[] }

const actionLog: LogEntry[] = [];
const rawMessages: RawMsg[] = [];
let ssIdx = 0;

function log(step: string, notes?: string) {
  const e: LogEntry = { step, ts: new Date().toISOString(), notes };
  actionLog.push(e);
  console.log(`[${e.ts}] ${step}${notes ? ' — ' + notes : ''}`);
  return e;
}

async function ss(page: Page, name: string) {
  ssIdx++;
  const fn = `${String(ssIdx).padStart(2, '0')}_${name}.png`;
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, fn), fullPage: false });
  console.log(`  📸 ${fn}`);
  return fn;
}

// ── Telegram Web K helpers ──

async function sendMsg(page: Page, text: string) {
  const input = page.locator('.input-message-input').first();
  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) {
    throw new Error('Message input not visible');
  }
  await input.click({ force: true });
  await page.waitForTimeout(300);
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  await page.keyboard.type(text, { delay: 20 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  rawMessages.push({ from: 'user', text, ts: new Date().toISOString() });
  console.log(`  ⌨️ Sent: "${text.substring(0, 50)}"`);
  await page.waitForTimeout(1500);
}

async function getBubbleCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.bubble').length);
}

async function getLastIncomingText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const bubbles = document.querySelectorAll('.bubble:not(.is-out)');
    if (bubbles.length === 0) return '';
    const last = bubbles[bubbles.length - 1] as HTMLElement;
    const textEl = last.querySelector('.message, .text-content');
    return (textEl as HTMLElement)?.innerText?.trim() || '';
  });
}

async function collectAllBotMessages(page: Page) {
  const msgs = await page.evaluate(() => {
    const results: { text: string; buttons: string[] }[] = [];
    document.querySelectorAll('.bubble:not(.is-out)').forEach(b => {
      const textEl = b.querySelector('.message, .text-content');
      const text = (textEl as HTMLElement)?.innerText?.trim() || '';
      if (!text) return;
      const btns: string[] = [];
      b.querySelectorAll('.reply-markup button, .keyboard-button').forEach(btn => {
        const t = (btn as HTMLElement).innerText?.trim();
        if (t) btns.push(t);
      });
      results.push({ text, buttons: btns });
    });
    return results;
  });
  for (const m of msgs) {
    rawMessages.push({ from: 'bot', text: m.text, ts: new Date().toISOString(), buttons: m.buttons });
  }
  return msgs;
}

// Wait for analysis by tracking that NEW bubbles appeared with inline buttons
// bubbleCountBefore = count of all .bubble elements BEFORE sending the link
async function waitForAnalysis(page: Page, bubbleCountBefore: number, maxWaitMs = 180_000): Promise<boolean> {
  const start = Date.now();
  let lastProgress = '';

  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(3000);
    const elapsed = Math.round((Date.now() - start) / 1000);

    const status = await page.evaluate((beforeCount: number) => {
      const allBubbles = document.querySelectorAll('.bubble');
      // Only look at NEW bubbles (after our link message)
      const newBubbles: Element[] = [];
      for (let i = beforeCount; i < allBubbles.length; i++) {
        newBubbles.push(allBubbles[i]);
      }

      // Get the last new incoming bubble's text
      let lastText = '';
      let hasNewButtons = false;
      for (let i = newBubbles.length - 1; i >= 0; i--) {
        const b = newBubbles[i];
        if (b.classList.contains('is-out')) continue;
        const textEl = b.querySelector('.message, .text-content');
        if (!lastText) lastText = (textEl as HTMLElement)?.innerText?.trim() || '';
        const btns = b.querySelectorAll('.reply-markup button, .keyboard-button');
        if (btns.length > 0) { hasNewButtons = true; break; }
      }

      const match = lastText.match(/(\d+)%/);
      return {
        progress: match ? match[1] + '%' : '',
        hasNewButtons,
        lastText: lastText.substring(0, 120),
        newCount: newBubbles.length,
      };
    }, bubbleCountBefore);

    if (status.progress && status.progress !== lastProgress) {
      lastProgress = status.progress;
      console.log(`  ⏳ ${status.progress} (${elapsed}s) — ${status.lastText.substring(0, 60)}`);
    }

    // Analysis done = new bubbles with inline buttons
    if (status.hasNewButtons) {
      console.log(`  ✅ Analysis complete in ${elapsed}s (${status.newCount} new bubbles)`);
      await page.waitForTimeout(3000); // let final messages arrive
      return true;
    }

    // Periodic screenshots every ~20s
    if (elapsed % 20 < 4) {
      await ss(page, `progress_${elapsed}s`);
    }
  }

  console.log(`  ⚠️ Timeout ${Math.round(maxWaitMs / 1000)}s`);
  return false;
}

async function getInlineButtons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const btns: string[] = [];
    document.querySelectorAll('.reply-markup button, .keyboard-button').forEach(b => {
      const t = (b as HTMLElement).innerText?.trim();
      if (t && !btns.includes(t)) btns.push(t);
    });
    return btns;
  });
}

async function clickInlineButton(page: Page, buttonText: string): Promise<boolean> {
  console.log(`  🔘 Click: "${buttonText}"`);
  return page.evaluate((text) => {
    const buttons = document.querySelectorAll('.reply-markup button, .keyboard-button');
    for (const b of buttons) {
      const t = (b as HTMLElement).innerText?.trim();
      if (t && (t === text || t.includes(text))) {
        (b as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, buttonText);
}

async function waitForBotResponse(page: Page, timeout = 15_000) {
  const beforeText = await getLastIncomingText(page);
  const beforeCount = await getBubbleCount(page);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(2000);
    const afterCount = await getBubbleCount(page);
    if (afterCount > beforeCount) {
      await page.waitForTimeout(2000);
      return true;
    }
    // Check for message edit (same bubble count but different text)
    const afterText = await getLastIncomingText(page);
    if (afterText !== beforeText && afterText.length > 0) {
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

async function scrollToBottom(page: Page) {
  await page.evaluate(() => {
    const c = document.querySelector('.bubbles, .bubbles-inner');
    if (c) c.scrollTop = c.scrollHeight;
  });
  await page.waitForTimeout(500);
}

async function clickBackIfExists(page: Page) {
  const btns = await getInlineButtons(page);
  const back = btns.find(b => b.includes('Назад') || b.includes('◀') || b.includes('⬅'));
  if (back) {
    await clickInlineButton(page, back);
    await waitForBotResponse(page, 8000);
    await page.waitForTimeout(1000);
    return true;
  }
  return false;
}

// ── Scenarios ──

async function openBot(page: Page) {
  log('open_bot', 'Navigating to bot');
  await page.goto(`https://web.telegram.org/k/#@${BOT_USERNAME}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const tryOpen = async () => page.locator('.input-message-input').isVisible({ timeout: 3000 }).catch(() => false);

  if (await tryOpen()) { await ss(page, 'bot_opened'); return; }

  // tgaddr resolve
  log('bot_tgaddr');
  await page.goto('https://web.telegram.org/k/#?tgaddr=tg%3A%2F%2Fresolve%3Fdomain%3Dcardzip_bot', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  if (await tryOpen()) { await ss(page, 'bot_opened'); return; }

  // Search in sidebar
  log('search_bot');
  await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const topSearch = page.locator('#telegram-search-input, .input-search-input').first();
  if (await topSearch.isVisible().catch(() => false)) {
    await topSearch.click();
    await page.waitForTimeout(500);
    await page.keyboard.type('cardzip_bot', { delay: 50 });
    await page.waitForTimeout(4000);
    await ss(page, 'search_results');

    // Debug: dump search result structure
    const debugInfo = await page.evaluate(() => {
      const items = document.querySelectorAll('.chatlist-chat, [data-peer-id], .search-group *');
      const info: string[] = [];
      items.forEach((el, i) => {
        if (i > 20) return;
        const text = (el as HTMLElement).innerText?.substring(0, 40) || '';
        const cls = el.className?.toString().substring(0, 60) || '';
        const tag = el.tagName;
        if (text.includes('Card') || text.includes('card') || cls.includes('chat')) {
          info.push(`${tag}.${cls} => "${text}"`);
        }
      });
      return info;
    });
    console.log('  DEBUG search items:', debugInfo);

    // Click the A.row element directly (not the inner span)
    const rowLink = page.locator('a.row:has-text("CardZip"), a.row:has-text("cardzip")').first();
    if (await rowLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await rowLink.click({ force: true });
      console.log('  Clicked A.row via locator.click(force)');
    } else {
      // Fallback: click peer-title and walk up to A
      const peerTitle = page.locator('.peer-title:has-text("CardZip")').first();
      if (await peerTitle.isVisible({ timeout: 2000 }).catch(() => false)) {
        const box = await peerTitle.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          console.log('  Clicked peer-title via mouse');
        }
      }
    }
    await page.waitForTimeout(5000);
    await ss(page, 'after_click_attempt');

    // If still not open, try clicking the row via JS dispatchEvent
    if (!(await tryOpen())) {
      console.log('  Retrying click via JS dispatchEvent on A.row');
      await page.evaluate(() => {
        const rows = document.querySelectorAll('a.row');
        for (const row of rows) {
          if ((row as HTMLElement).innerText?.includes('CardZip') || (row as HTMLElement).innerText?.includes('cardzip')) {
            // Simulate full click sequence
            const rect = row.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            for (const evtType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              row.dispatchEvent(new PointerEvent(evtType, { bubbles: true, clientX: x, clientY: y }));
            }
            return;
          }
        }
      });
      await page.waitForTimeout(5000);
      await ss(page, 'after_js_click');
    }

    // If we're on bot profile — look for "Send Message" button
    if (!(await tryOpen())) {
      const sendMsgBtn = page.locator('button:has-text("Send Message"), button:has-text("Написать")').first();
      if (await sendMsgBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await sendMsgBtn.click();
        console.log('  Clicked "Send Message" in profile');
        await page.waitForTimeout(4000);
      }
    }
  }

  await ss(page, 'bot_after_search');

  // START button for first-time bot
  const startBtn = page.locator('.chat-input-control .btn-primary, button:has-text("START"), button:has-text("НАЧАТЬ")').first();
  if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await startBtn.click({ force: true });
    console.log('  ✅ Clicked START');
    await page.waitForTimeout(5000);
    await ss(page, 'after_start');
  }

  if (!(await tryOpen())) {
    log('bot_open_fail', 'Could not open bot chat');
  } else {
    // Only clear old screenshots after successful bot open
    for (const f of fs.readdirSync(SCREENSHOTS_DIR)) {
      if (f.endsWith('.png')) fs.unlinkSync(path.join(SCREENSHOTS_DIR, f));
    }
    ssIdx = 0;
    console.log('  🧹 Cleared old screenshots');
  }
}

async function scenario1_welcome(page: Page) {
  console.log('\n══════ SCENARIO 1: ПЕРВЫЙ ВХОД ══════');
  log('s1_start');

  const existingMsgs = await page.evaluate(() => document.querySelectorAll('.bubble:not(.is-out)').length);
  if (existingMsgs === 0) {
    await sendMsg(page, '/start');
    await waitForBotResponse(page, 10_000);
  } else {
    console.log('  Bot already responded (START clicked earlier)');
  }

  await scrollToBottom(page);
  await ss(page, 's1_welcome');
  await collectAllBotMessages(page);
  log('s1_done');
}

async function scenario2_analysis(page: Page) {
  console.log('\n══════ SCENARIO 2: АНАЛИЗ ТОВАРА ══════');
  log('s2_start', `Link: ${TEST_LINK}`);

  // Remember bubble count BEFORE sending
  const beforeCount = await getBubbleCount(page);
  console.log(`  Bubbles before: ${beforeCount}`);

  await sendMsg(page, TEST_LINK);
  await ss(page, 's2_link_sent');

  // Wait for analysis to complete (detect NEW bubbles with buttons)
  const complete = await waitForAnalysis(page, beforeCount, 180_000);
  await scrollToBottom(page);
  await ss(page, 's2_done');

  if (!complete) {
    log('s2_timeout', 'Analysis timed out');
  }

  await collectAllBotMessages(page);

  // List buttons
  const btns = await getInlineButtons(page);
  console.log(`  Buttons: ${btns.join(' | ')}`);
  log('s2_done', `Buttons: ${btns.join(', ')}`);
}

async function scenario3_buttons(page: Page) {
  console.log('\n══════ SCENARIO 3: КНОПКИ ОТЧЁТА ══════');

  // ── 3.1 Данные 1688 ──
  log('s3_1688');
  await clickInlineButton(page, 'Данные 1688');
  await waitForBotResponse(page, 12_000);
  await scrollToBottom(page);
  await ss(page, 's3_1688_data');
  const t1688 = await getLastIncomingText(page);
  rawMessages.push({ from: 'bot', text: t1688, ts: new Date().toISOString() });
  console.log(`  1688: ${t1688.substring(0, 100)}`);
  await clickBackIfExists(page);

  // ── 3.2 WB-рынок ──
  log('s3_wb');
  await clickInlineButton(page, 'WB-рынок');
  await waitForBotResponse(page, 12_000);
  await scrollToBottom(page);
  await ss(page, 's3_wb_market');
  const tWb = await getLastIncomingText(page);
  rawMessages.push({ from: 'bot', text: tWb, ts: new Date().toISOString() });
  console.log(`  WB: ${tWb.substring(0, 100)}`);
  await clickBackIfExists(page);

  // ── 3.3 Экономика ──
  log('s3_econ');
  await clickInlineButton(page, 'Экономика');
  await waitForBotResponse(page, 12_000);
  await scrollToBottom(page);
  await ss(page, 's3_economy');
  const tEcon = await getLastIncomingText(page);
  rawMessages.push({ from: 'bot', text: tEcon, ts: new Date().toISOString() });
  console.log(`  Econ: ${tEcon.substring(0, 100)}`);

  // Check sub-buttons: "Внести ответ поставщика", "Изменить параметры"
  let econBtns = await getInlineButtons(page);
  console.log(`  Econ sub-buttons: ${econBtns.join(' | ')}`);

  // Click "Изменить параметры" if exists to see tariff editing
  const editParams = econBtns.find(b => b.includes('Изменить параметры') || b.includes('Изменить'));
  if (editParams) {
    log('s3_econ_edit_params');
    await clickInlineButton(page, editParams);
    await waitForBotResponse(page, 10_000);
    await scrollToBottom(page);
    await ss(page, 's3_econ_params');
    const tParams = await getLastIncomingText(page);
    rawMessages.push({ from: 'bot', text: tParams, ts: new Date().toISOString() });
    console.log(`  Params: ${tParams.substring(0, 100)}`);
    await clickBackIfExists(page);
  }

  await clickBackIfExists(page);

  // ── 3.4 Поставщику ──
  log('s3_supplier');
  await clickInlineButton(page, 'Поставщику');
  await waitForBotResponse(page, 12_000);
  await scrollToBottom(page);
  await ss(page, 's3_supplier');
  const tSupp = await getLastIncomingText(page);
  rawMessages.push({ from: 'bot', text: tSupp, ts: new Date().toISOString() });
  console.log(`  Supplier: ${tSupp.substring(0, 100)}`);

  // Click "На русском"
  let suppBtns = await getInlineButtons(page);
  if (suppBtns.find(b => b.includes('На русском'))) {
    log('s3_supplier_ru');
    await clickInlineButton(page, 'На русском');
    await waitForBotResponse(page, 12_000);
    await scrollToBottom(page);
    await page.waitForTimeout(2000);
    await ss(page, 's3_supplier_ru');
    const tRu = await getLastIncomingText(page);
    rawMessages.push({ from: 'bot', text: tRu, ts: new Date().toISOString() });
    console.log(`  RU questions: ${tRu.substring(0, 100)}`);
  }

  // Go back and click "На китайском"
  await clickBackIfExists(page);
  // Re-open supplier section
  suppBtns = await getInlineButtons(page);
  if (suppBtns.find(b => b.includes('Поставщику'))) {
    await clickInlineButton(page, 'Поставщику');
    await waitForBotResponse(page, 10_000);
    await scrollToBottom(page);
  }
  suppBtns = await getInlineButtons(page);
  if (suppBtns.find(b => b.includes('На китайском'))) {
    log('s3_supplier_cn');
    await clickInlineButton(page, 'На китайском');
    await waitForBotResponse(page, 12_000);
    await scrollToBottom(page);
    await page.waitForTimeout(2000);
    await ss(page, 's3_supplier_cn');
    const tCn = await getLastIncomingText(page);
    rawMessages.push({ from: 'bot', text: tCn, ts: new Date().toISOString() });
    console.log(`  CN questions: ${tCn.substring(0, 100)}`);
  }

  await clickBackIfExists(page);

  // ── 3.5 Файлы ──
  log('s3_files');
  await clickInlineButton(page, 'Файлы');
  await waitForBotResponse(page, 15_000);
  await scrollToBottom(page);
  await page.waitForTimeout(3000);
  await ss(page, 's3_files');
  const tFiles = await getLastIncomingText(page);
  rawMessages.push({ from: 'bot', text: tFiles, ts: new Date().toISOString() });
  console.log(`  Files: ${tFiles.substring(0, 100)}`);

  // Wait extra for file delivery (ZIP, MD)
  await page.waitForTimeout(5000);
  await scrollToBottom(page);
  await ss(page, 's3_files_delivered');

  // Try to open/download MD documents
  await openDocuments(page);
}

async function openDocuments(page: Page) {
  console.log('\n══════ SCENARIO 4: MD ДОКУМЕНТЫ ══════');
  log('s4_docs_start');

  await scrollToBottom(page);
  await page.waitForTimeout(2000);

  // Find unique MD file names
  const mdFileNames = await page.evaluate(() => {
    const names = new Set<string>();
    document.querySelectorAll('.document-name').forEach(el => {
      const name = (el as HTMLElement).innerText?.trim() || '';
      if (name.endsWith('.md')) names.add(name);
    });
    return [...names];
  });

  console.log(`  MD files found: ${mdFileNames.join(', ')}`);

  for (const fileName of mdFileNames) {
    log(`s4_download_${fileName}`);

    // Set up download listener before clicking
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);

    // Click the LAST occurrence of this file (most recent message)
    await page.evaluate((name: string) => {
      const nameEls = document.querySelectorAll('.document-name');
      let lastMatch: Element | null = null;
      nameEls.forEach(el => {
        if ((el as HTMLElement).innerText?.trim() === name) lastMatch = el;
      });
      if (lastMatch) {
        const docEl = (lastMatch as HTMLElement).closest('.document, .document-wrapper, .media-container') || (lastMatch as HTMLElement).parentElement;
        if (docEl) (docEl as HTMLElement).click();
      }
    }, fileName);

    const download = await downloadPromise;

    if (download) {
      // Save the downloaded file
      const savePath = path.join(SCREENSHOTS_DIR, fileName);
      await download.saveAs(savePath);
      console.log(`  📥 Downloaded: ${fileName}`);

      // Read the MD content
      const content = fs.readFileSync(savePath, 'utf-8');
      rawMessages.push({ from: 'bot', text: `[FILE: ${fileName}]\n${content}`, ts: new Date().toISOString() });

      // Log first 200 chars
      console.log(`  📄 ${fileName} content (${content.length} chars):`);
      console.log(`     ${content.substring(0, 200).replace(/\n/g, '\n     ')}...`);

      // Open the file in a new tab to screenshot the raw markdown
      const newPage = await page.context().newPage();
      await newPage.setContent(`
        <html><body style="background:#1a1a2e;color:#e0e0e0;font-family:monospace;padding:20px;white-space:pre-wrap;font-size:13px;max-width:800px;margin:0 auto;">
        <h2 style="color:#64b5f6;">${fileName}</h2>
        <hr style="border-color:#333;">
        ${content.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}
        </body></html>
      `);
      await newPage.waitForTimeout(500);
      await newPage.screenshot({ path: path.join(SCREENSHOTS_DIR, `${String(++ssIdx).padStart(2, '0')}_doc_${fileName.replace('.md', '')}.png`), fullPage: true });
      console.log(`  📸 ${String(ssIdx).padStart(2, '0')}_doc_${fileName.replace('.md', '')}.png`);

      // Scroll if content is long — take another screenshot of the bottom
      const pageHeight = await newPage.evaluate(() => document.body.scrollHeight);
      if (pageHeight > 900) {
        await newPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await newPage.waitForTimeout(300);
        await newPage.screenshot({ path: path.join(SCREENSHOTS_DIR, `${String(++ssIdx).padStart(2, '0')}_doc_${fileName.replace('.md', '')}_bottom.png`) });
        console.log(`  📸 ${String(ssIdx).padStart(2, '0')}_doc_${fileName.replace('.md', '')}_bottom.png`);
      }

      await newPage.close();
    } else {
      console.log(`  ⚠️ No download triggered for ${fileName}`);
      // Maybe it opened inline — take a screenshot anyway
      await page.waitForTimeout(3000);
      await ss(page, `s4_${fileName.replace('.md', '')}_no_download`);
    }

    await page.waitForTimeout(1000);
  }

  log('s4_docs_done');
}

async function scenario5_last(page: Page) {
  console.log('\n══════ SCENARIO 5: /last ══════');
  log('s5_last');

  await sendMsg(page, '/last');
  await waitForBotResponse(page, 10_000);
  await scrollToBottom(page);
  await ss(page, 's5_last');

  const lastText = await getLastIncomingText(page);
  rawMessages.push({ from: 'bot', text: lastText, ts: new Date().toISOString() });
  console.log(`  /last: ${lastText.substring(0, 100)}`);
  log('s5_done');
}

// ── Main ──

async function main() {
  console.log('🚀 CardZip UX Tester v3\n');

  // Don't clear screenshots until we confirm bot chat is open
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  // Use isolated temp profile to avoid conflicts with running Chromium
  const tempProfileDir = path.join(
    process.env.LOCALAPPDATA || 'C:\\Users\\Sergio\\AppData\\Local',
    'Temp', 'cardzip-ux-test-profile'
  );
  if (!fs.existsSync(tempProfileDir)) fs.mkdirSync(tempProfileDir, { recursive: true });

  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(tempProfileDir, {
      headless: false,
      viewport: { width: 1400, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      acceptDownloads: true,
    });

    const page = context.pages()[0] || await context.newPage();

    log('nav', 'Opening Telegram Web');
    await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(5000);
    await ss(page, 'telegram_loaded');

    // Auth
    const isLoggedIn = await page.evaluate(() =>
      !!document.querySelector('.chatlist-chat, .folders-tabs, .chat-list')
    );
    if (!isLoggedIn) {
      log('auth', 'NOT LOGGED IN');
      await ss(page, 'login_qr');
      console.log('\n⚠️  Отсканируй QR. Ждём 120с...\n');
      const t0 = Date.now();
      while (Date.now() - t0 < 120_000) {
        await page.waitForTimeout(3000);
        if (await page.evaluate(() => !!document.querySelector('.chatlist-chat, .folders-tabs'))) {
          console.log('✅ Авторизован!'); break;
        }
      }
      await page.waitForTimeout(3000);
    }
    log('auth_ok');

    await openBot(page);
    await scenario1_welcome(page);
    await scenario2_analysis(page);
    await scenario3_buttons(page);
    await scenario5_last(page);

    // Final full-chat screenshot
    await scrollToBottom(page);
    await ss(page, 'final');

    console.log('\n✅ All scenarios completed!');
    log('all_done');

  } catch (err: any) {
    log('fatal_error', err.message);
    console.error('Fatal:', err.message);
  } finally {
    fs.writeFileSync(path.join(__dirname, 'raw_messages.json'), JSON.stringify(rawMessages, null, 2));
    fs.writeFileSync(path.join(__dirname, 'action_log.json'), JSON.stringify(actionLog, null, 2));
    console.log('\n📄 Saved raw_messages.json + action_log.json');
    if (context) await context.close().catch(() => {});
  }
}

main();
