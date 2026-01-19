#!/usr/bin/env node
/**
 * Rebuttr Post-Install Script
 *
 * Runs after npm install to set up the environment:
 * - Verifies native module (better-sqlite3) compiled correctly
 * - Creates necessary directories
 * - Installs OpenCode skills
 * - Prints welcome message
 *
 * Cross-platform: macOS (darwin), Linux, Windows
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Colors for terminal output (disabled on Windows cmd if needed)
const supportsColor = process.stdout.isTTY &&
    (process.platform !== 'win32' || process.env.TERM || process.env.WT_SESSION);

const c = supportsColor ? {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    red: '\x1b[31m'
} : {
    reset: '', bold: '', dim: '', green: '', blue: '', cyan: '', yellow: '', red: ''
};

// Paths
const BASE_DIR = path.resolve(__dirname, '..');
const PROJECT_FOLDER = path.join(os.homedir(), 'Rebuttr');
const OPENCODE_SKILL_DIR = path.join(os.homedir(), '.config', 'opencode', 'skill');
const PACKAGE_SKILL_DIR = path.join(BASE_DIR, 'skills');

// Create project directories
function createDirectories() {
    const dirs = [
        PROJECT_FOLDER,
        path.join(PROJECT_FOLDER, 'data'),
        path.join(PROJECT_FOLDER, 'data', 'papers'),
        path.join(PROJECT_FOLDER, 'input'),
        path.join(PROJECT_FOLDER, 'output'),
        path.join(PROJECT_FOLDER, 'sessions')
    ];

    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// Copy directory recursively
function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Install OpenCode skills
function installSkills() {
    if (!fs.existsSync(PACKAGE_SKILL_DIR)) {
        return { installed: [], skipped: [] };
    }

    // Ensure OpenCode skill directory exists
    if (!fs.existsSync(OPENCODE_SKILL_DIR)) {
        fs.mkdirSync(OPENCODE_SKILL_DIR, { recursive: true });
    }

    const skills = fs.readdirSync(PACKAGE_SKILL_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    const installed = [];
    const skipped = [];

    for (const skill of skills) {
        const srcDir = path.join(PACKAGE_SKILL_DIR, skill);
        const destDir = path.join(OPENCODE_SKILL_DIR, skill);

        if (fs.existsSync(destDir)) {
            // Don't overwrite - user may have customized
            skipped.push(skill);
        } else {
            copyDirRecursive(srcDir, destDir);
            installed.push(skill);
        }
    }

    return { installed, skipped };
}

// Register MCP server with OpenCode
function registerMcpServer() {
    const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
    const OPENCODE_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');

    // MCP server configuration (OpenCode format)
    const mcpConfig = {
        'rebuttr-knowledge': {
            type: 'local',
            command: ['rebuttr-mcp'],
            enabled: true,
            environment: {
                REBUTTR_API: 'http://localhost:3001'
            }
        }
    };

    try {
        // Ensure config directory exists
        if (!fs.existsSync(OPENCODE_CONFIG_DIR)) {
            fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
        }

        // Load existing config or create new
        let config = {};
        if (fs.existsSync(OPENCODE_CONFIG_FILE)) {
            try {
                config = JSON.parse(fs.readFileSync(OPENCODE_CONFIG_FILE, 'utf8'));
            } catch (e) {
                // If parsing fails, start fresh
                config = {};
            }
        }

        // Merge MCP servers (OpenCode uses 'mcp' key)
        if (!config.mcp) {
            config.mcp = {};
        }

        // Only add if not already present (don't overwrite user customizations)
        let added = false;
        if (!config.mcp['rebuttr-knowledge']) {
            config.mcp['rebuttr-knowledge'] = mcpConfig['rebuttr-knowledge'];
            added = true;
        }

        // Write back
        fs.writeFileSync(OPENCODE_CONFIG_FILE, JSON.stringify(config, null, 2));

        return { success: true, added };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Verify native module (better-sqlite3) works
function verifyNativeModules() {
    try {
        // Try to load better-sqlite3 to verify it compiled correctly
        const sqlite = require('better-sqlite3');
        // Quick test - create in-memory database
        const testDb = new sqlite(':memory:');
        testDb.exec('SELECT 1');
        testDb.close();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// Check if build tools are available (for native module compilation)
function checkBuildTools() {
    const platform = os.platform();
    const issues = [];

    if (platform === 'darwin') {
        // macOS needs Xcode Command Line Tools
        try {
            execSync('xcode-select -p', { stdio: 'pipe' });
        } catch {
            issues.push('Install Xcode Command Line Tools: xcode-select --install');
        }
    } else if (platform === 'linux') {
        // Linux needs build-essential, python3
        try {
            execSync('which gcc', { stdio: 'pipe' });
        } catch {
            issues.push('Install build tools: sudo apt-get install build-essential python3');
        }
    } else if (platform === 'win32') {
        // Windows needs windows-build-tools or Visual Studio
        try {
            execSync('where cl.exe', { stdio: 'pipe' });
        } catch {
            issues.push('Install build tools: npm install -g windows-build-tools');
        }
    }

    return issues;
}

// Main
function main() {
    console.log(`\n${c.blue}${c.bold}Rebuttr${c.reset} - Post-install setup\n`);

    const platform = os.platform();
    const arch = os.arch();
    console.log(`${c.dim}Platform: ${platform} (${arch})${c.reset}\n`);

    // 1. Verify native modules
    const nativeResult = verifyNativeModules();
    if (nativeResult.success) {
        console.log(`${c.green}✓${c.reset} Native modules (SQLite) verified`);
    } else {
        console.log(`${c.yellow}!${c.reset} Native module issue: ${nativeResult.error}`);
        const buildIssues = checkBuildTools();
        if (buildIssues.length > 0) {
            console.log(`${c.yellow}  To fix, you may need to:${c.reset}`);
            buildIssues.forEach(issue => console.log(`    - ${issue}`));
            console.log(`  Then run: ${c.cyan}npm rebuild better-sqlite3${c.reset}`);
        }
    }

    // 2. Create directories
    createDirectories();
    console.log(`${c.green}✓${c.reset} Created project directory: ${c.dim}${PROJECT_FOLDER}${c.reset}`);

    // 3. Install skills
    const skillResult = installSkills();
    if (skillResult.installed.length > 0) {
        console.log(`${c.green}✓${c.reset} Installed OpenCode skills: ${c.cyan}${skillResult.installed.join(', ')}${c.reset}`);
    }
    if (skillResult.skipped.length > 0) {
        console.log(`${c.dim}  Skipped (already exist): ${skillResult.skipped.join(', ')}${c.reset}`);
    }

    // 4. Register MCP server
    const mcpResult = registerMcpServer();
    if (mcpResult.success) {
        if (mcpResult.added) {
            console.log(`${c.green}✓${c.reset} Registered MCP server: ${c.cyan}rebuttr-knowledge${c.reset}`);
        } else {
            console.log(`${c.dim}  MCP server already registered${c.reset}`);
        }
    } else {
        console.log(`${c.yellow}!${c.reset} Could not register MCP server: ${mcpResult.error}`);
    }

    // Print welcome message
    console.log(`
${c.bold}Setup complete!${c.reset}

${c.yellow}Prerequisites:${c.reset}
  - OpenCode CLI must be installed: ${c.cyan}npm i -g opencode-ai${c.reset}

${c.yellow}Quick start:${c.reset}
  ${c.cyan}rebuttr${c.reset}              Launch the platform (starts server + opens browser)
  ${c.cyan}rebuttr papers add${c.reset}   Add a new manuscript
  ${c.cyan}rebuttr help${c.reset}         Show all commands

${c.dim}Data stored in: ${PROJECT_FOLDER}${c.reset}
`);
}

// Run only if executed directly (not required)
if (require.main === module) {
    try {
        main();
    } catch (err) {
        // Don't fail install on postinstall errors
        console.error(`${c.yellow}Warning:${c.reset} Post-install setup encountered an issue: ${err.message}`);
        process.exit(0); // Exit successfully anyway
    }
}

module.exports = { createDirectories, installSkills };
