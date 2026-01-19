#!/usr/bin/env node
/**
 * ReviewFlow - Main CLI
 *
 * Unified command-line interface for managing papers and running the platform.
 *
 * Usage:
 *   reviewflow                      # Start the platform (server + open browser)
 *   reviewflow start                # Start server only
 *   reviewflow papers               # List all papers
 *   reviewflow papers add           # Add a new paper
 *   reviewflow papers import <file> # Import paper from JSON
 *   reviewflow papers remove <id>   # Archive a paper
 *   reviewflow init                 # Initialize/reset database
 *   reviewflow help                 # Show help
 */

const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const os = require('os');

// Paths
const BASE_DIR = __dirname;
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.config', 'reviewflow', 'config.json');
const LOCAL_CONFIG_PATH = path.join(BASE_DIR, 'platform-config.json');

// Load config (global takes precedence)
function loadConfig() {
    let config = {};

    // Try global config first
    if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
        try {
            config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
        } catch (e) {
            // ignore
        }
    }

    // Fall back to local config
    if (!config.projectFolder && fs.existsSync(LOCAL_CONFIG_PATH)) {
        try {
            const localConfig = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
            config = { ...localConfig, ...config };
        } catch (e) {
            // ignore
        }
    }

    return config;
}

const CONFIG = loadConfig();
const PROJECT_FOLDER = CONFIG.projectFolder || path.join(os.homedir(), 'ReviewFlow');
const DB_PATH = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');

// Database (better-sqlite3) - required
const Database = require('better-sqlite3');

// Colors
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgBlue: '\x1b[44m',
    bgGreen: '\x1b[42m'
};

