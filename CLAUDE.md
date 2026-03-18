# MOPS — Machines Obeying Prompt Suggestions

MCP server bridging LLMs to the Mods CE digital fabrication platform.

## Mods Platform Internals

Mods CE is a browser-based visual programming environment for digital fabrication (CNC milling, 3D printing, laser cutting, etc.). Key internals:

### Module Format (IIFE)

Modules are **Immediately Invoked Function Expressions** (IIFEs) stored as `.js` files. Each IIFE returns an object:

```js
({
  mod,        // module metadata
  name,       // display name
  init,       // initialization function
  inputs,     // input port definitions (name → handler)
  outputs,    // output port definitions (name → type)
  interface   // UI interface builder function
})
```

I/O types are defined **inside** the IIFE source, not extractable by simple regex — the module must be evaluated to inspect its inputs and outputs.

### Program JSON Structure

Programs are JSON files. v2 format (current):

- **Modules** are keyed by **random float IDs** generated via `Math.random()` (e.g., `"0.7432891654"`)
- Each module entry has a `module` field referencing the source file path (e.g., `"modules/read/svg.js"`) — the browser fetches the source on demand
- **Links** (connections between modules) are stored as **double-stringified JSON**
- v1 programs (legacy) inline the full IIFE source in a `definition` field

### On/Off Switch Gating Pattern

Machine programs use **on/off switch modules as gates** to control data flow at the end of the pipeline. This is a common pattern across many (possibly all) machine workflows:

- One on/off switch gates the path to **WebUSB / serial output** (sends to machine) — **default ON**
- Another on/off switch gates the path to **save file** (saves toolpath to disk) — **default OFF**

**To save output to file instead of sending to machine**, you must:
1. Find the on/off switch connected to the `save file` module and toggle it **ON**
2. Optionally toggle the machine output on/off switch **OFF** (to avoid sending to a machine)

**To toggle an on/off switch via automation:**
- Find the module named `on/off` (there may be multiple — identify by what it connects to)
- Use `set_parameter` or `trigger_action` MCP tools to toggle the switch

This pattern applies to programs under `programs/machines/` including Roland SRM-20 mill, Epilog laser, Prusa 3D printer, and others.

## Architecture

The MCP server connects to a remote mods CE deployment (default: `https://modsproject.org`) via Playwright. No local HTTP server or filesystem scanning.

### Source Files

| File | Responsibility |
|------|---------------|
| `src/server.js` | MCP server, tool definitions, manifest fetching, module parsing (VM sandbox) |
| `src/browser.js` | Playwright browser lifecycle, page interaction, postMessage file injection |

### MCP Tools

| Tool | Description |
|------|-------------|
| `get_server_status` | Server health, browser state, mods URL, loaded program info |
| `launch_browser` | Launch browser and navigate to the mods CE deployment |
| `list_programs` | List available programs from remote manifest |
| `list_modules` | List available modules from remote manifest |
| `get_module_info` | Parse module file(s) to extract name, inputs, outputs with types |
| `load_program` | Load a program in the browser, optionally preload a file via src URL |
| `get_program_state` | Get all modules, parameters, and buttons in the loaded program |
| `set_parameter` | Set a parameter value on a module by name |
| `trigger_action` | Click a button in a module (calculate, export, etc.) |
| `load_file` | Load a file into a reader module (postMessage for SVG/PNG, file input for others) |
| `create_program` | Build a new v2 program from module paths and connections |
| `save_program` | Extract current program state as v2 JSON |
| `export_file` | Get the most recently downloaded/exported file |

## Development Setup

```bash
# Clone the repository
git clone <repo-url>
cd mods-mcp

# Install dependencies
npm install

# Install Playwright browsers
npm run setup

# Run the server (connects to modsproject.org by default)
npm start

# Or specify a custom mods URL
node src/server.js --mods-url https://localhost:8081 --headless
```

### Prerequisites

- Node.js >= 18.0.0
- Internet connection (or a local mods CE dev server)

### Project Structure

```
mods-mcp/
├── src/
│   ├── server.js      # MCP server and tools
│   └── browser.js     # Playwright browser automation
├── package.json
├── CLAUDE.md          # This file
└── .gitignore
```

## Claude Desktop Configuration

Add to your Claude Desktop MCP settings (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "mods": {
      "command": "node",
      "args": ["/absolute/path/to/mods-mcp/src/server.js"]
    }
  }
}
```

Optional flags via args:
- `"--mods-url", "https://localhost:8081"` — connect to a different mods CE deployment (default: `https://modsproject.org`)
- `"--headless"` — run browser in headless mode (no visible window)

Example with all flags:
```json
{
  "mcpServers": {
    "mods": {
      "command": "node",
      "args": ["/absolute/path/to/mods-mcp/src/server.js", "--mods-url", "https://localhost:8081", "--headless"]
    }
  }
}
```

### Important Notes

- `mods` is a local variable inside the mods.js IIFE closure, NOT a global. Use `window.mods_prog_load()` to inject programs.
- Module names in the DOM are stored in `element.dataset.name`, not as child elements with a `.name` class.
- Module containers are children of `document.getElementById('modules')`.
- Port element IDs are JSON-stringified objects: `{"id":"0.xxx","type":"inputs","name":"portName"}`.
- Links in program JSON are double-stringified: the array contains JSON strings that eval to objects with `source`/`dest` fields, each of which is itself a JSON string that evals to `{id, type, name}`.
- **Checkbox values**: HTML checkbox `.value` is always `"on"` regardless of checked state. Always use `.checked` (boolean) to read/write checkbox state. This is critical for on/off switch modules.
- **Duplicate module names**: When multiple modules share a name (e.g., two `on/off` switches), use `module_name:module_id` syntax in `set_parameter` and `trigger_action` (e.g., `on/off:0.44105604671305754`). Use `get_program_state` to find IDs — it includes `connectedTo`/`connectedFrom` fields to identify which module connects where.
- **File injection**: SVG and PNG files are injected via postMessage API (no file input needed). Other file types (STL, DXF) use Playwright's `setInputFiles()`.
