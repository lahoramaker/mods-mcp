# Architecture

C4 model documentation for MOPS (Machines Obeying Prompt Suggestions).

## Level 1: System Context

Shows how the MCP server fits into the broader ecosystem — who uses it and what external systems it depends on.

```mermaid
C4Context
    title System Context — MOPS

    Person(user, "User", "Operator, designer, or<br>Fab Lab user")
    System(llm_client, "LLM Client", "Claude Code, Claude Desktop,<br>or any MCP-compatible client")
    System(mcp_server, "MOPS", "MCP server bridging LLMs<br>to Mods CE via browser automation")
    System_Ext(mods_ce, "Mods CE", "Remote deployment at<br>modsproject.org")
    System_Ext(machine, "Fabrication Machine", "Roland SRM-20, Epilog laser,<br>Prusa 3D printer, etc.")

    Rel(user, llm_client, "Natural language<br>instructions")
    Rel(llm_client, mcp_server, "MCP tool calls<br>(stdio JSON-RPC)")
    Rel(mcp_server, mods_ce, "Browser automation<br>(Playwright CDP)")
    Rel(mods_ce, machine, "Toolpath via<br>WebUSB / file export")
```

## Level 2: Container Diagram

The MCP server process contains two main containers: the MCP protocol handler and a managed browser instance. Modules and programs are fetched from the remote Mods CE deployment.

```mermaid
C4Container
    title Container Diagram — MOPS

    Person(llm, "LLM Client")

    System_Boundary(server_process, "MOPS (Node.js)") {
        Container(mcp, "MCP Server", "McpServer + StdioTransport", "Registers 13 tools,<br>validates input with Zod,<br>fetches remote manifests")
        Container(browser_mgr, "Browser Manager", "Playwright", "Launches Chrome,<br>manages page lifecycle,<br>intercepts downloads")
        Container(vm, "Module Parser", "Node.js vm sandbox", "Evaluates module IIFEs<br>to extract I/O definitions")
    }

    System_Ext(mods_remote, "Mods CE (Remote)", "modsproject.org<br>Programs, modules, static assets")
    System_Ext(chrome, "Chrome Browser", "Runs Mods CE application")

    Rel(llm, mcp, "stdio JSON-RPC", "MCP protocol")
    Rel(mcp, browser_mgr, "load, interact, read state")
    Rel(mcp, vm, "parse module source")
    Rel(mcp, mods_remote, "HTTP fetch", "manifests, module source")
    Rel(browser_mgr, chrome, "CDP (Chrome DevTools Protocol)")
    Rel(chrome, mods_remote, "HTTP GET", "Load Mods CE + programs")
```

## Level 3: Component Diagram

Detailed view of the two source modules and how they collaborate.

```mermaid
C4Component
    title Component Diagram — Source Modules

    Container_Boundary(server_js, "server.js — Entry Point") {
        Component(cli, "CLI Parser", "Parses --mods-url and --headless flags")
        Component(manifest, "Manifest Cache", "Fetches and caches<br>modules/programs index.json")
        Component(mcp_server, "MCP Tool Registry", "13 tools with Zod schemas")
        Component(find_module, "findModule()", "Resolves module by name or name:id")
        Component(vm_sandbox, "extractWithVm()", "VM sandbox with DOM mocks<br>for module IIFE parsing")
        Component(regex_fb, "extractWithRegex()", "Regex fallback parser")
    }

    Container_Boundary(browser_js, "browser.js — Browser Automation") {
        Component(launch, "launch()", "Launches Chrome via Playwright,<br>waits for mods_prog_load")
        Component(load_prog, "loadProgram()", "Navigates to ?program= URL,<br>waits for DOM modules")
        Component(get_state, "getProgramState()", "Reads DOM modules + SVG links,<br>builds connection map")
        Component(set_input, "setModuleInput()", "Sets text/checkbox values,<br>dispatches change events")
        Component(click_btn, "clickModuleButton()", "Finds button by text, clicks it")
        Component(post_msg, "postMessageFile()", "Injects SVG/PNG via postMessage API")
        Component(set_file, "setModuleFile()", "Injects files via setInputFiles()")
        Component(downloads, "Download Interceptor", "Captures Playwright download events")
        Component(extract, "extractProgramState()", "Calls mods_build_v2_program()<br>or fallback DOM extraction")
    }

    Rel(mcp_server, find_module, "resolves modules")
    Rel(find_module, get_state, "gets current state")
    Rel(mcp_server, manifest, "fetches manifests")
    Rel(mcp_server, launch, "start browser")
    Rel(mcp_server, load_prog, "load program")
    Rel(mcp_server, get_state, "read state")
    Rel(mcp_server, set_input, "set parameters")
    Rel(mcp_server, click_btn, "trigger actions")
    Rel(mcp_server, post_msg, "load SVG/PNG")
    Rel(mcp_server, set_file, "load other files")
    Rel(mcp_server, downloads, "export files")
    Rel(mcp_server, extract, "save program")
    Rel(mcp_server, vm_sandbox, "parse modules")
    Rel(vm_sandbox, regex_fb, "fallback")
```

## Sequence Diagram: PCB Milling Workflow

Shows the complete data flow when an LLM generates a PCB toolpath.