// Logging helpers
const log = {
    info: (msg) => console.log(`${c.cyan}ℹ${c.reset} ${msg}`),
    success: (msg) => console.log(`${c.green}✓${c.reset} ${msg}`),
    warn: (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
    error: (msg) => console.log(`${c.red}✗${c.reset} ${msg}`),
    step: (n, msg) => console.log(`${c.blue}[${n}]${c.reset} ${msg}`),
    header: (msg) => console.log(`\n${c.bold}${c.blue}${msg}${c.reset}\n`)
};

// ============================================================================
// Database Operations
// ============================================================================

function getDb() {
    if (!fs.existsSync(DB_PATH)) {
        log.error('Database not initialized. Run: reviewflow init');
        process.exit(1);
    }
    return new Database(DB_PATH);
}

function initDatabase() {
    // Create directories in PROJECT_FOLDER
    const dirs = ['data', 'data/papers', 'input', 'output', 'sessions'];
    dirs.forEach(dir => {
        const p = path.join(PROJECT_FOLDER, dir);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });

    const db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');

    db.exec(`
        -- Papers table
        CREATE TABLE IF NOT EXISTS papers (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            authors TEXT,
            journal TEXT,
            field TEXT,
            description TEXT,
            submission_date TEXT,
            review_date TEXT,
            status TEXT DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            config JSON
        );

        -- Reviewers table
        CREATE TABLE IF NOT EXISTS reviewers (
            id TEXT NOT NULL,
            paper_id TEXT NOT NULL,
            name TEXT,
            expertise TEXT,
            overall_assessment TEXT,
            PRIMARY KEY (id, paper_id),
            FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
        );

        -- Comments table
        CREATE TABLE IF NOT EXISTS comments (
            id TEXT NOT NULL,
            paper_id TEXT NOT NULL,
            reviewer_id TEXT NOT NULL,
            type TEXT,
            category TEXT,
            location TEXT,
            original_text TEXT,
            full_context TEXT,
            draft_response TEXT,
            final_response TEXT,
            status TEXT DEFAULT 'pending',
            priority TEXT DEFAULT 'medium',
            requires_new_analysis INTEGER DEFAULT 0,
            analysis_type JSON,
            experts JSON,
            recommended_response TEXT,
            advice_to_author TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id, paper_id),
            FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
        );

        -- Expert discussions
        CREATE TABLE IF NOT EXISTS expert_discussions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id TEXT NOT NULL,
            comment_id TEXT NOT NULL,
            expert_name TEXT,
            expert_icon TEXT,
            expert_color TEXT,
            verdict TEXT,
            assessment TEXT,
            data_analysis JSON,
            recommendation TEXT,
            key_data_points JSON,
            FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
        );

        -- Chat history
        CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id TEXT,
            comment_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- App state (per paper)
        CREATE TABLE IF NOT EXISTS app_state (
            paper_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value JSON,
            PRIMARY KEY (paper_id, key)
        );

        -- Global settings
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value JSON
        );

        -- Indices
        CREATE INDEX IF NOT EXISTS idx_comments_paper ON comments(paper_id);
        CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(paper_id, status);
        CREATE INDEX IF NOT EXISTS idx_expert_paper ON expert_discussions(paper_id);
        CREATE INDEX IF NOT EXISTS idx_chat_paper ON chat_history(paper_id);
    `);

    db.close();
    return true;
}

// Install skills to OpenCode global skill folder
// force: if true, overwrite existing skills
function installSkills(force = false) {
    const OPENCODE_SKILL_DIR = path.join(os.homedir(), '.config', 'opencode', 'skill');
    const PACKAGE_SKILL_DIR = path.join(BASE_DIR, 'skills');

    // Ensure OpenCode skill directory exists
    if (!fs.existsSync(OPENCODE_SKILL_DIR)) {
        fs.mkdirSync(OPENCODE_SKILL_DIR, { recursive: true });
    }

    if (!fs.existsSync(PACKAGE_SKILL_DIR)) {
        log.warn('No skills folder found in package');
        return { installed: [], skipped: [] };
    }

    const skills = fs.readdirSync(PACKAGE_SKILL_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    const installed = [];
    const skipped = [];

    for (const skill of skills) {
        const srcDir = path.join(PACKAGE_SKILL_DIR, skill);
        const destDir = path.join(OPENCODE_SKILL_DIR, skill);

        if (fs.existsSync(destDir) && !force) {
            // Skill already exists - don't overwrite (user may have customized)
            skipped.push(skill);
        } else {
            // Remove existing if force
            if (fs.existsSync(destDir)) {
                fs.rmSync(destDir, { recursive: true });
            }
            // Copy skill folder
            copyDirRecursive(srcDir, destDir);
            installed.push(skill);
        }
    }

    return { installed, skipped };
}

// Helper: recursively copy directory
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

// ============================================================================
// Paper Management
// ============================================================================

function listPapers() {
    const db = getDb();
    const papers = db.prepare(`
        SELECT p.*,
            COUNT(DISTINCT c.id) as total_comments,
            SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) as completed
        FROM papers p
        LEFT JOIN comments c ON p.id = c.paper_id
        WHERE p.status = 'active'
        GROUP BY p.id
        ORDER BY p.updated_at DESC
    `).all();
    db.close();
    return papers;
}

function getPaper(id) {
    const db = getDb();
    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
    db.close();
    return paper;
}

function generateId(title) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25);
    const ts = Date.now().toString(36).slice(-4);
    return `${slug}-${ts}`;
}

function addPaper(info) {
    const db = getDb();
    const id = info.id || generateId(info.title);

    db.prepare(`
        INSERT INTO papers (id, title, authors, journal, field, description, review_date, config)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        info.title,
        info.authors || '',
        info.journal || '',
        info.field || '',
        info.description || '',
        new Date().toISOString().split('T')[0],
        JSON.stringify(info.config || {})
    );

    // Create paper directory
    const paperDir = path.join(PROJECT_FOLDER, 'data', 'papers', id);
    fs.mkdirSync(paperDir, { recursive: true });
    fs.mkdirSync(path.join(paperDir, 'input'), { recursive: true });

    db.close();
    return id;
}

function removePaper(id) {
    const db = getDb();
    db.prepare("UPDATE papers SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    db.close();
}

function importPaperData(paperId, data) {
    const db = getDb();

    const importTx = db.transaction(() => {
        // Import reviewers and comments
        if (data.reviewers) {
            const reviewerStmt = db.prepare(`
                INSERT OR REPLACE INTO reviewers (id, paper_id, name, expertise, overall_assessment)
                VALUES (?, ?, ?, ?, ?)
            `);

            const commentStmt = db.prepare(`
                INSERT OR REPLACE INTO comments (
                    id, paper_id, reviewer_id, type, category, location,
                    original_text, full_context, draft_response, status, priority,
                    requires_new_analysis, analysis_type, experts, recommended_response, advice_to_author
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const reviewer of data.reviewers) {
                reviewerStmt.run(
                    reviewer.id, paperId, reviewer.name || '',
                    reviewer.expertise || '', reviewer.overall_assessment || ''
                );

                for (const comment of (reviewer.comments || [])) {
                    commentStmt.run(
                        comment.id, paperId, reviewer.id,
                        comment.type || 'minor', comment.category || '', comment.location || '',
                        comment.original_text || '', comment.full_context || '',
                        comment.draft_response || '', comment.status || 'pending',
                        comment.priority || 'medium', comment.requires_new_analysis ? 1 : 0,
                        JSON.stringify(comment.analysis_type || []),
                        JSON.stringify(comment.experts || []),
                        comment.recommended_response || '', comment.advice_to_author || ''
                    );
                }
            }
        }
    });

    importTx();
    db.close();
}

