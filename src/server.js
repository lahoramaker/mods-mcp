// server.js — MCP server for remote mods CE interaction

import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import vm from 'node:vm';
import * as browser from './browser.js';

// --- CLI ---
const args = process.argv.slice(2);
let modsUrl = 'https://modsproject.org';
let headless = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mods-url' && args[i + 1]) {
    modsUrl = args[i + 1];
    i++;
  }
  if (args[i] === '--headless') headless = true;
}
modsUrl = modsUrl.replace(/\/+$/, '');

// --- Manifest cache ---
let modulesManifest = null;
let programsManifest = null;

async function fetchManifest(type) {
  const url = `${modsUrl}/${type}/index.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function getModulesManifest() {
  if (!modulesManifest) {
    const raw = await fetchManifest('modules');
    modulesManifest = raw.map(m => ({ ...m, path: decodeURIComponent(m.path) }));
  }
  return modulesManifest;
}

async function getProgramsManifest() {
  if (!programsManifest) {
    const raw = await fetchManifest('programs');
    programsManifest = raw.map(p => ({ ...p, path: decodeURIComponent(p.path) }));
  }
  return programsManifest;
}

function groupByCategory(items) {
  const groups = {};
  for (const item of items) {
    const cat = item.category || 'uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }
  return groups;
}

// --- Module parsing (VM sandbox + regex fallback) ---

function extractWithVm(source) {
  const sandbox = {
    document: {
      createElement: () => ({
        style: {}, appendChild: () => {}, addEventListener: () => {},
        setAttribute: () => {}, getContext: () => ({
          canvas: { width: 0, height: 0 }, drawImage: () => {},
          getImageData: () => ({ data: [] }), putImageData: () => {},
          clearRect: () => {}, fillRect: () => {}, beginPath: () => {},
          moveTo: () => {}, lineTo: () => {}, stroke: () => {}, fill: () => {},
          arc: () => {}, closePath: () => {}, scale: () => {}, translate: () => {},
          save: () => {}, restore: () => {}, createImageData: () => ({ data: [] })
        }),
        classList: { add: () => {}, remove: () => {} },
        querySelectorAll: () => [], querySelector: () => null,
        removeChild: () => {}, insertBefore: () => {},
        children: [], childNodes: [], value: '', type: '', checked: false,
        innerHTML: '', textContent: '', createTextNode: () => ({})
      }),
      createTextNode: (t) => ({ textContent: t }),
      createElementNS: () => ({
        style: {}, appendChild: () => {}, setAttribute: () => {},
        addEventListener: () => {}, setAttributeNS: () => {},
        getBBox: () => ({ x: 0, y: 0, width: 0, height: 0 })
      }),
      getElementById: () => null,
      body: { appendChild: () => {}, removeChild: () => {} }
    },
    window: { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 800, innerHeight: 600 },
    mods: { ui: { padding: '5px', canvas: 200, header: 50, xstart: 0, ystart: 0 }, output: () => {}, input: () => {} },
    navigator: { userAgent: '', platform: '' },
    console: { log: () => {}, error: () => {} },
    SVGElement: function() {}, HTMLElement: function() {},
    Event: function() {}, CustomEvent: function() {},
    Blob: function() {}, URL: { createObjectURL: () => '' },
    FileReader: function() { this.readAsArrayBuffer = () => {}; this.readAsText = () => {}; this.onload = null; },
    WebSocket: function() { this.send = () => {}; this.close = () => {}; },
    XMLHttpRequest: function() { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; },
    Image: function() {},
    Worker: function() { this.postMessage = () => {}; this.terminate = () => {}; },
    requestAnimationFrame: () => {}, setTimeout: () => {}, setInterval: () => {},
    clearTimeout: () => {}, clearInterval: () => {},
    parseInt, parseFloat, Math, JSON, Array, Object, String, Number, Boolean,
    RegExp, Date, Error, Map, Set, Promise, isNaN, isFinite,
    undefined, NaN, Infinity, encodeURIComponent, decodeURIComponent
  };
  const context = vm.createContext(sandbox);
  new vm.Script('var __result = ' + source).runInContext(context, { timeout: 1000 });
  return sandbox.__result;
}

function extractWithRegex(source) {
  const nameMatch = source.match(/var\s+name\s*=\s*['"]([^'"]+)['"]/);
  const name = nameMatch ? nameMatch[1] : 'unknown';
  const inputs = {};
  const inputsMatch = source.match(/var\s+inputs\s*=\s*\{([\s\S]*?)\n\s*\}/);
  if (inputsMatch) {
    for (const m of inputsMatch[1].matchAll(/(\w+)\s*:\s*\{[^}]*type\s*:\s*['"]([^'"]*)['"]/g)) {
      inputs[m[1]] = { type: m[2] };
    }
  }
  const outputs = {};
  const outputsMatch = source.match(/var\s+outputs\s*=\s*\{([\s\S]*?)\n\s*\}/);
  if (outputsMatch) {
    for (const m of outputsMatch[1].matchAll(/(\w+)\s*:\s*\{[^}]*type\s*:\s*['"]([^'"]*)['"]/g)) {
      outputs[m[1]] = { type: m[2] };
    }
  }
  return { name, inputs, outputs };
}

async function parseModule(modulePath, includeSource) {
  const url = `${modsUrl}/${modulePath}`;
  const res = await fetch(url);
  if (!res.ok) return { path: modulePath, error: `HTTP ${res.status} fetching ${url}`, parseMethod: 'failed' };
  const source = await res.text();

  let name, inputs, outputs, parseMethod = 'vm';
  try {
    const result = extractWithVm(source);
    name = result.name;
    inputs = {};
    outputs = {};
    if (result.inputs) for (const [k, v] of Object.entries(result.inputs)) inputs[k] = { type: v.type || '' };
    if (result.outputs) for (const [k, v] of Object.entries(result.outputs)) outputs[k] = { type: v.type || '' };
  } catch {
    parseMethod = 'regex';
    try {
      const result = extractWithRegex(source);
      name = result.name;
      inputs = result.inputs;
      outputs = result.outputs;
    } catch (err) {
      return { path: modulePath, error: `Failed to parse: ${err.message}`, parseMethod: 'failed' };
    }
  }

  const info = { name, path: modulePath, inputs, outputs, parseMethod };
  if (includeSource) info.source = source;
  return info;
}

// --- State ---
let loadedProgram = null;

// --- MCP Server ---
const mcpServer = new McpServer({ name: 'mops', version: '0.2.0' });

async function findModule(moduleName, moduleId) {
  const state = await browser.getProgramState();
  if (moduleId) {
    const mod = state.find(m => m.id === moduleId);
    return mod ? { module: mod } : { error: `Module with ID "${moduleId}" not found.` };
  }
  const mod = state.find(m => m.name.toLowerCase().includes(moduleName.toLowerCase()));
  if (!mod) {
    const available = state.map(m => m.name).filter(Boolean);
    return { error: `Module "${moduleName}" not found. Available: ${available.join(', ')}` };
  }
  return { module: mod };
}

function parseModuleNameId(module_name) {
  let name = module_name, id = undefined;
  if (module_name.includes(':0.')) {
    const parts = module_name.split(':');
    name = parts[0];
    id = parts.slice(1).join(':');
  }
  return { name, id };
}

// --- Tools ---

mcpServer.tool('get_server_status', 'Get server health, browser state, mods URL, and loaded program', {},
  async () => {
    const status = {
      server: 'running', modsUrl,
      browser: browser.isLaunched() ? 'connected' : 'not launched',
      loadedProgram: loadedProgram || 'none'
    };
    if (browser.isLaunched() && loadedProgram) {
      try {
        const state = await browser.getProgramState();
        status.moduleCount = state.length;
        status.moduleNames = state.map(m => m.name).filter(Boolean);
      } catch { /* ignore */ }
    }
    return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
  }
);

mcpServer.tool('launch_browser',
  'Launch the Chromium browser and navigate to the mods CE deployment. Must be called before browser-dependent tools.', {},
  async () => {
    if (browser.isLaunched()) return { content: [{ type: 'text', text: `Browser already running at ${modsUrl}` }] };
    try {
      await browser.launch(modsUrl, headless);
      return { content: [{ type: 'text', text: `Browser launched (${headless ? 'headless' : 'headed'}) at ${modsUrl}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Browser launch failed: ${err.message}. Run "npx playwright install chromium" to install browsers.` }], isError: true };
    }
  }
);

mcpServer.tool('list_programs', 'List available Mods programs organized by category',
  { category: z.string().optional().describe('Filter by category (e.g., "machines", "processes", "image")') },
  async ({ category }) => {
    try {
      const manifest = await getProgramsManifest();
      let items = manifest;
      if (category) items = manifest.filter(p => p.category.toLowerCase().includes(category.toLowerCase()));
      return { content: [{ type: 'text', text: JSON.stringify(groupByCategory(items), null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching programs: ${err.message}` }], isError: true };
    }
  }
);