```mermaid
sequenceDiagram
    participant LLM as LLM Client
    participant MCP as MOPS
    participant PW as Playwright
    participant Chrome as Chrome Browser
    participant Mods as Mods CE (DOM)
    participant Remote as modsproject.org

    Note over LLM, Remote: 1. Startup
    MCP->>PW: Launch Chrome
    PW->>Chrome: Open browser
    Chrome->>Remote: GET modsproject.org
    Remote-->>Chrome: Mods CE application
    Chrome->>Mods: Initialize mods.js

    Note over LLM, Remote: 2. Load Program
    LLM->>MCP: load_program("...SRM-20 mill/mill 2D PCB")
    MCP->>PW: loadProgram()
    PW->>Chrome: Navigate to ?program=...
    Chrome->>Remote: GET program JSON + module sources
    Remote-->>Chrome: Program data
    Chrome->>Mods: eval() module IIFEs, build UI
    PW-->>MCP: DOM modules ready
    MCP-->>LLM: Module list + IDs

    Note over LLM, Remote: 3. Inspect & Configure
    LLM->>MCP: get_program_state()
    MCP->>PW: getProgramState()
    PW->>Chrome: page.evaluate()
    Chrome->>Mods: Read #modules + #svg #links
    Mods-->>Chrome: Module params, buttons, connections
    Chrome-->>PW: State JSON
    PW-->>MCP: State with connectedTo/connectedFrom
    MCP-->>LLM: Full pipeline topology

    LLM->>MCP: set_parameter("on/off:0.441...", "", "true")
    MCP->>PW: setModuleInput()
    PW->>Chrome: Set checkbox.checked = true
    MCP-->>LLM: Success

    LLM->>MCP: trigger_action("set PCB defaults", "mill traces (1/64)")
    MCP->>PW: clickModuleButton()
    PW->>Chrome: button.click()
    Chrome->>Mods: Apply preset parameters
    MCP-->>LLM: Clicked

    Note over LLM, Remote: 4. Load Input & Calculate
    LLM->>MCP: load_file("read SVG", "/path/to/board.svg")
    MCP->>PW: postMessageFile()
    PW->>Chrome: window.postMessage(SVG data)
    Chrome->>Mods: SVG → convert → threshold → distance → offset → edge → vectorize

    LLM->>MCP: trigger_action("mill raster 2D", "calculate")
    MCP->>PW: clickModuleButton()
    PW->>Chrome: button.click()
    Chrome->>Mods: Calculate toolpath
    Mods->>Mods: path → mill raster 2D → view toolpath → Roland SRM-20 → on/off → save file
    Chrome-->>PW: Download event (SVG image.rml)
    PW->>PW: Capture download in memory
    MCP-->>LLM: Success + download info

    Note over LLM, Remote: 5. Export
    LLM->>MCP: export_file()
    MCP->>PW: getLatestDownload()
    PW-->>MCP: RML file content
    MCP-->>LLM: Toolpath data
```

## Data Flow: Mods CE Internal Pipeline

How data flows through a typical PCB milling program inside the Mods CE browser.

```mermaid
flowchart LR
    subgraph Input
        SVG[read SVG]
        PNG[read png]
    end

    subgraph "Image Processing"
        CONVERT[convert SVG image<br>1000 DPI]
        THRESH[image threshold<br>0-1]
        DIST[distance transform]
        OFFSET[offset]
        EDGE[edge detect]
        ORIENT[orient edges]
        VEC[vectorize]
    end

    subgraph "Toolpath Generation"
        MILL[mill raster 2D<br>calculate]
        VIEW[view toolpath]
        DEFAULTS[set PCB defaults]
        VBIT[V-bit calculator]
    end

    subgraph "Machine Output"
        MACHINE[Roland SRM-20<br>milling machine]
        RML[Roland SRM-20 RML<br>format converter]
    end

    subgraph "Output Gates"
        SW_USB[on/off<br>DEFAULT: ON]
        SW_FILE[on/off<br>DEFAULT: OFF]
        USB[WebUSB]
        SAVE[save file]
    end

    SVG --> CONVERT --> THRESH --> DIST --> OFFSET --> EDGE --> ORIENT --> VEC --> MILL
    PNG --> THRESH
    CONVERT -.->|imageInfo| MILL
    PNG -.->|imageInfo| MILL
    DEFAULTS -->|settings| MILL
    VBIT -->|settings| MILL
    MILL -->|toolpath| VIEW --> MACHINE
    MILL -.->|offset| OFFSET
    MACHINE -->|file| SW_USB --> USB
    MACHINE -->|file| SW_FILE --> SAVE

    style SW_USB fill:#4CAF50,color:#fff
    style SW_FILE fill:#f44336,color:#fff
    style USB fill:#FFB74D
    style SAVE fill:#FFB74D
```

## Key Design Decisions

### Why Playwright instead of direct DOM manipulation?

Mods CE was designed as a standalone browser application. Its core runtime (`mods.js`) uses closures, `eval()`, and direct DOM manipulation that make it impossible to run in Node.js. Playwright lets us control the real application exactly as a human would, while also providing:

- **Download interception** for capturing generated toolpath files
- **File injection** via `setInputFiles()` and `postMessage` for loading designs
- **JavaScript evaluation** for reading DOM state and triggering events
- **Page navigation** for loading different programs

### Why a remote deployment instead of a local submodule?

The original architecture bundled Mods CE as a git submodule served via a local HTTP server. The remote-only approach eliminates the submodule dependency, simplifies installation, and means MOPS always uses the latest Mods CE version deployed at [modsproject.org](https://modsproject.org). A custom deployment URL can still be specified via `--mods-url`.

### Why a vm sandbox for module parsing?

Module IIFE source files define their inputs/outputs inside closures. Simple regex extraction misses complex cases (computed types, conditional ports). The Node.js `vm` module lets us evaluate each IIFE in an isolated sandbox with minimal DOM mocks, achieving 100% parse rate without executing any browser-dependent code.

### Why connection topology in get_program_state?

The original state only showed module names, parameters, and buttons — with no indication of how modules connect. This made it impossible for an LLM to distinguish between two `on/off` switches or understand the data flow. By parsing the SVG link elements, we expose `connectedTo` and `connectedFrom` on each module, enabling the LLM to reason about the pipeline.