// ============================================================================
// Server Management
// ============================================================================

function isServerRunning(port = 3001) {
    return new Promise((resolve) => {
        const req = http.request({ host: 'localhost', port, path: '/health', timeout: 1000 }, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        const serverPath = path.join(BASE_DIR, 'opencode-server.js');
        const child = spawn('node', [serverPath], {
            detached: true,
            stdio: 'ignore',
            cwd: BASE_DIR
        });
        child.unref();

        // Wait for server to be ready
        let attempts = 0;
        const check = setInterval(async () => {
            attempts++;
            if (await isServerRunning()) {
                clearInterval(check);
                resolve(true);
            } else if (attempts > 20) {
                clearInterval(check);
                reject(new Error('Server failed to start'));
            }
        }, 250);
    });
}

function stopServer() {
    return new Promise((resolve) => {
        try {
            // Find and kill the server process
            const result = execSync('pkill -f "node.*opencode-server.js" 2>/dev/null || true', { encoding: 'utf8' });
            // Give it a moment to shut down
            setTimeout(() => resolve(true), 500);
        } catch (e) {
            resolve(false);
        }
    });
}

async function getServerStatus() {
    const running = await isServerRunning();
    if (!running) {
        return { running: false };
    }

    // Try to get more info from the server
    try {
        const response = await new Promise((resolve, reject) => {
            const req = http.get('http://localhost:3001/db/status', (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve({});
                    }
                });
            });
            req.on('error', () => resolve({}));
            req.setTimeout(2000, () => reject(new Error('timeout')));
        });
        return { running: true, ...response };
    } catch (e) {
        return { running: true };
    }
}

function openBrowser(url) {
    const platform = os.platform();
    let cmd;

    if (platform === 'darwin') {
        cmd = `open "${url}"`;
    } else if (platform === 'win32') {
        cmd = `start "" "${url}"`;
    } else {
        cmd = `xdg-open "${url}"`;
    }

    try {
        exec(cmd);
    } catch (e) {
        log.warn(`Could not open browser. Please visit: ${url}`);
    }
}

// ============================================================================
// Interactive Prompts
// ============================================================================

function createRL() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

async function ask(rl, question, defaultVal = '') {
    return new Promise((resolve) => {
        const suffix = defaultVal ? ` ${c.dim}(${defaultVal})${c.reset}` : '';
        rl.question(`${c.bold}${question}${suffix}: ${c.reset}`, (answer) => {
            resolve(answer.trim() || defaultVal);
        });
    });
}

async function interactiveAddPaper() {
    const rl = createRL();

    log.header('📄 Add New Paper');

    const title = await ask(rl, 'Paper title');
    if (!title) {
        log.error('Title is required');
        rl.close();
        return null;
    }

    const authors = await ask(rl, 'Authors');
    const journal = await ask(rl, 'Target journal');
    const field = await ask(rl, 'Research field');

    const hasFile = await ask(rl, 'Import reviews file? (y/n)', 'n');
    let reviewPath = null;
    if (hasFile.toLowerCase() === 'y') {
        reviewPath = await ask(rl, 'Path to reviews file');
    }

    rl.close();

    const paperId = addPaper({ title, authors, journal, field });
    log.success(`Created paper: ${c.cyan}${paperId}${c.reset}`);

    if (reviewPath && fs.existsSync(reviewPath)) {
        const ext = path.extname(reviewPath).toLowerCase();
        const destDir = path.join(PROJECT_FOLDER, 'data', 'papers', paperId, 'input');

        // Copy file
        fs.copyFileSync(reviewPath, path.join(destDir, `reviews${ext}`));
        log.success('Copied reviews file');

        // Import if JSON
        if (ext === '.json') {
            try {
                const data = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
                importPaperData(paperId, data);
                log.success('Imported review data');
            } catch (e) {
                log.warn(`Could not parse JSON: ${e.message}`);
            }
        }
    }

    return paperId;
}

