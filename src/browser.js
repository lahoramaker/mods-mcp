// browser.js — Playwright browser lifecycle and page interaction

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

let browserInstance = null;
let page = null;
let downloads = [];

export async function launch(modsUrl, headless = false) {
  browserInstance = await chromium.launch({ headless, channel: 'chrome' });
  const context = await browserInstance.newContext({ acceptDownloads: true });
  page = await context.newPage();

  // Intercept downloads
  page.on('download', async (download) => {
    const path = await download.path();
    const content = path ? await readFile(path) : null;
    downloads.push({
      suggestedFilename: download.suggestedFilename(),
      content,
      timestamp: Date.now()
    });
  });

  await page.goto(modsUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.mods_prog_load === 'function', { timeout: 15000 });

  return page;
}

export async function loadProgram(modsUrl, programPath, srcUrl) {
  if (!page) throw new Error('Browser not launched');
  const encodedPath = programPath.split('/').map(encodeURIComponent).join('/');
  let url = `${modsUrl}/?program=${encodedPath}`;
  if (srcUrl) url += `&src=${encodeURIComponent(srcUrl)}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.mods_prog_load === 'function', { timeout: 15000 });
  await page.waitForFunction(() => {
    const modules = document.getElementById('modules');
    return modules && modules.childNodes.length > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(srcUrl ? 2000 : 500);
}

export async function postMessageFile(filePath) {
  if (!page) throw new Error('Browser not launched');
  const ext = extname(filePath).toLowerCase();
  const fileData = await readFile(filePath);

  if (ext !== '.png' && ext !== '.svg') {
    return { error: `postMessage not supported for ${ext} files. Use setModuleFile for this type.` };
  }

  // Combine listener setup + postMessage in a single evaluate to avoid race conditions
  const msgType = ext === '.png' ? 'png' : 'svg';
  const payload = ext === '.png' ? fileData.toString('base64') : fileData.toString('utf-8');
  const ack = await page.evaluate(({ type, data }) => {
    return new Promise(resolve => {
      const handler = (e) => {
        if (e.data === 'ready') {
          window.removeEventListener('message', handler);
          resolve(true);
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => { window.removeEventListener('message', handler); resolve(false); }, 5000);
      window.postMessage({ type, data }, '*');
    });
  }, { type: msgType, data: payload });

  return { success: true, file: filePath, method: 'postMessage', acknowledged: ack };
}

export async function setModuleFile(moduleId, filePath) {
  if (!page) throw new Error('Browser not launched');
  const input = page.locator(`[id="${moduleId}"] input[type="file"]`);
  const count = await input.count();
  if (count === 0) {
    return { error: `No file input found in module ${moduleId}` };
  }
  await input.setInputFiles(filePath);
  await page.waitForTimeout(2000);
  return { success: true, file: filePath, method: 'fileInput' };
}

export async function getProgramState() {
  if (!page) throw new Error('Browser not launched');
  return page.evaluate(() => {
    const modulesContainer = document.getElementById('modules');
    if (!modulesContainer) return [];

    const connections = {};
    const svg = document.getElementById('svg');
    if (svg) {
      const linksGroup = svg.getElementById('links');
      if (linksGroup) {
        for (let l = 0; l < linksGroup.childNodes.length; l++) {
          const link = linksGroup.childNodes[l];
          if (!link.id) continue;
          try {
            const linkData = JSON.parse(link.id);
            const source = JSON.parse(linkData.source);
            const dest = JSON.parse(linkData.dest);
            if (!connections[source.id]) connections[source.id] = { inputs: [], outputs: [] };
            if (!connections[dest.id]) connections[dest.id] = { inputs: [], outputs: [] };
            const srcMod = document.getElementById(source.id);
            const destMod = document.getElementById(dest.id);
            const srcName = srcMod ? srcMod.dataset.name : source.id;
            const destName = destMod ? destMod.dataset.name : dest.id;
            connections[source.id].outputs.push({ to: destName, toId: dest.id, port: source.name + ' → ' + dest.name });
            connections[dest.id].inputs.push({ from: srcName, fromId: source.id, port: source.name + ' → ' + dest.name });
          } catch { /* skip */ }
        }
      }
    }

    const result = [];
    for (let c = 0; c < modulesContainer.childNodes.length; c++) {
      const mod = modulesContainer.childNodes[c];
      const id = mod.id;
      if (!id) continue;
      const name = mod.dataset.name || '';
      const params = [];
      for (const input of mod.querySelectorAll('input')) {
        let label = '';
        const prev = input.previousSibling;
        if (prev && prev.textContent) label = prev.textContent.trim();
        if (input.type === 'checkbox') {
          params.push({ label, value: input.checked ? 'true' : 'false', type: 'checkbox' });
        } else {
          params.push({ label, value: input.value, type: input.type });
        }
      }
      const buttons = [];
      for (const btn of mod.querySelectorAll('button')) {
        buttons.push(btn.textContent.trim());
      }
      const entry = { id, name, params, buttons };
      if (connections[id]) {
        entry.connectedFrom = connections[id].inputs;
        entry.connectedTo = connections[id].outputs;
      }
      result.push(entry);
    }
    return result;
  });
}

export async function setModuleInput(moduleId, paramName, value) {
  if (!page) throw new Error('Browser not launched');
  return page.evaluate(({ moduleId, paramName, value }) => {
    const mod = document.getElementById(moduleId);
    if (!mod) return { error: `Module ${moduleId} not found` };
    for (const input of mod.querySelectorAll('input')) {
      const prev = input.previousSibling;
      const label = prev ? prev.textContent.trim() : '';
      if (label.includes(paramName)) {
        if (input.type === 'checkbox') {
          input.checked = (value === 'true' || value === '1' || value === 'on');
          input.dispatchEvent(new Event('change'));
          return { success: true, label, type: 'checkbox', newValue: input.checked };
        } else {
          input.value = value;
          input.dispatchEvent(new Event('change'));
          return { success: true, label, newValue: value };
        }
      }
    }
    return { error: `Parameter "${paramName}" not found in module ${moduleId}` };
  }, { moduleId, paramName, value: String(value) });
}

export async function clickModuleButton(moduleId, buttonText) {
  if (!page) throw new Error('Browser not launched');
  return page.evaluate(({ moduleId, buttonText }) => {
    const mod = document.getElementById(moduleId);
    if (!mod) return { error: `Module ${moduleId} not found` };
    for (const btn of mod.querySelectorAll('button')) {
      if (btn.textContent.trim().toLowerCase().includes(buttonText.toLowerCase())) {
        btn.click();
        return { success: true, clicked: btn.textContent.trim() };
      }
    }
    const available = Array.from(mod.querySelectorAll('button')).map(b => b.textContent.trim());
    return { error: `Button "${buttonText}" not found`, available };
  }, { moduleId, buttonText });
}

export async function injectProgram(programJson) {
  if (!page) throw new Error('Browser not launched');
  await page.evaluate((json) => {
    window.mods_prog_load(JSON.parse(json));
  }, JSON.stringify(programJson));
  await page.waitForFunction(() => {
    const modules = document.getElementById('modules');
    return modules && modules.childNodes.length > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(500);
}

export async function extractProgramState() {
  if (!page) throw new Error('Browser not launched');
  return page.evaluate(() => {
    if (typeof window.mods_build_v2_program === 'function') {
      return window.mods_build_v2_program();
    }
    // Fallback v1 extraction
    const prog = { modules: {}, links: [] };
    const modulesContainer = document.getElementById('modules');
    if (!modulesContainer) return null;
    for (let c = 0; c < modulesContainer.childNodes.length; c++) {
      const mod = modulesContainer.childNodes[c];
      if (!mod.id) continue;
      prog.modules[mod.id] = {
        definition: mod.dataset.definition || '',
        top: mod.dataset.top || '0',
        left: mod.dataset.left || '0',
        filename: mod.dataset.filename || '',
        inputs: {}, outputs: {}
      };
    }
    const svg = document.getElementById('svg');
    if (svg) {
      const links = svg.getElementById('links');
      if (links) {
        for (let l = 0; l < links.childNodes.length; l++) {
          if (links.childNodes[l].id) prog.links.push(links.childNodes[l].id);
        }
      }
    }
    return prog;
  });
}

export function getLatestDownload() {
  return downloads.length > 0 ? downloads[downloads.length - 1] : null;
}

export function clearDownloads() {
  downloads = [];
}

export function getPage() {
  return page;
}

export function isLaunched() {
  return browserInstance !== null && page !== null;
}

export async function close() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    page = null;
  }
}
