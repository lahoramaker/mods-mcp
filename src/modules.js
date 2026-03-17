// modules.js — Module introspection and IIFE I/O type extraction

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import vm from 'node:vm';

let MODS_DIR;
let MODULES_DIR;

export function init(modsDir) {
  MODS_DIR = modsDir;
  MODULES_DIR = join(modsDir, 'modules');
}

async function scanModules(dir, base) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = await scanModules(fullPath, base);
      results.push({
        name: entry.name,
        type: 'category',
        children
      });
    } else if (entry.name.endsWith('.js') && entry.name !== 'index.js') {
      const relPath = relative(base, fullPath);
      results.push({
        name: entry.name.replace('.js', ''),
        type: 'module',
        path: relPath
      });
    }
  }
  return results;
}

export async function listModules(category) {
  let scanRoot = MODULES_DIR;
  if (category) {
    scanRoot = join(MODULES_DIR, category);
  }
  return scanModules(scanRoot, MODS_DIR);
}

function extractWithVm(source) {
  // Create a minimal DOM mock for modules that reference document/mods
  const sandbox = {
    document: {
      createElement: () => ({
        style: {},
        appendChild: () => {},
        addEventListener: () => {},
        setAttribute: () => {},
        getContext: () => ({
          canvas: { width: 0, height: 0 },
          drawImage: () => {},
          getImageData: () => ({ data: [] }),
          putImageData: () => {},
          clearRect: () => {},
          fillRect: () => {},
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => {},
          fill: () => {},
          arc: () => {},
          closePath: () => {},
          scale: () => {},
          translate: () => {},
          save: () => {},
          restore: () => {},
          createImageData: () => ({ data: [] })
        }),
        classList: { add: () => {}, remove: () => {} },
        querySelectorAll: () => [],
        querySelector: () => null,
        removeChild: () => {},
        insertBefore: () => {},
        children: [],
        childNodes: [],
        value: '',
        type: '',
        checked: false,
        innerHTML: '',
        textContent: '',
        createTextNode: () => ({})
      }),
      createTextNode: (t) => ({ textContent: t }),
      createElementNS: () => ({
        style: {},
        appendChild: () => {},
        setAttribute: () => {},
        addEventListener: () => {},
        setAttributeNS: () => {},
        getBBox: () => ({ x: 0, y: 0, width: 0, height: 0 })
      }),
      getElementById: () => null,
      body: { appendChild: () => {}, removeChild: () => {} }
    },
    window: { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 800, innerHeight: 600 },
    mods: {
      ui: { padding: '5px', canvas: 200, header: 50, xstart: 0, ystart: 0 },
      output: () => {},
      input: () => {}
    },
    navigator: { userAgent: '', platform: '' },
    console: { log: () => {}, error: () => {} },
    SVGElement: function() {},
    HTMLElement: function() {},
    Event: function() {},
    CustomEvent: function() {},
    Blob: function() {},
    URL: { createObjectURL: () => '' },
    FileReader: function() { this.readAsArrayBuffer = () => {}; this.readAsText = () => {}; this.onload = null; },
    WebSocket: function() { this.send = () => {}; this.close = () => {}; },
    XMLHttpRequest: function() { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; },
    Image: function() {},
    Worker: function() { this.postMessage = () => {}; this.terminate = () => {}; },
    requestAnimationFrame: () => {},
    setTimeout: () => {},
    setInterval: () => {},
    clearTimeout: () => {},
    clearInterval: () => {},
    parseInt,
    parseFloat,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Date,
    Error,
    Map,
    Set,
    Promise,
    isNaN,
    isFinite,
    undefined,
    NaN,
    Infinity,
    encodeURIComponent,
    decodeURIComponent
  };

  const context = vm.createContext(sandbox);
  const script = new vm.Script('var __result = ' + source);
  script.runInContext(context, { timeout: 1000 });
  return sandbox.__result;
}

function extractWithRegex(source) {
  const nameMatch = source.match(/var\s+name\s*=\s*['"]([^'"]+)['"]/);
  const name = nameMatch ? nameMatch[1] : 'unknown';

  // Extract inputs block
  const inputs = {};
  const inputsMatch = source.match(/var\s+inputs\s*=\s*\{([\s\S]*?)\n\s*\}/);
  if (inputsMatch) {
    const typeMatches = inputsMatch[1].matchAll(/(\w+)\s*:\s*\{[^}]*type\s*:\s*['"]([^'"]*)['"]/g);
    for (const m of typeMatches) {
      inputs[m[1]] = { type: m[2] };
    }
  }

  // Extract outputs block
  const outputs = {};
  const outputsMatch = source.match(/var\s+outputs\s*=\s*\{([\s\S]*?)\n\s*\}/);
  if (outputsMatch) {
    const typeMatches = outputsMatch[1].matchAll(/(\w+)\s*:\s*\{[^}]*type\s*:\s*['"]([^'"]*)['"]/g);
    for (const m of typeMatches) {
      outputs[m[1]] = { type: m[2] };
    }
  }

  return { name, inputs, outputs };
}

export async function getModuleInfo(modulePath, includeSource) {
  const fullPath = join(MODS_DIR, modulePath);
  const source = await readFile(fullPath, 'utf-8');

  let name, inputs, outputs;
  let parseMethod = 'vm';

  try {
    const result = extractWithVm(source);
    name = result.name;
    inputs = {};
    outputs = {};
    if (result.inputs) {
      for (const [k, v] of Object.entries(result.inputs)) {
        inputs[k] = { type: v.type || '' };
      }
    }
    if (result.outputs) {
      for (const [k, v] of Object.entries(result.outputs)) {
        outputs[k] = { type: v.type || '' };
      }
    }
  } catch {
    // Fall back to regex
    parseMethod = 'regex';
    try {
      const result = extractWithRegex(source);
      name = result.name;
      inputs = result.inputs;
      outputs = result.outputs;
    } catch (regexErr) {
      return {
        path: modulePath,
        error: `Failed to parse module: ${regexErr.message}`,
        parseMethod: 'failed'
      };
    }
  }

  const info = { name, path: modulePath, inputs, outputs, parseMethod };
  if (includeSource) {
    info.source = source;
  }
  return info;
}