// ============================================================================
// CLI Commands
// ============================================================================

// Check if OpenCode CLI is installed
function checkOpenCode() {
    try {
        execSync('which opencode', { encoding: 'utf-8', stdio: 'pipe' });
        return true;
    } catch (e) {
        return false;
    }
}

function showBanner() {
    const title = 'ReviewFlow';
    const subtitle = 'AI-powered peer review response platform';
    const width = 57; // inner width between ║ characters
    const pad1 = ' '.repeat(width - 3 - title.length);
    const pad2 = ' '.repeat(width - 3 - subtitle.length);
    console.log(`
${c.blue}╔${'═'.repeat(width)}╗
║${' '.repeat(width)}║
║   ${c.bold}${c.white}${title}${c.reset}${c.blue}${pad1}║
║   ${c.dim}${c.white}${subtitle}${c.reset}${c.blue}${pad2}║
║${' '.repeat(width)}║
╚${'═'.repeat(width)}╝${c.reset}
`);
}

function requireOpenCode() {
    if (!checkOpenCode()) {
        log.error('OpenCode CLI is required but not installed');
        console.log(`\n  Install with: ${c.cyan}npm install -g @anthropic/opencode${c.reset}\n`);
        process.exit(1);
    }
}

function showHelp() {
    console.log(`
${c.bold}Usage:${c.reset}
  ${c.cyan}reviewflow${c.reset}                        Start platform (server + browser)
  ${c.cyan}reviewflow start${c.reset}                  Start server in foreground
  ${c.cyan}reviewflow stop${c.reset}                   Stop the server
  ${c.cyan}reviewflow status${c.reset}                 Check server status
  ${c.cyan}reviewflow restart${c.reset}                Restart the server
  ${c.cyan}reviewflow papers${c.reset}                 List all papers
  ${c.cyan}reviewflow papers add${c.reset}             Add a new paper interactively
  ${c.cyan}reviewflow papers import <file>${c.reset}  Import from JSON file
  ${c.cyan}reviewflow papers remove <id>${c.reset}    Archive a paper
  ${c.cyan}reviewflow papers open <id>${c.reset}      Open specific paper in browser
  ${c.cyan}reviewflow config${c.reset}                 Show current configuration
  ${c.cyan}reviewflow config set <key> <val>${c.reset} Set a config value
  ${c.cyan}reviewflow init${c.reset}                   Initialize database + install skills
  ${c.cyan}reviewflow skills${c.reset}                 Manage OpenCode skills
  ${c.cyan}reviewflow skills list${c.reset}            List installed skills
  ${c.cyan}reviewflow skills install${c.reset}         Install/update skills
  ${c.cyan}reviewflow help${c.reset}                   Show this help

${c.bold}Examples:${c.reset}
  reviewflow                         # Launch the platform
  reviewflow stop                    # Stop running server
  reviewflow status                  # Check if server is running
  reviewflow papers add              # Add a new manuscript
  reviewflow papers import data.json # Import existing review data
  reviewflow config                  # Show config
`);
}

// Config commands
function showConfig() {
    console.log(`\n${c.bold}ReviewFlow Configuration${c.reset}\n`);
    console.log(`  ${c.dim}Config file:${c.reset} ${GLOBAL_CONFIG_PATH}`);
    console.log(`  ${c.dim}Project folder:${c.reset} ${PROJECT_FOLDER}`);
    console.log(`  ${c.dim}Database:${c.reset} ${DB_PATH}`);
    console.log();
    console.log(`${c.bold}Settings:${c.reset}`);
    console.log(JSON.stringify(CONFIG, null, 2).split('\n').map(l => '  ' + l).join('\n'));
    console.log();
}

function setConfigValue(key, value) {
    // Load current config
    let config = {};
    if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
    }

    // Handle nested keys like "server.port"
    const keys = key.split('.');
    let obj = config;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
    }

    // Try to parse value as number or boolean
    let parsedValue = value;
    if (value === 'true') parsedValue = true;
    else if (value === 'false') parsedValue = false;
    else if (!isNaN(value) && value !== '') parsedValue = Number(value);

    obj[keys[keys.length - 1]] = parsedValue;

    // Save config
    const configDir = path.dirname(GLOBAL_CONFIG_PATH);
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));

    log.success(`Set ${key} = ${parsedValue}`);
}