mcpServer.tool('list_modules', 'List available Mods modules organized by category',
  { category: z.string().optional().describe('Filter by category (e.g., "read", "image", "mesh")') },
  async ({ category }) => {
    try {
      const manifest = await getModulesManifest();
      let items = manifest;
      if (category) items = manifest.filter(m => m.category.toLowerCase().includes(category.toLowerCase()));
      return { content: [{ type: 'text', text: JSON.stringify(groupByCategory(items), null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching modules: ${err.message}` }], isError: true };
    }
  }
);

mcpServer.tool('get_module_info',
  'Parse module file(s) and return name, inputs, outputs with types. Accepts a single path or array.',
  {
    path: z.union([z.string(), z.array(z.string())]).describe('Module path(s) (e.g., "modules/read/stl.js" or ["modules/read/svg.js", "modules/read/png.js"])'),
    include_source: z.boolean().optional().default(false).describe('Include full IIFE source in response')
  },
  async ({ path, include_source }) => {
    const paths = Array.isArray(path) ? path : [path];
    const results = await Promise.all(paths.map(p => parseModule(p, include_source)));
    return { content: [{ type: 'text', text: JSON.stringify(results.length === 1 ? results[0] : results, null, 2) }] };
  }
);

mcpServer.tool('load_program',
  'Load a preset program in the browser by path. Optionally preload a file into the matching reader module via src URL.',
  {
    path: z.string().describe('Program path (e.g., "programs/machines/Roland/SRM-20 mill/mill 2D PCB")'),
    src: z.string().optional().describe('URL of a file to auto-load into the matching reader module (matched by extension)')
  },
  async ({ path, src }) => {
    if (!browser.isLaunched()) return { content: [{ type: 'text', text: 'Error: Browser not launched. Use launch_browser first.' }], isError: true };
    await browser.loadProgram(modsUrl, path, src);
    loadedProgram = path;
    const state = await browser.getProgramState();
    const result = { loaded: path, modules: state.map(m => ({ id: m.id, name: m.name, paramCount: m.params.length, buttons: m.buttons })) };
    if (src) result.src = src;
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool('get_program_state', 'Get current state of all modules in the loaded program', {},
  async () => {
    if (!browser.isLaunched()) return { content: [{ type: 'text', text: 'Error: Browser not launched.' }], isError: true };
    if (!loadedProgram) return { content: [{ type: 'text', text: 'Error: No program loaded. Use load_program first.' }], isError: true };
    const state = await browser.getProgramState();
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
  }
);

mcpServer.tool('set_parameter', 'Set a parameter value in a specific module',
  {
    module_name: z.string().describe('Module name (or partial match, or name:id for disambiguation)'),
    parameter: z.string().describe('Parameter label (or partial match)'),
    value: z.string().describe('New value to set')
  },
  async ({ module_name, parameter, value }) => {
    if (!browser.isLaunched()) return { content: [{ type: 'text', text: 'Error: Browser not launched.' }], isError: true };
    const { name, id } = parseModuleNameId(module_name);
    const found = await findModule(name, id);
    if (found.error) return { content: [{ type: 'text', text: found.error }], isError: true };
    const result = await browser.setModuleInput(found.module.id, parameter, value);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool('trigger_action', 'Click a button in a module (calculate, view, export, etc.)',
  {
    module_name: z.string().describe('Module name (or partial match, or name:id for disambiguation)'),
    action: z.string().describe('Button text to click (or partial match)')
  },
  async ({ module_name, action }) => {
    if (!browser.isLaunched()) return { content: [{ type: 'text', text: 'Error: Browser not launched.' }], isError: true };
    browser.clearDownloads();
    const { name, id } = parseModuleNameId(module_name);
    const found = await findModule(name, id);
    if (found.error) return { content: [{ type: 'text', text: found.error }], isError: true };
    const result = await browser.clickModuleButton(found.module.id, action);
    await new Promise(r => setTimeout(r, 2000));
    const download = browser.getLatestDownload();
    if (download) result.download = { filename: download.suggestedFilename, size: download.content ? download.content.length : 0 };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool('load_file',
  'Load a file into the matching reader module. Uses postMessage for SVG/PNG, file input for other types.',
  {
    module_name: z.string().describe('Module name (or partial match, or name:id for disambiguation)'),
    file_path: z.string().describe('Absolute path to the file to load')
  },
  async ({ module_name, file_path }) => {
    if (!browser.isLaunched()) return { content: [{ type: 'text', text: 'Error: Browser not launched.' }], isError: true };
    try { await stat(file_path); } catch {
      return { content: [{ type: 'text', text: `Error: File not found: ${file_path}` }], isError: true };
    }
    const ext = extname(file_path).toLowerCase();
    if (ext === '.svg' || ext === '.png') {
      const result = await browser.postMessageFile(file_path);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    const { name, id } = parseModuleNameId(module_name);
    const found = await findModule(name, id);
    if (found.error) return { content: [{ type: 'text', text: found.error }], isError: true };
    const result = await browser.setModuleFile(found.module.id, file_path);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool('export_file', 'Get the most recently downloaded/exported file from Mods', {},
  async () => {
    const download = browser.getLatestDownload();
    if (!download) return { content: [{ type: 'text', text: 'No file exported yet. Use trigger_action first.' }], isError: true };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          filename: download.suggestedFilename,
          size: download.content ? download.content.length : 0,
          content: download.content ? download.content.toString('utf-8').slice(0, 10000) : null
        }, null, 2)
      }]
    };
  }
);

mcpServer.tool('create_program', 'Build a new v2 program from modules and connections, load in browser',
  {
    modules: z.array(z.string()).describe('Module paths (e.g., ["modules/read/svg.js", "modules/mesh/rotate.js"])'),
    links: z.array(z.object({
      from: z.string().describe('Source: "moduleName.outputPort"'),
      to: z.string().describe('Destination: "moduleName.inputPort"')
    })).describe('Connections between modules')
  },
  async ({ modules: modulePaths, links }) => {
    if (!browser.isLaunched()) return { content: [{ type: 'text', text: 'Error: Browser not launched.' }], isError: true };
    try {
      const mods = {};
      const nameToId = {};
      let x = 100;
      for (const modPath of modulePaths) {
        const id = Math.random().toString();
        mods[id] = { module: modPath, top: '100', left: String(x), params: {} };
        x += 300;
        const res = await fetch(`${modsUrl}/${modPath}`);
        if (res.ok) {
          const source = await res.text();
          const nameMatch = source.match(/var\s+name\s*=\s*['"]([^'"]+)['"]/);
          if (nameMatch) nameToId[nameMatch[1]] = id;
        }
      }
      const programLinks = [];
      for (const link of links) {
        const [fromModule, fromPort] = link.from.split('.');
        const [toModule, toPort] = link.to.split('.');
        const sourceId = nameToId[fromModule];
        const destId = nameToId[toModule];
        if (!sourceId || !destId) throw new Error(`Module not found in link: ${!sourceId ? fromModule : toModule}`);
        programLinks.push(JSON.stringify({
          source: JSON.stringify({ id: sourceId, type: 'outputs', name: fromPort }),
          dest: JSON.stringify({ id: destId, type: 'inputs', name: toPort })
        }));
      }
      const prog = { version: 2, modules: mods, links: programLinks };
      await browser.injectProgram(prog);
      loadedProgram = 'custom (created)';
      const state = await browser.getProgramState();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            created: true, moduleCount: Object.keys(mods).length,
            linkCount: programLinks.length, modules: state.map(m => ({ id: m.id, name: m.name }))
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error creating program: ${err.message}` }], isError: true };
    }
  }
);

mcpServer.tool('save_program', 'Extract the current program state as v2 JSON', {},
  async () => {
    if (!browser.isLaunched()) return { content: [{ type: 'text', text: 'Error: Browser not launched.' }], isError: true };
    const programState = await browser.extractProgramState();
    if (!programState) return { content: [{ type: 'text', text: 'Error: Could not extract program state.' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(programState, null, 2) }] };
  }
);

// --- Startup ---
async function start() {
  try {
    await getModulesManifest();
    console.error(`[mops] Connected to ${modsUrl} (${modulesManifest.length} modules)`);
  } catch (err) {
    console.error(`[mops] Error: Cannot reach mods at ${modsUrl}: ${err.message}`);
    process.exit(1);
  }

  console.error(`[mops] Browser will launch on demand (use launch_browser tool)`);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error('[mops] MCP server running on stdio');
}

async function cleanup() {
  console.error('[mops] Shutting down...');
  await browser.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

start().catch(err => {
  console.error(`[mops] Fatal error: ${err.message}`);
  process.exit(1);
});
