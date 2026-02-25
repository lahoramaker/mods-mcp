# mods-mcp-v2

MCP server bridging LLMs to the Mods CE digital fabrication platform.

## Mods Platform Internals

Mods CE is a browser-based visual programming environment for digital fabrication (CNC milling, 3D printing, laser cutting, etc.). Key internals:

### Module Format (IIFE)

Modules are **Immediately Invoked Function Expressions** (IIFEs) stored as `.js` files in `mods/modules/`. Each IIFE returns an object:

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

Programs are JSON files in `mods/programs/`. Structure:

- **Modules** are keyed by **random float IDs** generated via `Math.random()` (e.g., `"0.7432891654"`)
- Each module entry has a `definition` field containing the **full inlined IIFE JavaScript source** (not a file path)
- **Links** (connections between modules) are stored as **double-stringified JSON** — a JSON string within a JSON string within an array. Three levels of `eval()`/`JSON.parse()` are needed to extract the actual link data

### Program Loading

`mods.js` loads programs by:
1. Fetching the program JSON via HTTP GET
2. `eval()`-ing each module's `definition` field to instantiate the module
3. Connecting links by triple-eval of the stringified JSON link data

### On/Off Switch Gating Pattern

Machine programs use **on/off switch modules as gates** to control data flow at the end of the pipeline. This is a common pattern across many (possibly all) machine workflows:

- One on/off switch gates the path to **WebUSB / serial output** (sends to machine) — **default ON**
- Another on/off switch gates the path to **save file** (saves toolpath to disk) — **default OFF**

The UI shows these as toggle switches labeled "on/off" with a note like "Optional: Connect this module to save the toolpath."

**To save output to file instead of sending to machine**, you must:
1. Find the on/off switch connected to the `save file` module and toggle it **ON**
2. Optionally toggle the machine output on/off switch **OFF** (to avoid sending to a machine)

**To toggle an on/off switch via automation:**
- Find the module named `on/off` (there may be multiple — identify by what it connects to)
- The switch state is controlled by a button in the module UI; clicking it toggles between on and off
- Use `set_parameter` or `trigger_action` MCP tools to toggle the switch

This pattern applies to programs under `programs/machines/` including Roland SRM-20 mill, Epilog laser, Prusa 3D printer, and others.

## Architecture

### Source Files

| File | Responsibility |
|------|---------------|
| `src/server.js` | MCP server setup using `@modelcontextprotocol/sdk`, tool definitions, request routing |
| `src/browser.js` | Playwright browser lifecycle, serving Mods CE locally, page interaction |
| `src/programs.js` | Program discovery from `mods/programs/`, loading, creating program JSON |
| `src/modules.js` | Module discovery from `mods/modules/`, IIFE evaluation, I/O type extraction |

### MCP Tools

| Tool | Description |
|------|-------------|
| `get_server_status` | Server health, browser state, HTTP URL, loaded program info |
| `launch_browser` | Launch Chrome on demand (must call before browser-dependent tools) |
| `list_programs` | List available pre-built programs from `mods/programs/` by category |
| `list_modules` | List available modules from `mods/modules/` by category |
| `get_module_info` | Parse a module file to extract name, inputs, outputs with types |
| `load_program` | Load a program into the Mods browser instance |
| `get_program_state` | Get all modules, parameters, and buttons in the loaded program |
| `set_parameter` | Set a parameter value on a module by name |
| `trigger_action` | Click a button in a module (calculate, export, etc.) |
| `load_file` | Load a file into a module's file input (read SVG, read png, etc.) |
| `create_program` | Build a new program from module paths and connection spec |
| `save_program` | Save current program state to a file |
| `export_file` | Get the most recently downloaded/exported file |

## Development Setup

```bash
# Clone the repository
git clone <repo-url>
cd mods-mcp-v2

# Initialize the Mods CE submodule and install Playwright browsers
npm run setup

# Install dependencies
npm install

# Run the server
npm start
```

### Prerequisites

- Node.js >= 18.0.0
- Git (for submodule management)

### Project Structure

```
mods-mcp-v2/
├── src/
│   ├── server.js      # MCP server entry point
│   ├── browser.js     # Playwright browser automation
│   ├── programs.js    # Program discovery and creation
│   └── modules.js     # Module introspection
├── mods/              # Mods CE git submodule
│   ├── index.html     # Mods CE application
│   ├── js/mods.js     # Mods CE core runtime
│   ├── modules/       # 191 IIFE module files
│   └── programs/      # 53 pre-built program JSONs
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
      "args": ["/absolute/path/to/mods-mcp-v2/src/server.js"],
      "env": {}
    }
  }
}
```

Optional flags via args:
- `"--port", "9090"` — use a different HTTP port (default: 8080)
- `"--headless"` — run browser in headless mode (no visible window)

Example with all flags:
```json
{
  "mcpServers": {
    "mods": {
      "command": "node",
      "args": ["/absolute/path/to/mods-mcp-v2/src/server.js", "--port", "9090", "--headless"]
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
- The `save_program()` function is local to mods.js — to extract program state from outside, replicate its logic by reading `#modules` children and `#svg #links` children.
- **Checkbox values**: HTML checkbox `.value` is always `"on"` regardless of checked state. Always use `.checked` (boolean) to read/write checkbox state. This is critical for on/off switch modules.
- **Duplicate module names**: When multiple modules share a name (e.g., two `on/off` switches), use `module_name:module_id` syntax in `set_parameter` and `trigger_action` (e.g., `on/off:0.44105604671305754`). Use `get_program_state` to find IDs — it includes `connectedTo`/`connectedFrom` fields to identify which module connects where.