function displayPapers(papers) {
    if (papers.length === 0) {
        log.info('No papers yet. Add one with: paper-review papers add');
        return;
    }

    console.log(`\n${c.bold}Your Papers:${c.reset}\n`);

    papers.forEach((p, i) => {
        const total = p.total_comments || 0;
        const done = p.completed || 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        // Progress bar
        const barLen = 20;
        const filled = Math.round((pct / 100) * barLen);
        const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
        const barColor = pct === 100 ? c.green : pct > 50 ? c.yellow : c.blue;

        console.log(`  ${c.cyan}${i + 1}.${c.reset} ${c.bold}${p.title}${c.reset}`);
        console.log(`     ${c.dim}ID:${c.reset} ${p.id}`);
        if (p.journal) console.log(`     ${c.dim}Journal:${c.reset} ${p.journal}`);
        console.log(`     ${c.dim}Progress:${c.reset} ${barColor}${bar}${c.reset} ${done}/${total} (${pct}%)`);
        console.log(`     ${c.dim}Updated:${c.reset} ${p.updated_at || p.created_at}`);
        console.log();
    });
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0] || '';
    const subcmd = args[1] || '';

    // Require OpenCode for all commands except help
    if (cmd !== 'help' && cmd !== '-h' && cmd !== '--help') {
        requireOpenCode();
    }

    switch (cmd) {
        case '':
        case 'launch':
            // Default: start server and open browser
            showBanner();

            // Initialize if needed
            if (!fs.existsSync(DB_PATH)) {
                log.step('1/3', 'Initializing database...');
                initDatabase();
                log.success('Database ready');
            }

            // Start server
            log.step('2/3', 'Starting server...');
            const running = await isServerRunning();
            if (running) {
                log.success('Server already running');
            } else {
                await startServer();
                log.success('Server started on http://localhost:3001');
            }

            // Open browser - use localhost since server now serves static files
            log.step('3/3', 'Opening browser...');
            openBrowser('http://localhost:3001');
            log.success('Platform launched!');

            console.log(`\n${c.dim}Press Ctrl+C to stop the server${c.reset}\n`);
            break;

        case 'start':
            showBanner();
            if (!fs.existsSync(DB_PATH)) {
                initDatabase();
            }
            log.info('Starting server...');
            // Start in foreground
            require('./opencode-server.js');
            break;

        case 'stop':
            log.info('Stopping server...');
            if (await isServerRunning()) {
                await stopServer();
                // Verify it stopped
                const stillRunning = await isServerRunning();
                if (!stillRunning) {
                    log.success('Server stopped');
                } else {
                    log.error('Failed to stop server');
                }
            } else {
                log.info('Server is not running');
            }
            break;

        case 'status':
            const status = await getServerStatus();
            if (status.running) {
                console.log(`\n${c.green}●${c.reset} ${c.bold}Server is running${c.reset}`);
                console.log(`  ${c.dim}URL:${c.reset} http://localhost:3001`);
                if (status.database) {
                    console.log(`  ${c.dim}Database:${c.reset} ${status.database}`);
                }
                if (status.papers !== undefined) {
                    console.log(`  ${c.dim}Papers:${c.reset} ${status.papers}`);
                }
                if (status.comments !== undefined) {
                    console.log(`  ${c.dim}Comments:${c.reset} ${status.comments}`);
                }
                console.log();
            } else {
                console.log(`\n${c.red}●${c.reset} ${c.bold}Server is not running${c.reset}`);
                console.log(`  ${c.dim}Start with:${c.reset} reviewflow`);
                console.log();
            }
            break;

        case 'restart':
            log.info('Restarting server...');
            if (await isServerRunning()) {
                await stopServer();
                log.info('Server stopped');
            }
            await startServer();
            log.success('Server restarted on http://localhost:3001');
            break;

        case 'papers':
            switch (subcmd) {
                case '':
                case 'list':
                    displayPapers(listPapers());
                    break;

                case 'add':
                    if (!fs.existsSync(DB_PATH)) initDatabase();
                    await interactiveAddPaper();
                    break;

                case 'import':
                    const filePath = args[2];
                    if (!filePath) {
                        log.error('Please provide a file path');
                        log.info('Usage: paper-review papers import <file.json>');
                        break;
                    }
                    if (!fs.existsSync(filePath)) {
                        log.error(`File not found: ${filePath}`);
                        break;
                    }
                    if (!fs.existsSync(DB_PATH)) initDatabase();

                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const title = data.manuscript?.title || path.basename(filePath, '.json');
                    const paperId = addPaper({ title });
                    importPaperData(paperId, data);
                    log.success(`Imported: ${c.cyan}${paperId}${c.reset}`);
                    break;

                case 'remove':
                case 'archive':
                    const removeId = args[2];
                    if (!removeId) {
                        log.error('Please provide a paper ID');
                        log.info('Usage: paper-review papers remove <paper-id>');
                        break;
                    }
                    removePaper(removeId);
                    log.success(`Archived: ${removeId}`);
                    break;

                case 'open':
                    const openId = args[2];
                    if (!openId) {
                        log.error('Please provide a paper ID');
                        break;
                    }
                    const paper = getPaper(openId);
                    if (!paper) {
                        log.error(`Paper not found: ${openId}`);
                        break;
                    }
                    const url = `http://localhost:3001?paper=${openId}`;
                    openBrowser(url);
                    log.success(`Opened: ${paper.title}`);
                    break;

                default:
                    log.error(`Unknown subcommand: ${subcmd}`);
                    log.info('Available: list, add, import, remove, open');
            }
            break;

        case 'config':
            if (subcmd === 'set') {
                const key = args[2];
                const value = args[3];
                if (!key || value === undefined) {
                    log.error('Usage: reviewflow config set <key> <value>');
                    log.info('Examples:');
                    log.info('  reviewflow config set server.port 3002');
                    log.info('  reviewflow config set ui.theme dark');
                    process.exit(1);
                }
                setConfigValue(key, value);
            } else {
                showConfig();
            }
            break;

        case 'init':
            showBanner();
            log.info('Initializing database...');
            if (initDatabase()) {
                log.success('Database initialized');
            }
            log.info('Installing OpenCode skills...');
            const skillResult = installSkills();
            if (skillResult.installed.length > 0) {
                log.success(`Installed skills: ${skillResult.installed.join(', ')}`);
            }
            if (skillResult.skipped.length > 0) {
                log.info(`Skipped (already exist): ${skillResult.skipped.join(', ')}`);
            }
            log.info('Add a paper: reviewflow papers add');
            break;

        case 'skills':
            showBanner();
            const skillsSubCmd = args[1]; // args[0] is 'skills', args[1] is sub-command
            if (skillsSubCmd === 'install' || skillsSubCmd === 'update') {
                const force = args.includes('--force');
                if (force) {
                    log.warn('Force mode: will overwrite existing skills');
                }
                log.info('Installing OpenCode skills...');
                const result = installSkills(force);
                if (result.installed.length > 0) {
                    log.success(`Installed: ${result.installed.join(', ')}`);
                }
                if (result.skipped.length > 0) {
                    log.info(`Skipped: ${result.skipped.join(', ')}`);
                }
            } else if (skillsSubCmd === 'list') {
                const OPENCODE_SKILL_DIR = path.join(os.homedir(), '.config', 'opencode', 'skill');
                if (fs.existsSync(OPENCODE_SKILL_DIR)) {
                    const skills = fs.readdirSync(OPENCODE_SKILL_DIR, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .map(d => d.name);
                    log.header('Installed OpenCode Skills');
                    skills.forEach(s => console.log(`  ${c.cyan}•${c.reset} ${s}`));
                } else {
                    log.warn('No skills installed');
                }
            } else {
                console.log(`
${c.bold}Skill Commands:${c.reset}
  ${c.cyan}reviewflow skills list${c.reset}              List installed skills
  ${c.cyan}reviewflow skills install${c.reset}           Install package skills
  ${c.cyan}reviewflow skills install --force${c.reset}   Force reinstall (overwrites)
`);
            }
            break;

        case 'help':
        case '-h':
        case '--help':
            showBanner();
            showHelp();
            break;

        default:
            log.error(`Unknown command: ${cmd}`);
            showHelp();
            process.exit(1);
    }
}

main().catch(err => {
    log.error(err.message);
    process.exit(1);
});
