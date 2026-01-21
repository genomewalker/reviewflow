#!/usr/bin/env node
/**
 * OpenCode Server for Review Platform
 *
 * Simple Node.js server that:
 * 1. Watches for requests in claude_requests.json
 * 2. Processes them using `opencode run`
 * 3. Maintains session continuity with --session flag
 * 4. Writes responses to claude_responses.json
 *
 * Usage:
 *   node opencode-server.js        # Watch continuously
 *   node opencode-server.js once   # Process once
 *   node opencode-server.js info   # Show session info
 *   node opencode-server.js reset  # Reset session
 *
 * Configuration (environment variables):
 *   OPENCODE_MODEL   - Model to use (default: openai/gpt-5.2-codex)
 *   OPENCODE_AGENT   - Agent type (default: build)
 *   OPENCODE_VARIANT - Reasoning effort (default: high)
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const mammoth = require('mammoth');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle, ShadingType } = require('docx');

// Generate short UUID for paper IDs
function generatePaperId() {
    return crypto.randomUUID().split('-')[0]; // First 8 chars of UUID
}

// Compute content hash for duplicate detection
function computeFileHash(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

// Convert .docx to text using mammoth
async function docxToText(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value;
    } catch (e) {
        log(`Error converting docx: ${e.message}`, 'ERROR');
        return null;
    }
}

// Read file content as text (converts binary formats)
async function readFileAsText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.docx') {
        return await docxToText(filePath);
    } else if (ext === '.txt' || ext === '.md') {
        return fs.readFileSync(filePath, 'utf-8');
    } else if (ext === '.pdf') {
        // PDF support would need pdf-parse package
        log(`PDF files not yet supported for text extraction: ${filePath}`, 'WARN');
        return null;
    }
    return null;
}

// Paper hash management for duplicate detection (uses database)

// Check if paper already exists with same content hash
function findExistingPaperByHash(manuscriptBuffer) {
    const hash = crypto.createHash('sha256').update(manuscriptBuffer).digest('hex').substring(0, 16);
    if (!db) return { paperId: null, hash };

    try {
        const stmt = db.prepare('SELECT id FROM papers WHERE content_hash = ?');
        const row = stmt.get(hash);
        if (row) {
            log(`Found existing paper with hash ${hash}: ${row.id}`);
            return { paperId: row.id, hash };
        }
    } catch (e) {
        log(`Error checking paper hash: ${e.message}`, 'WARN');
    }
    return { paperId: null, hash };
}

// Register new paper in database
function registerPaper(paperId, hash, metadata = {}) {
    if (!db) return false;

    try {
        const stmt = db.prepare(`
            INSERT INTO papers (id, content_hash, title, journal, field, authors, status)
            VALUES (?, ?, ?, ?, ?, ?, 'uploaded')
        `);
        stmt.run(paperId, hash, metadata.title || '', metadata.journal || '',
                 metadata.field || '', metadata.authors || '');
        log(`Registered paper ${paperId} with hash ${hash}`);
        return true;
    } catch (e) {
        log(`Error registering paper: ${e.message}`, 'ERROR');
        return false;
    }
}

// Restore a soft-deleted paper (clear deleted_at)
function restorePaper(paperId) {
    if (!db) return false;

    try {
        const stmt = db.prepare(`
            UPDATE papers SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        const result = stmt.run(paperId);
        if (result.changes > 0) {
            log(`Restored soft-deleted paper ${paperId}`);
            return true;
        }
        return false;
    } catch (e) {
        log(`Error restoring paper: ${e.message}`, 'ERROR');
        return false;
    }
}

// Update paper metadata after parsing
function updatePaperMetadata(paperId, metadata) {
    if (!db) return false;

    try {
        const stmt = db.prepare(`
            UPDATE papers SET title = ?, journal = ?, field = ?, authors = ?,
                             status = 'parsed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        stmt.run(metadata.title || '', metadata.journal || '',
                 metadata.field || '', metadata.authors || '', paperId);
        return true;
    } catch (e) {
        log(`Error updating paper metadata: ${e.message}`, 'WARN');
        return false;
    }
}

// Store parsed reviewers and comments in database
// Normalize comment ID to ensure consistent format (R1.1, R2.3, etc.)
function normalizeCommentId(id, reviewerNum, commentNum) {
    // Always use position-based IDs (R{reviewerNum}.{commentNum}) for consistency
    // This avoids conflicts where explicit IDs like "R4.4" appear at the wrong position
    // or where IDs like "major"/"minor" get normalized to position-based IDs that conflict
    return `R${reviewerNum}.${commentNum}`;
}

// Extract line references from comment text (e.g., "Line 45", "Lines 97-99", "L45")
function extractLineReferences(text) {
    if (!text) return null;

    const patterns = [
        /[Ll]ines?\s+(\d+)\s*[-–to]+\s*(\d+)/g,  // "Lines 97-99", "Line 97 to 99"
        /[Ll]ines?\s+(\d+)/g,                      // "Line 45", "line 45"
        /[Ll](\d+)/g,                              // "L45"
        /\(lines?\s+(\d+)(?:\s*[-–]\s*(\d+))?\)/gi // "(line 45)" or "(lines 97-99)"
    ];

    const references = [];

    for (const pattern of patterns) {
        let match;
        const regex = new RegExp(pattern.source, pattern.flags);
        while ((match = regex.exec(text)) !== null) {
            const startLine = parseInt(match[1], 10);
            const endLine = match[2] ? parseInt(match[2], 10) : startLine;
            references.push({ start: startLine, end: endLine });
        }
    }

    // Remove duplicates and sort by start line
    const unique = [];
    const seen = new Set();
    for (const ref of references) {
        const key = `${ref.start}-${ref.end}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(ref);
        }
    }

    return unique.length > 0 ? unique.sort((a, b) => a.start - b.start) : null;
}

// Extract text from PDF with line numbers preserved using pdftotext -layout
function extractPdfWithLineNumbers(pdfPath) {
    try {
        const { execSync } = require('child_process');
        const rawText = execSync(`pdftotext -layout "${pdfPath}" -`, {
            encoding: 'utf-8',
            maxBuffer: 50 * 1024 * 1024
        });

        // Parse lines and extract line numbers from the left margin
        // Format: "  102   This is the text content..."
        const lines = rawText.split('\n');
        const numberedLines = {};
        let lastLineNum = 0;

        for (const line of lines) {
            // Match line number at start (with possible leading spaces) followed by text
            // Pattern: optional spaces, 1-4 digit number, at least 2 spaces, then text
            const match = line.match(/^\s*(\d{1,4})\s{2,}(.+)$/);
            if (match) {
                const lineNum = parseInt(match[1], 10);
                const text = match[2].trim();
                // Only accept if line number is sequential (within reasonable range)
                if (lineNum > 0 && lineNum < 10000 && (lineNum > lastLineNum || lineNum === 1)) {
                    numberedLines[lineNum] = text;
                    lastLineNum = lineNum;
                }
            }
        }

        if (Object.keys(numberedLines).length > 50) {
            // Convert to array format for easier access
            const maxLine = Math.max(...Object.keys(numberedLines).map(Number));
            const textArray = [];
            for (let i = 1; i <= maxLine; i++) {
                textArray.push(numberedLines[i] || '');
            }
            log(`[PDF] Extracted ${Object.keys(numberedLines).length} numbered lines from PDF`);
            return textArray.join('\n');
        }

        log(`[PDF] PDF doesn't appear to have standard line numbers, falling back to raw text`);
        return rawText;
    } catch (e) {
        log(`[PDF] Error extracting PDF: ${e.message}`, 'WARN');
        return null;
    }
}

// Find and extract manuscript text, preferring PDFs with line numbers
function extractManuscriptText(paperDir) {
    const fs = require('fs');
    const path = require('path');

    // Priority 1: Look for PDF files (likely have line numbers from journal submission)
    const pdfFiles = [];
    const mdFiles = [];
    const docxFiles = [];

    // Check main paper directory and manuscript subdirectory
    const dirsToCheck = [paperDir, path.join(paperDir, 'manuscript')];

    for (const dir of dirsToCheck) {
        if (!fs.existsSync(dir)) continue;

        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const ext = path.extname(file).toLowerCase();
            const stats = fs.statSync(fullPath);

            if (!stats.isFile()) continue;
            if (file.startsWith('_') || file.startsWith('.')) continue;

            // Prioritize files that look like manuscripts (not supplements/tables)
            const isLikelyManuscript = !file.toLowerCase().includes('sup') &&
                                       !file.toLowerCase().includes('table') &&
                                       !file.toLowerCase().includes('review');

            if (ext === '.pdf' && isLikelyManuscript) {
                pdfFiles.push(fullPath);
            } else if ((ext === '.md' || ext === '.txt') && isLikelyManuscript) {
                mdFiles.push(fullPath);
            } else if ((ext === '.docx' || ext === '.doc') && isLikelyManuscript) {
                docxFiles.push(fullPath);
            }
        }
    }

    // Try PDF first (best for line numbers)
    for (const pdfPath of pdfFiles) {
        const text = extractPdfWithLineNumbers(pdfPath);
        if (text && text.split('\n').length > 100) {
            log(`[Manuscript] Using PDF: ${path.basename(pdfPath)}`);
            return text;
        }
    }

    // Try markdown/text files
    for (const mdPath of mdFiles) {
        try {
            const text = fs.readFileSync(mdPath, 'utf-8');
            if (text.split('\n').length > 100) {
                log(`[Manuscript] Using markdown: ${path.basename(mdPath)}`);
                return text;
            }
        } catch (e) { /* continue */ }
    }

    // Try docx files with pandoc
    for (const docxPath of docxFiles) {
        try {
            const { execSync } = require('child_process');
            const text = execSync(`pandoc -t plain "${docxPath}"`, {
                encoding: 'utf-8',
                maxBuffer: 50 * 1024 * 1024
            });
            if (text.split('\n').length > 100) {
                log(`[Manuscript] Using docx: ${path.basename(docxPath)}`);
                return text;
            }
        } catch (e) { /* continue */ }
    }

    log(`[Manuscript] No suitable manuscript found in ${paperDir}`, 'WARN');
    return null;
}

// Get manuscript lines with context around the referenced lines
function getManuscriptContext(manuscriptText, lineRefs, contextLines = 3) {
    if (!manuscriptText || !lineRefs || lineRefs.length === 0) return null;

    const lines = manuscriptText.split('\n');
    const contexts = [];

    for (const ref of lineRefs) {
        const start = Math.max(0, ref.start - contextLines - 1); // -1 for 0-indexing
        const end = Math.min(lines.length, ref.end + contextLines);

        const contextBlock = {
            reference: ref.start === ref.end ? `Line ${ref.start}` : `Lines ${ref.start}-${ref.end}`,
            startLine: start + 1,
            endLine: end,
            lines: []
        };

        for (let i = start; i < end; i++) {
            const lineNum = i + 1;
            const isReferenced = lineNum >= ref.start && lineNum <= ref.end;
            contextBlock.lines.push({
                number: lineNum,
                text: lines[i] || '',
                highlighted: isReferenced
            });
        }

        contexts.push(contextBlock);
    }

    return contexts;
}

// Format manuscript context for storage (compact text format)
function formatManuscriptContext(contexts) {
    if (!contexts || contexts.length === 0) return null;

    const parts = [];
    for (const ctx of contexts) {
        const header = `[${ctx.reference}]`;
        const body = ctx.lines.map(l => {
            const marker = l.highlighted ? '>>>' : '   ';
            return `${marker} ${l.number}: ${l.text}`;
        }).join('\n');
        parts.push(`${header}\n${body}`);
    }

    return parts.join('\n\n');
}

// Infer priority from comment type and content when AI doesn't provide it
function inferPriority(comment) {
    // If AI provided a valid priority, use it
    if (comment.priority && ['high', 'medium', 'low'].includes(comment.priority.toLowerCase())) {
        return comment.priority.toLowerCase();
    }

    const text = (comment.original_text || '').toLowerCase();
    const type = (comment.type || 'minor').toLowerCase();

    // HIGH priority indicators - fundamental issues that could affect acceptance
    const highIndicators = [
        'unconvinced', 'reject', 'insufficient', 'fundamental', 'critical',
        'cannot accept', 'major concern', 'serious', 'flawed', 'unsupported',
        'not demonstrated', 'lack of evidence', 'must be addressed',
        'strongly recommend', 'essential', 'required analysis', 'tip dating',
        'validation', 'authentication'
    ];

    // LOW priority indicators - cosmetic/minor fixes
    const lowIndicators = [
        'typo', 'formatting', 'citation', 'please cite', 'add version',
        'remove the point', 'line \\d+:', 'please fix', 'should be',
        'change to', 'rephrase', 'unclear what', 'define the acronym',
        'please add', 'please provide', 'what module', 'what version'
    ];

    // Check for high priority
    if (type === 'major') {
        for (const indicator of highIndicators) {
            if (text.includes(indicator)) {
                return 'high';
            }
        }
        // Major comments default to medium
        return 'medium';
    }

    // Check for low priority (minor comments)
    for (const indicator of lowIndicators) {
        if (new RegExp(indicator, 'i').test(text)) {
            return 'low';
        }
    }

    // Minor comments default to low
    if (type === 'minor') {
        return 'low';
    }

    return 'medium';
}

function storeParsedData(paperId, parsedData, manuscriptText = null) {
    if (!db) return false;

    try {
        // Start transaction
        db.exec('BEGIN TRANSACTION');

        // Clear existing data for this paper (in order of foreign key dependencies)
        // First delete from tables that reference comments
        db.prepare('DELETE FROM expert_discussions WHERE comment_id IN (SELECT id FROM comments WHERE paper_id = ?)').run(paperId);
        db.prepare('DELETE FROM version_history WHERE comment_id IN (SELECT id FROM comments WHERE paper_id = ?)').run(paperId);
        db.prepare('DELETE FROM chat_history WHERE paper_id = ?').run(paperId);
        // Then delete comments and reviewers
        db.prepare('DELETE FROM comments WHERE paper_id = ?').run(paperId);
        db.prepare('DELETE FROM reviewers WHERE paper_id = ?').run(paperId);

        // Insert reviewers and their comments
        const insertReviewer = db.prepare(`
            INSERT INTO reviewers (id, paper_id, name, expertise, overall_sentiment, source_file)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertComment = db.prepare(`
            INSERT INTO comments (id, paper_id, reviewer_id, reviewer_name, type, category,
                                  original_text, priority, tags, status, location, full_context)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `);

        const reviewers = parsedData.reviewers || [];
        for (let rIdx = 0; rIdx < reviewers.length; rIdx++) {
            const reviewer = reviewers[rIdx];
            const reviewerNum = rIdx + 1;
            const reviewerId = `${paperId}_${reviewer.id}`;

            // Insert reviewer
            insertReviewer.run(
                reviewerId,
                paperId,
                reviewer.name || 'Unknown Reviewer',
                reviewer.expertise || '',
                reviewer.overall_sentiment || '',
                reviewer.source_file || ''
            );

            // Insert comments
            const comments = reviewer.comments || [];
            for (let cIdx = 0; cIdx < comments.length; cIdx++) {
                const comment = comments[cIdx];
                const normalizedId = normalizeCommentId(comment.id, reviewerNum, cIdx + 1);
                const commentId = `${paperId}_${normalizedId}`;  // Include paperId prefix for unique primary key

                // Extract line references and manuscript context
                let location = null;
                let fullContext = null;
                if (manuscriptText) {
                    const lineRefs = extractLineReferences(comment.original_text);
                    if (lineRefs && lineRefs.length > 0) {
                        // Format location as comma-separated references
                        location = lineRefs.map(r =>
                            r.start === r.end ? `Line ${r.start}` : `Lines ${r.start}-${r.end}`
                        ).join(', ');
                        // Get manuscript context
                        const contexts = getManuscriptContext(manuscriptText, lineRefs, 3);
                        fullContext = formatManuscriptContext(contexts);
                    }
                }

                insertComment.run(
                    commentId,
                    paperId,
                    reviewerId,
                    reviewer.name || 'Unknown Reviewer',
                    comment.type || 'minor',
                    comment.category || 'General',
                    comment.original_text || '',
                    inferPriority(comment),
                    JSON.stringify(comment.tags || []),
                    location,
                    fullContext
                );
            }
        }

        db.exec('COMMIT');

        const totalComments = reviewers.reduce((sum, r) => sum + (r.comments?.length || 0), 0);
        log(`Stored ${reviewers.length} reviewers and ${totalComments} comments for paper ${paperId}`);
        return true;
    } catch (e) {
        db.exec('ROLLBACK');
        log(`Error storing parsed data: ${e.message}`, 'ERROR');
        return false;
    }
}

// Get all papers from database (excluding trashed)
function getPapers() {
    if (!db) return [];

    try {
        const stmt = db.prepare('SELECT * FROM papers WHERE deleted_at IS NULL ORDER BY created_at DESC');
        return stmt.all();
    } catch (e) {
        log(`Error getting papers: ${e.message}`, 'WARN');
        return [];
    }
}

// Get trashed papers
function getTrashPapers() {
    if (!db) return [];

    try {
        const stmt = db.prepare('SELECT * FROM papers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
        return stmt.all();
    } catch (e) {
        log(`Error getting trash papers: ${e.message}`, 'WARN');
        return [];
    }
}

// Get incomplete papers (not in 'complete' status)
function getIncompletePapers() {
    if (!db) return [];

    try {
        const stmt = db.prepare(`
            SELECT * FROM papers
            WHERE status NOT IN ('complete', 'parsed')
            ORDER BY created_at DESC
        `);
        return stmt.all();
    } catch (e) {
        log(`Error getting incomplete papers: ${e.message}`, 'WARN');
        return [];
    }
}

// Update paper status
function updatePaperStatus(paperId, status, errorMsg = null) {
    if (!db) return false;

    try {
        if (errorMsg) {
            const stmt = db.prepare(`
                UPDATE papers SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            stmt.run(status, errorMsg, paperId);
        } else {
            const stmt = db.prepare(`
                UPDATE papers SET status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            stmt.run(status, paperId);
        }
        log(`Updated paper ${paperId} status to: ${status}`);
        return true;
    } catch (e) {
        log(`Error updating paper status: ${e.message}`, 'WARN');
        return false;
    }
}

// Delete paper from database and filesystem
function deletePaper(paperId) {
    if (!db) return { success: false, error: 'Database not initialized' };

    try {
        // Get paper info first
        const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);
        if (!paper) {
            return { success: false, error: 'Paper not found' };
        }

        // Soft delete - set deleted_at timestamp instead of actually deleting
        db.prepare("UPDATE papers SET deleted_at = datetime('now') WHERE id = ?").run(paperId);

        log(`Soft-deleted paper: ${paperId}`);
        return { success: true, soft_deleted: true };
    } catch (e) {
        log(`Error deleting paper: ${e.message}`, 'ERROR');
        return { success: false, error: e.message };
    }
}

// Restore a soft-deleted paper
function restorePaper(paperId) {
    if (!db) throw new Error('Database not initialized');

    try {
        const paper = db.prepare('SELECT * FROM papers WHERE id = ? AND deleted_at IS NOT NULL').get(paperId);
        if (!paper) {
            return { success: false, error: 'Paper not found in trash' };
        }

        db.prepare('UPDATE papers SET deleted_at = NULL WHERE id = ?').run(paperId);
        log(`Restored paper: ${paperId}`);
        return { success: true };
    } catch (e) {
        log(`Error restoring paper: ${e.message}`, 'ERROR');
        return { success: false, error: e.message };
    }
}

// Permanently delete a paper (from trash)
function permanentlyDeletePaper(paperId) {
    if (!db) throw new Error('Database not initialized');

    try {
        const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);
        if (!paper) {
            return { success: false, error: 'Paper not found' };
        }

        // Hard delete from database (delete related records first, ignore if tables don't exist)
        const safeDelete = (table, column = 'paper_id') => {
            try { db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(paperId); }
            catch (e) { /* table might not exist */ }
        };

        safeDelete('comments');
        safeDelete('version_history');
        safeDelete('reviewers');
        safeDelete('suggested_experts');
        safeDelete('processing_jobs');
        safeDelete('expert_insights');
        safeDelete('chat_history');

        // Delete the paper itself
        db.prepare('DELETE FROM papers WHERE id = ?').run(paperId);

        // Delete files from filesystem
        const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);
        if (fs.existsSync(paperDir)) {
            fs.rmSync(paperDir, { recursive: true, force: true });
            log(`Deleted paper directory: ${paperDir}`);
        }

        log(`Permanently deleted paper: ${paperId}`);
        return { success: true };
    } catch (e) {
        log(`Error permanently deleting paper: ${e.message}`, 'ERROR');
        return { success: false, error: e.message };
    }
}

// Get trashed papers
function getTrashedPapers() {
    if (!db) return [];

    try {
        return db.prepare('SELECT * FROM papers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
    } catch (e) {
        log(`Error getting trashed papers: ${e.message}`, 'ERROR');
        return [];
    }
}

// Load better-sqlite3 - required dependency
const Database = require('better-sqlite3');
let db;

// Configuration
const BASE_DIR = __dirname;

// Load project folder from platform config (same as cli.js)
function loadPlatformConfig() {
    const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.config', 'rebuttr', 'config.json');
    const LOCAL_CONFIG_PATH = path.join(BASE_DIR, 'platform-config.json');
    let config = {};

    // Try global config first
    if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
        try {
            config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
        } catch (e) { /* ignore */ }
    }

    // Fall back to local config
    if (!config.projectFolder && fs.existsSync(LOCAL_CONFIG_PATH)) {
        try {
            const localConfig = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
            config = { ...localConfig, ...config };
        } catch (e) { /* ignore */ }
    }

    return config;
}

const PLATFORM_CONFIG = loadPlatformConfig();
const PROJECT_FOLDER = PLATFORM_CONFIG.projectFolder || path.join(os.homedir(), 'Rebuttr');

const DB_FILE = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
const REQUESTS_FILE = path.join(BASE_DIR, 'claude_requests.json');
const RESPONSES_FILE = path.join(BASE_DIR, 'claude_responses.json');
const SESSION_FILE = path.join(BASE_DIR, 'opencode_session.json');
const CONFIG_FILE = path.join(BASE_DIR, 'opencode-config.json');
const LOG_FILE = path.join(BASE_DIR, 'opencode_server.log');

// Parsing lock to prevent duplicate parallel parsing of the same paper
const parsingLocks = new Map();  // paperId -> { timestamp, promise }

// Load config from file (re-read each time to pick up UI changes)
function loadConfig() {
    const defaults = {
        model: 'openai/gpt-5.2-codex',
        agent: 'build',
        variant: 'high'
    };

    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            return {
                model: config.model || defaults.model,
                agent: config.agent || defaults.agent,
                variant: config.variant || defaults.variant,
                available_models: config.available_models || [],
                available_agents: config.available_agents || [],
                available_variants: config.available_variants || []
            };
        }
    } catch (e) {
        log(`Error loading config: ${e.message}`, 'ERROR');
    }

    return defaults;
}

// OpenCode settings (can be overridden by env vars)
function getSettings() {
    const config = loadConfig();
    return {
        model: process.env.OPENCODE_MODEL || config.model,
        agent: process.env.OPENCODE_AGENT || config.agent,
        variant: process.env.OPENCODE_VARIANT || config.variant
    };
}

// Find opencode binary
function findOpencode() {
    const paths = [
        '/opt/homebrew/bin/opencode',
        path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
        '/usr/local/bin/opencode',
        '/usr/bin/opencode',
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }

    // Try which
    try {
        const which = execSync('which opencode', { encoding: 'utf-8' }).trim();
        if (which) return which;
    } catch (e) {}

    return null;
}

const OPENCODE_BIN = findOpencode();

// Logging
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const line = `[${timestamp}] [${level}] ${message}`;
    console.log(line);
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (e) {}
}

// JSON helpers
function loadJSON(filepath) {
    try {
        if (fs.existsSync(filepath)) {
            return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        }
    } catch (e) {
        log(`Error loading ${filepath}: ${e.message}`, 'ERROR');
    }
    return filepath.includes('requests') ? [] : {};
}

function saveJSON(filepath, data) {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// =====================================================
// SQLite DATABASE LAYER WITH MIGRATIONS
// =====================================================

// Current schema version
const SCHEMA_VERSION = 14;

// Migration definitions - each adds new features
const MIGRATIONS = {
    // Version 1: Initial schema
    1: {
        description: 'Initial schema with comments, papers, chat history',
        up: `
            -- Comments table
            CREATE TABLE IF NOT EXISTS comments (
                id TEXT PRIMARY KEY,
                paper_id TEXT,
                reviewer_id TEXT NOT NULL,
                reviewer_name TEXT,
                type TEXT DEFAULT 'minor',
                category TEXT,
                original_text TEXT NOT NULL,
                full_context TEXT,
                draft_response TEXT,
                status TEXT DEFAULT 'pending',
                priority TEXT DEFAULT 'medium',
                location TEXT,
                requires_new_analysis INTEGER DEFAULT 0,
                tags TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- Add paper_id column if missing (migration for existing databases)
            -- This is handled via a try-catch in the initialization code

            -- Expert discussions table
            CREATE TABLE IF NOT EXISTS expert_discussions (
                comment_id TEXT PRIMARY KEY,
                experts TEXT,
                recommended_response TEXT,
                advice_to_author TEXT,
                regenerated_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (comment_id) REFERENCES comments(id)
            );

            -- Chat history table
            CREATE TABLE IF NOT EXISTS chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id TEXT,
                comment_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Session state table
            CREATE TABLE IF NOT EXISTS app_state (
                paper_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value JSON,
                PRIMARY KEY (paper_id, key)
            );

            -- Settings table
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value JSON
            );

            -- Version history table for tracking changes to comments
            CREATE TABLE IF NOT EXISTS version_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                comment_id TEXT NOT NULL,
                paper_id TEXT,
                field_name TEXT NOT NULL,
                old_value TEXT,
                new_value TEXT,
                change_type TEXT DEFAULT 'edit',
                source TEXT DEFAULT 'user',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (comment_id) REFERENCES comments(id)
            );

            -- Papers table
            CREATE TABLE IF NOT EXISTS papers (
                id TEXT PRIMARY KEY,
                content_hash TEXT,
                title TEXT,
                journal TEXT,
                field TEXT,
                authors TEXT,
                status TEXT DEFAULT 'uploaded',
                deleted_at TEXT DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- Indexes
            CREATE INDEX IF NOT EXISTS idx_comments_reviewer ON comments(reviewer_id);
            CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
            CREATE INDEX IF NOT EXISTS idx_comments_category ON comments(category);
            CREATE INDEX IF NOT EXISTS idx_chat_paper ON chat_history(paper_id);
            CREATE INDEX IF NOT EXISTS idx_version_history_comment ON version_history(comment_id);
            CREATE INDEX IF NOT EXISTS idx_version_history_paper ON version_history(paper_id);
        `
    },
    // Version 2: Add sessions table and papers.content_hash index
    2: {
        description: 'Add sessions table for OpenCode session persistence',
        up: `
            -- Sessions table for OpenCode session persistence
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY DEFAULT 'default',
                opencode_session_id TEXT,
                model TEXT,
                agent TEXT,
                variant TEXT,
                messages JSON DEFAULT '[]',
                paper_id TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- Add index on papers.content_hash if not exists
            CREATE INDEX IF NOT EXISTS idx_papers_hash ON papers(content_hash);
        `
    },
    // Version 3: Add tags column to comments table (skipped - already in v1)
    3: {
        description: 'Add tags column to comments table',
        up: `SELECT 1;`
    },
    // Version 4: Add error_message column to papers table (skipped - handled in v1)
    4: {
        description: 'Add error_message column to papers table',
        up: `SELECT 1;`
    },
    // Version 5: Add deleted_at column (skipped - already in v1)
    5: {
        description: 'Add deleted_at column to papers table for trash functionality',
        up: `SELECT 1;`
    },
    // Version 6: Add missing columns (skipped - already in v1)
    6: {
        description: 'Add reviewer_name and sort_order to comments',
        up: `SELECT 1;`
    },
    // Version 7: Add processing_jobs table for background processing
    7: {
        description: 'Add processing_jobs table for background job tracking',
        up: `
            CREATE TABLE IF NOT EXISTS processing_jobs (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                progress INTEGER DEFAULT 0,
                current_step TEXT,
                total_steps INTEGER DEFAULT 0,
                current_file TEXT,
                logs TEXT DEFAULT '[]',
                error TEXT,
                started_at TEXT,
                completed_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (paper_id) REFERENCES papers(id)
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_paper ON processing_jobs(paper_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_status ON processing_jobs(status);
        `
    },
    // Version 8: Add error_message column to papers table
    8: {
        description: 'Add error_message column to papers table',
        up: `ALTER TABLE papers ADD COLUMN error_message TEXT DEFAULT NULL;`
    },
    // Version 9: Add reviewers table for storing parsed reviewer data
    9: {
        description: 'Add reviewers table',
        up: `
            CREATE TABLE IF NOT EXISTS reviewers (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL,
                name TEXT NOT NULL,
                expertise TEXT,
                overall_sentiment TEXT,
                source_file TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_reviewers_paper ON reviewers(paper_id);
        `
    },
    10: {
        description: 'Add description, review_date, and config columns to papers table',
        up: `
            ALTER TABLE papers ADD COLUMN description TEXT DEFAULT '';
            ALTER TABLE papers ADD COLUMN review_date TEXT;
            ALTER TABLE papers ADD COLUMN config TEXT DEFAULT '{}';
        `
    },
    11: {
        description: 'Add overall_assessment column to reviewers table',
        up: `
            ALTER TABLE reviewers ADD COLUMN overall_assessment TEXT;
        `
    },
    12: {
        description: 'Add suggested_experts table for two-stage expert workflow',
        up: `
            CREATE TABLE IF NOT EXISTS suggested_experts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id TEXT NOT NULL,
                name TEXT NOT NULL,
                icon TEXT DEFAULT 'user',
                color TEXT DEFAULT 'blue',
                expertise TEXT DEFAULT '[]',
                comment_types TEXT DEFAULT '[]',
                description TEXT,
                is_custom INTEGER DEFAULT 0,
                is_confirmed INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_suggested_experts_paper ON suggested_experts(paper_id);

            -- Add awaiting_expert_review status support to papers
            -- status can now be: uploaded, parsing, awaiting_expert_review, processing_experts, parsed, error
        `
    },
    13: {
        description: 'Add worker_sessions table for file-based AI worker network',
        up: `
            CREATE TABLE IF NOT EXISTS worker_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_path TEXT,
                file_category TEXT,
                session_id TEXT,
                inventory TEXT,
                status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                last_used_at TEXT,
                FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_worker_sessions_paper ON worker_sessions(paper_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_sessions_file ON worker_sessions(paper_id, file_name);
        `
    },
    14: {
        description: 'Add potential_solutions column to expert_discussions',
        up: `
            ALTER TABLE expert_discussions ADD COLUMN potential_solutions TEXT DEFAULT '[]';
        `
    }
};

// Get current schema version from database
function getSchemaVersion() {
    try {
        // Check if schema_version table exists
        const tableExists = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'
        `).get();

        if (!tableExists) {
            // Create schema_version table
            db.exec(`
                CREATE TABLE schema_version (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    description TEXT
                )
            `);

            // Check if this is an existing database (has tables from v1)
            const hasComments = db.prepare(`
                SELECT name FROM sqlite_master WHERE type='table' AND name='comments'
            `).get();

            if (hasComments) {
                // Existing database - assume v1 schema is already in place
                log('Detected existing database, marking as version 1');
                db.prepare(`
                    INSERT INTO schema_version (version, description)
                    VALUES (1, 'Initial schema (detected existing)')
                `).run();
                return 1;
            }

            return 0;
        }

        const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get();
        return row?.version || 0;
    } catch (e) {
        log(`Error getting schema version: ${e.message}`, 'WARN');
        return 0;
    }
}

// Run pending migrations
function runMigrations() {
    const currentVersion = getSchemaVersion();
    log(`Current database schema version: ${currentVersion}`);

    if (currentVersion >= SCHEMA_VERSION) {
        log('Database schema is up to date');
        return true;
    }

    log(`Upgrading database from version ${currentVersion} to ${SCHEMA_VERSION}...`);

    try {
        for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
            const migration = MIGRATIONS[v];
            if (!migration) {
                log(`Missing migration for version ${v}`, 'ERROR');
                return false;
            }

            log(`Applying migration ${v}: ${migration.description}`);
            db.exec(migration.up);

            // Record migration
            db.prepare(`
                INSERT INTO schema_version (version, description)
                VALUES (?, ?)
            `).run(v, migration.description);

            log(`Migration ${v} applied successfully`);
        }

        log(`Database upgraded to version ${SCHEMA_VERSION}`);
        return true;
    } catch (e) {
        log(`Error running migrations: ${e.message}`, 'ERROR');
        return false;
    }
}

function initDatabase() {
    try {
        // Ensure data directory exists
        const dataDir = path.dirname(DB_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        db = new Database(DB_FILE);
        log(`SQLite database initialized: ${DB_FILE}`);

        // Run migrations
        if (!runMigrations()) {
            throw new Error('Database migrations failed');
        }

        log('Database tables created/verified');
        log(`SQLite database ready`);
        return true;
    } catch (e) {
        log(`Error initializing database: ${e.message}`, 'ERROR');
        return false;
    }
}

// Save all comments to database (with optional paper_id filtering)
function saveCommentsToDB(reviewData, paperId = null) {
    if (!db) throw new Error('Database not initialized');

    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO comments
            (id, paper_id, reviewer_id, reviewer_name, type, category, original_text, full_context,
             draft_response, status, priority, location, requires_new_analysis, tags, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);

        const transaction = db.transaction((reviewers) => {
            let sortOrder = 0;
            for (const reviewer of reviewers) {
                // Ensure reviewer ID has paper prefix
                const reviewerId = paperId && !reviewer.id.startsWith(`${paperId}_`)
                    ? `${paperId}_${reviewer.id}`
                    : reviewer.id;

                for (const comment of reviewer.comments) {
                    // Ensure comment ID has paper prefix
                    const commentId = paperId && !comment.id.startsWith(`${paperId}_`)
                        ? `${paperId}_${comment.id}`
                        : comment.id;

                    // Convert tags array to comma-separated string
                    const tagsStr = Array.isArray(comment.tags) ? comment.tags.join(',') : (comment.tags || '');
                    stmt.run(
                        commentId,
                        paperId,
                        reviewerId,
                        reviewer.name,
                        comment.type || 'minor',
                        comment.category || '',
                        comment.original_text || '',
                        comment.full_context || '',
                        comment.draft_response || '',
                        comment.status || 'pending',
                        comment.priority || 'medium',
                        comment.location || '',
                        comment.requires_new_analysis ? 1 : 0,
                        tagsStr,
                        comment.sort_order ?? sortOrder++
                    );
                }
            }
        });

        transaction(reviewData.reviewers || []);
        log(`Saved ${reviewData.reviewers?.reduce((acc, r) => acc + r.comments.length, 0) || 0} comments to database${paperId ? ` for paper ${paperId}` : ''}`);
        return true;
    } catch (e) {
        log(`Error saving comments to DB: ${e.message}`, 'ERROR');
        return false;
    }
}

// Load comments from database (with optional paper_id filtering)
function loadCommentsFromDB(paperId = null) {
    if (!db) throw new Error('Database not initialized');

    try {
        let comments;
        if (paperId) {
            comments = db.prepare('SELECT * FROM comments WHERE paper_id = ? ORDER BY sort_order, id').all(paperId);
        } else {
            comments = db.prepare('SELECT * FROM comments ORDER BY sort_order, id').all();
        }

        // Group by reviewer
        const reviewerMap = {};
        for (const c of comments) {
            if (!reviewerMap[c.reviewer_id]) {
                reviewerMap[c.reviewer_id] = {
                    id: c.reviewer_id,
                    name: c.reviewer_name,
                    comments: []
                };
            }
            reviewerMap[c.reviewer_id].comments.push({
                id: c.id,
                type: c.type,
                category: c.category,
                original_text: c.original_text,
                full_context: c.full_context,
                draft_response: c.draft_response,
                status: c.status,
                priority: c.priority,
                location: c.location,
                requires_new_analysis: c.requires_new_analysis === 1,
                tags: c.tags ? c.tags.split(',').filter(t => t) : [],
                sort_order: c.sort_order || 0
            });
        }

        return {
            reviewers: Object.values(reviewerMap)
        };
    } catch (e) {
        log(`Error loading comments from DB: ${e.message}`, 'ERROR');
        return null;
    }
}

// Save expert discussion to database
function saveExpertToDB(commentId, expertData) {
    if (!db) throw new Error('Database not initialized');

    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO expert_discussions
            (comment_id, experts, recommended_response, advice_to_author, potential_solutions, regenerated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `);

        stmt.run(
            commentId,
            JSON.stringify(expertData.experts || []),
            expertData.recommended_response || '',
            expertData.advice_to_author || '',
            JSON.stringify(expertData.potential_solutions || [])
        );

        log(`Saved expert discussion for ${commentId}`);
        return true;
    } catch (e) {
        log(`Error saving expert to DB: ${e.message}`, 'ERROR');
        return false;
    }
}

// Load all expert discussions from database
function loadExpertsFromDB(paperId = null) {
    if (!db) throw new Error('Database not initialized');

    try {
        // Load paper-level experts from suggested_experts table
        let paperExperts = [];
        if (paperId) {
            try {
                const expertRows = db.prepare(`
                    SELECT name, icon, color, expertise, comment_types, description
                    FROM suggested_experts
                    WHERE paper_id = ? AND is_confirmed = 1
                    ORDER BY id
                `).all(paperId);

                paperExperts = expertRows.map(row => ({
                    name: row.name,
                    icon: row.icon || 'user-graduate',
                    color: row.color || 'blue',
                    expertise: JSON.parse(row.expertise || '[]'),
                    comment_types: JSON.parse(row.comment_types || '[]'),
                    description: row.description || ''
                }));
            } catch (tableErr) {
                // Table might not exist yet - that's OK
                log(`suggested_experts table not available: ${tableErr.message}`, 'DEBUG');
            }
        }

        // Join expert_discussions with comments to get full context
        // Comment IDs in expert_discussions now have paper prefix like "14464bea_R1.1"
        const rows = db.prepare(`
            SELECT
                e.comment_id,
                e.experts,
                e.recommended_response,
                e.advice_to_author,
                e.potential_solutions,
                e.regenerated_at,
                c.type,
                c.priority,
                c.category,
                c.original_text as reviewer_comment
            FROM expert_discussions e
            LEFT JOIN comments c ON c.id = e.comment_id
        `).all();
        const discussions = {};

        for (const row of rows) {
            let potential_solutions = JSON.parse(row.potential_solutions || '[]');

            // Create fallback potential_solutions if empty
            if (!potential_solutions || potential_solutions.length === 0) {
                potential_solutions = [
                    "Addressed reviewer concern in revised manuscript",
                    "Added clarification to relevant section",
                    "Updated figures/tables as needed"
                ];
            }

            // Strip paper prefix from comment_id for webapp compatibility
            // DB has "14464bea_R1.1" but webapp uses "R1.1"
            const shortId = row.comment_id.replace(/^[a-f0-9]+_/, '');
            discussions[shortId] = {
                experts: JSON.parse(row.experts || '[]'),
                recommended_response: row.recommended_response,
                advice_to_author: row.advice_to_author,
                potential_solutions: potential_solutions,
                regenerated_at: row.regenerated_at,
                type: row.type || 'minor',
                priority: row.priority || 'medium',
                category: row.category || 'General',
                reviewer_comment: row.reviewer_comment || ''
            };
        }

        // Return both paper-level experts and per-comment discussions
        return {
            experts: paperExperts.length > 0 ? paperExperts : undefined,
            expert_discussions: discussions
        };
    } catch (e) {
        log(`Error loading experts from DB: ${e.message}`, 'ERROR');
        return null;
    }
}

// =====================================================
// DYNAMIC EXPERT GENERATION (within OpenCode session)
// =====================================================

// Generate dynamic expert personas using OpenCode's loaded paper context
async function generateDynamicExperts(cwd, modelToUse, agentToUse, variantToUse, sessionId, contextFiles = []) {
    // Attach all context files directly - no session context needed
    log(`[generateDynamicExperts] Attaching ${contextFiles.length} files for context`);

    // This prompt references the paper data from attached files
    const prompt = `Based on the attached manuscript, supplementary data, and reviewer comments, identify 3-4 domain experts who would be most qualified to evaluate the reviewer comments.

Consider the paper's:
- Research field and methodology
- Key scientific claims and evidence
- Technical areas requiring specialized knowledge
- Types of concerns raised by reviewers

For each expert, provide:
1. A specific expert title relevant to THIS paper (e.g., "Ancient DNA Authentication Specialist", not generic "Methodology Expert")
2. Their core expertise areas (3-5 bullet points) specific to what's needed for this paper
3. What types of reviewer comments they're best suited to address
4. An icon identifier (dna, microscope, chart-line, flask, bacteria, leaf, globe, database, code, chart-bar)
5. A color scheme (blue, green, purple, amber, red, teal, indigo, emerald)

Return ONLY a JSON array, no other text:
[
  {
    "name": "Ancient DNA Authentication Specialist",
    "icon": "icon-name",
    "color": "color-name",
    "expertise": ["specific area 1", "specific area 2", "specific area 3"],
    "comment_types": ["methodology", "interpretation", "data-analysis"]
  }
]

IMPORTANT: Do NOT use "Dr." prefix - just use the expert title directly (e.g., "Microbial Ecologist" not "Dr. Microbial Ecologist").

CRITICAL: Generate the JSON output IMMEDIATELY. Do NOT:
- Ask clarifying questions
- Request more information
- Enter planning mode
- Propose a plan before acting
- Say "I'll analyze..." or "Let me review..."
Just output the JSON array directly.`;

    try {
        const result = await runOpencode({
            message: prompt,
            files: contextFiles, // Attach all files directly
            model: modelToUse,
            agent: agentToUse,
            variant: variantToUse,
            timeout: 120000,
            cwd: cwd
            // NO session ID - fresh context prevents AI asking questions
        });

        if (result.output) {
            const jsonMatch = result.output.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                return { experts: JSON.parse(jsonMatch[0]), sessionId: result.sessionId };
            }
        }
        return { experts: null, sessionId: result.sessionId };
    } catch (e) {
        log(`Error generating dynamic experts: ${e.message}`, 'ERROR');
        return { experts: null, sessionId };
    }
}

// Generate expert analysis for a single comment (uses OpenCode session with paper context)
// Now supports worker network: if workerInventory is provided, include it in context
async function generateExpertAnalysisForComment(comment, experts, cwd, modelToUse, agentToUse, variantToUse, sessionId, paperContext = null, contextFiles = [], workerInventory = null) {
    const expertDescriptions = experts.map(e => `- ${e.name}: ${e.expertise.join(', ')}`).join('\n');

    // Include paper context if provided (for parallel processing without shared session)
    let contextSection = '';
    if (paperContext) {
        contextSection = `
PAPER CONTEXT (use this to reference specific data):
${paperContext}

`;
    }

    // Note about attached files
    const hasContextFiles = contextFiles && contextFiles.length > 0;
    const filesNote = hasContextFiles
        ? `\nATTACHED FILES: The manuscript and supplementary data files are attached. Use them to cite specific tables, figures, and data when answering.\n`
        : '';

    // Note about worker sessions for large supplementary data
    let workerNote = '';
    if (workerInventory) {
        workerNote = `
SUPPLEMENTARY DATA ACCESS:
Large supplementary files are loaded in dedicated worker sessions. Here's what's available:
${workerInventory}
Note: The main manuscript and review files are attached directly. Use the data inventories above for reference.
`;
    }

    // Build expert template for JSON
    const expertTemplate = experts.map(e =>
        `{"name":"${e.name}","verdict":"...","assessment":"...","recommendation":"..."}`
    ).join(',');

    const prompt = `TASK: Analyze reviewer comment and provide solutions. OUTPUT: JSON only (no other text before or after).

CRITICAL: Generate JSON IMMEDIATELY. Do NOT ask questions, request clarification, or enter planning mode. Just analyze and output JSON.
${contextSection}${filesNote}${workerNote}
EXPERTS: ${experts.map(e => `${e.name} (${e.expertise.slice(0,2).join(', ')})`).join('; ')}

COMMENT [${comment.id}]: "${comment.original_text || comment.text}"

verdict options: "Valid concern" | "Addressable" | "Already addressed" | "Minor issue"

CRITICAL RULES:
1. Use PAST TENSE everywhere (describing what was done in the revision).
   - WRONG: "We will expand..." / "Add more details..."
   - CORRECT: "We have expanded..." / "We added..."

2. MANDATORY: potential_solutions = Array of 3-5 SHORT action items (one sentence each).
   - These are actionable tasks the author can check off as completed
   - Each item should be a short sentence describing what was done
   - Examples: "Added damage plots to Supplementary Figure S3", "Clarified authentication criteria in Methods", "Revised terminology throughout manuscript"
   - DO NOT write full paragraphs - keep each item under 15 words

3. recommended_response = The full formal response text to send to reviewers (2-4 paragraphs, past tense)

4. advice_to_author = INTERNAL NOTES for the author (what to actually change in manuscript)
   - Example: "Add 2-3 sentences in Methods about sample preservation. Update Table S1 with..."
   - This is NOT shown to reviewers - it's guidance for revising the paper

5. NEVER use camelCase phrases like "KeyInsight", "CoreFinding", "MainPoint" - write normally.

REQUIRED OUTPUT FORMAT (all fields are mandatory):
{
  "experts":[${expertTemplate}],
  "potential_solutions":[
    "Added damage analysis to Supplementary Figure",
    "Clarified methodology in Methods section",
    "Expanded discussion of limitations"
  ],
  "recommended_response":"...",
  "advice_to_author":"..."
}`;

    try {
        const result = await runOpencode({
            message: prompt,
            files: contextFiles, // Attach context files for full context
            model: modelToUse,
            agent: agentToUse,
            variant: variantToUse,
            timeout: 180000,
            cwd: cwd
            // NO session ID - fresh context prevents AI asking questions
        });

        if (result.output) {
            log(`[Expert] Got ${result.output.length} chars for ${comment.id}`);
            const jsonMatch = result.output.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const analysis = JSON.parse(jsonMatch[0]);

                    // Ensure potential_solutions exists - create fallback if AI didn't generate it
                    if (!analysis.potential_solutions || analysis.potential_solutions.length === 0) {
                        log(`[Expert] No potential_solutions in response for ${comment.id}, creating fallback`);
                        // Generate basic action items based on comment type/category
                        analysis.potential_solutions = [
                            "Addressed reviewer concern in revised manuscript",
                            "Added clarification to Methods section",
                            "Updated relevant figures/tables"
                        ];
                    }

                    log(`[Expert] Parsed OK for ${comment.id}: ${analysis.experts?.length || 0} experts, ${analysis.potential_solutions?.length || 0} solutions`);
                    return {
                        ...analysis,
                        reviewer_comment: comment.original_text || comment.text,
                        priority: comment.priority,
                        type: comment.type,
                        category: comment.category
                    };
                } catch (parseErr) {
                    log(`JSON parse error for ${comment.id}: ${parseErr.message}`, 'WARN');
                    log(`[Expert] Raw JSON attempt: ${jsonMatch[0].substring(0, 200)}...`, 'WARN');
                }
            } else {
                log(`No JSON found in expert response for ${comment.id}`, 'WARN');
                log(`[Expert] Raw output: ${result.output.substring(0, 300)}...`, 'WARN');
            }
        } else {
            log(`Empty output from expert analysis for ${comment.id}`, 'WARN');
        }
        return null;  // Return null so caller knows it failed
    } catch (e) {
        log(`Error generating expert analysis for ${comment.id}: ${e.message}`, 'ERROR');
        return null;  // Return null so caller knows it failed
    }
}

// Generate expert insights for all comments in a paper (uses existing OpenCode session)
async function generateAllExpertInsights(paperId, parsed, paperDir, modelToUse, agentToUse, variantToUse, onProgress, existingSessionId) {
    const paperMeta = parsed.paper || parsed.metadata || {};
    const paperField = paperMeta.field || 'scientific research';

    onProgress?.({ step: 'generating_experts', log: 'Generating domain-specific expert panel based on paper content...' });

    // Step 1: Generate dynamic experts using the OpenCode session that has paper context
    const expertResult = await generateDynamicExperts(
        paperDir, modelToUse, agentToUse, variantToUse, existingSessionId
    );

    let sessionId = expertResult.sessionId || existingSessionId;
    const experts = expertResult.experts;

    if (!experts || experts.length === 0) {
        log('Failed to generate dynamic experts', 'WARN');
        return { generated: false, reason: 'Could not generate dynamic experts', sessionId };
    }

    log(`Generated ${experts.length} domain experts: ${experts.map(e => e.name).join(', ')}`);
    onProgress?.({ log: `Expert panel: ${experts.map(e => e.name).join(', ')}` });

    // Step 2: Create skill files for the generated experts
    const skillsDir = path.join(paperDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    for (const expert of experts) {
        const skillDir = path.join(skillsDir, expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        fs.mkdirSync(skillDir, { recursive: true });

        const skillContent = `---
name: ${expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
description: ${expert.name} - Expert for ${paperField}
---

# ${expert.name}

## Core Expertise
${expert.expertise.map(e => `- ${e}`).join('\n')}

## Comment Types
Best suited for: ${expert.comment_types?.join(', ') || 'general comments'}
`;
        fs.writeFileSync(path.join(skillDir, 'skill.md'), skillContent);
    }
    log(`Created ${experts.length} skill files in ${skillsDir}`);

    // Step 3: Generate expert analysis for each comment
    const allComments = [];
    let reviewerNum = 0;
    for (const reviewer of (parsed.reviewers || [])) {
        reviewerNum++;
        let commentNum = 0;
        for (const comment of (reviewer.comments || [])) {
            commentNum++;
            const normalizedId = normalizeCommentId(comment.id, reviewerNum, commentNum);
            const dbCommentId = `${paperId}_${normalizedId}`;
            allComments.push({
                ...comment,
                id: normalizedId,
                db_id: dbCommentId,
                reviewer_name: reviewer.name,
                reviewer_id: reviewer.id
            });
        }
    }

    const totalComments = allComments.length;
    let processedComments = 0;
    const expertDiscussions = {};

    onProgress?.({
        step: 'analyzing_comments',
        log: `Generating expert insights for ${totalComments} comments...`,
        progress: 85
    });

    for (const comment of allComments) {
        processedComments++;
        const progressPct = 85 + Math.round((processedComments / totalComments) * 14);

        onProgress?.({
            log: `[${processedComments}/${totalComments}] Analyzing ${comment.id}...`,
            progress: progressPct
        });

        const analysis = await generateExpertAnalysisForComment(
            comment, experts,
            paperDir, modelToUse, agentToUse, variantToUse, sessionId
        );

        // Update sessionId if returned
        if (analysis.sessionId) {
            sessionId = analysis.sessionId;
        }

        if (analysis.experts) {
            expertDiscussions[comment.db_id || comment.id] = analysis;

            // Save to database
            saveExpertToDB(comment.db_id || comment.id, analysis);
        }

        // Small delay to avoid overwhelming the API
        await new Promise(r => setTimeout(r, 200));
    }

    // Save expert discussions to file
    const expertData = {
        generated: new Date().toISOString(),
        paper_id: paperId,
        experts: experts,
        expert_discussions: expertDiscussions
    };

    fs.writeFileSync(
        path.join(paperDir, 'expert_discussions.json'),
        JSON.stringify(expertData, null, 2)
    );

    onProgress?.({ log: `Expert insights generated for ${Object.keys(expertDiscussions).length} comments` });

    return {
        generated: true,
        experts: experts,
        discussions_count: Object.keys(expertDiscussions).length,
        sessionId
    };
}

// Save chat message to database (uses paper_id/comment_id schema from cli.js)
function saveChatMessageToDB(paperId, role, content, commentId = null) {
    if (!db) throw new Error('Database not initialized');

    try {
        const stmt = db.prepare(`
            INSERT INTO chat_history (paper_id, comment_id, role, content)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(paperId, commentId, role, content);
        return true;
    } catch (e) {
        log(`Error saving chat message: ${e.message}`, 'ERROR');
        return false;
    }
}

// Load chat history from database
function loadChatHistoryFromDB(paperId) {
    if (!db) throw new Error('Database not initialized');

    try {
        return db.prepare(`
            SELECT * FROM chat_history
            WHERE paper_id = ?
            ORDER BY timestamp ASC
        `).all(paperId);
    } catch (e) {
        log(`Error loading chat history: ${e.message}`, 'ERROR');
        return [];
    }
}

// Save/load app state (uses paper_id/key schema from cli.js)
function saveAppState(paperId, key, value) {
    if (!db) throw new Error('Database not initialized');

    try {
        db.prepare(`
            INSERT OR REPLACE INTO app_state (paper_id, key, value)
            VALUES (?, ?, ?)
        `).run(paperId, key, typeof value === 'string' ? value : JSON.stringify(value));
        return true;
    } catch (e) {
        log(`Error saving app state: ${e.message}`, 'ERROR');
        return false;
    }
}

function loadAppState(paperId, key) {
    if (!db) throw new Error('Database not initialized');

    try {
        const row = db.prepare('SELECT value FROM app_state WHERE paper_id = ? AND key = ?').get(paperId, key);
        if (!row) return null;
        try {
            return JSON.parse(row.value);
        } catch {
            return row.value;
        }
    } catch (e) {
        log(`Error loading app state: ${e.message}`, 'ERROR');
        return null;
    }
}

// =====================================================
// VERSION HISTORY FUNCTIONS
// =====================================================

// Save a version history entry
function saveVersionHistory(commentId, paperId, fieldName, oldValue, newValue, source = 'user') {
    if (!db) return false;
    if (oldValue === newValue) return false; // No change

    try {
        const stmt = db.prepare(`
            INSERT INTO version_history (comment_id, paper_id, field_name, old_value, new_value, source)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(commentId, paperId, fieldName, oldValue || '', newValue || '', source);
        log(`Version history saved for ${commentId}.${fieldName}`);
        return true;
    } catch (e) {
        log(`Error saving version history: ${e.message}`, 'ERROR');
        return false;
    }
}

// Get version history for a comment
function getVersionHistory(commentId, limit = 50) {
    if (!db) return [];

    try {
        const rows = db.prepare(`
            SELECT * FROM version_history
            WHERE comment_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `).all(commentId, limit);
        return rows;
    } catch (e) {
        log(`Error loading version history: ${e.message}`, 'ERROR');
        return [];
    }
}

// Get all version history for a paper
function getPaperVersionHistory(paperId, limit = 100) {
    if (!db) return [];

    try {
        const rows = db.prepare(`
            SELECT * FROM version_history
            WHERE paper_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `).all(paperId, limit);
        return rows;
    } catch (e) {
        log(`Error loading paper version history: ${e.message}`, 'ERROR');
        return [];
    }
}

// Revert a comment field to a previous version
function revertToVersion(versionId) {
    if (!db) return null;

    // Whitelist of allowed field names to prevent SQL injection
    const ALLOWED_FIELDS = ['draft_response', 'status', 'priority', 'type', 'category', 'original_text', 'summary'];

    try {
        const version = db.prepare('SELECT * FROM version_history WHERE id = ?').get(versionId);
        if (!version) return null;

        // Validate field_name against whitelist to prevent SQL injection
        if (!ALLOWED_FIELDS.includes(version.field_name)) {
            log(`Invalid field name in revert: ${version.field_name}`, 'ERROR');
            return null;
        }

        // Update the comment with the old value
        const updateStmt = db.prepare(`
            UPDATE comments SET ${version.field_name} = ?, updated_at = datetime('now')
            WHERE id = ?
        `);
        updateStmt.run(version.old_value, version.comment_id);

        // Record the revert as a new version entry
        saveVersionHistory(
            version.comment_id,
            version.paper_id,
            version.field_name,
            version.new_value,
            version.old_value,
            'revert'
        );

        log(`Reverted ${version.comment_id}.${version.field_name} to version ${versionId}`);
        return { success: true, comment_id: version.comment_id, field: version.field_name, value: version.old_value };
    } catch (e) {
        log(`Error reverting version: ${e.message}`, 'ERROR');
        return null;
    }
}

// =====================================================
// END DATABASE LAYER
// =====================================================

// Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Parse output from "opencode models" command
function parseModelsOutput(output) {
    const models = [];
    const lines = output.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and headers
        if (!trimmed || trimmed.startsWith('Available') || trimmed.startsWith('---') || trimmed.startsWith('Model')) {
            continue;
        }

        // Parse model line - format varies, but model ID is typically first
        // Common formats:
        // "openai/gpt-5.2-codex"
        // "openai/gpt-5.2-codex   GPT-5.2 Codex   Best for code"
        // "* openai/gpt-5.2-codex" (with asterisk for current)
        let modelLine = trimmed;
        let isCurrent = false;

        if (modelLine.startsWith('*')) {
            isCurrent = true;
            modelLine = modelLine.substring(1).trim();
        }

        // Split by whitespace - first part is model ID
        const parts = modelLine.split(/\s{2,}|\t/);  // Split by 2+ spaces or tab
        const modelId = parts[0]?.trim();

        if (modelId && modelId.includes('/')) {
            // Valid model ID (has provider/model format)
            const [provider, ...nameParts] = modelId.split('/');
            const modelName = nameParts.join('/');

            models.push({
                id: modelId,
                provider: provider,
                name: parts[1]?.trim() || modelName,
                description: parts[2]?.trim() || '',
                current: isCurrent
            });
        }
    }

    // Group by provider
    const grouped = {};
    for (const model of models) {
        if (!grouped[model.provider]) {
            grouped[model.provider] = [];
        }
        grouped[model.provider].push(model);
    }

    return { list: models, grouped };
}

// ============================================================
// Processing Job Management (Background Processing)
// ============================================================

// In-memory store for active processing jobs
const activeJobs = new Map();

// Create a new processing job
function createProcessingJob(paperId) {
    const jobId = `job_${paperId}_${Date.now()}`;
    const job = {
        id: jobId,
        paper_id: paperId,
        status: 'pending',
        progress: 0,
        current_step: 'initializing',
        total_steps: 0,
        current_file: null,
        logs: [],
        error: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        process_pid: null,      // Main process PID
        worker_pids: []         // Worker session PIDs for cleanup
    };

    // Save to database
    if (db) {
        try {
            db.prepare(`
                INSERT INTO processing_jobs (id, paper_id, status, progress, current_step, total_steps, current_file, logs, started_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(job.id, job.paper_id, job.status, job.progress, job.current_step, job.total_steps, job.current_file, JSON.stringify(job.logs), job.started_at);
        } catch (e) {
            log(`Error creating processing job: ${e.message}`, 'ERROR');
        }
    }

    // Store in memory for quick access
    activeJobs.set(jobId, job);
    return job;
}

// Update processing job progress
function updateProcessingJob(jobId, updates) {
    const job = activeJobs.get(jobId);
    if (!job) return null;

    // Apply updates
    Object.assign(job, updates, { updated_at: new Date().toISOString() });

    // Add log entry if message provided
    if (updates.log) {
        job.logs.push({
            time: new Date().toISOString(),
            step: updates.current_step || job.current_step,
            message: updates.log
        });
        delete updates.log;
    }

    // Update database
    if (db) {
        try {
            db.prepare(`
                UPDATE processing_jobs SET
                    status = ?,
                    progress = ?,
                    current_step = ?,
                    total_steps = ?,
                    current_file = ?,
                    logs = ?,
                    error = ?,
                    completed_at = ?,
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(
                job.status,
                job.progress,
                job.current_step,
                job.total_steps,
                job.current_file,
                JSON.stringify(job.logs),
                job.error,
                job.completed_at,
                jobId
            );
        } catch (e) {
            log(`Error updating processing job: ${e.message}`, 'ERROR');
        }
    }

    return job;
}

// Complete a processing job
function completeProcessingJob(jobId, success = true, error = null) {
    const updates = {
        status: success ? 'completed' : 'failed',
        progress: success ? 100 : undefined,
        completed_at: new Date().toISOString(),
        error: error
    };

    const job = updateProcessingJob(jobId, updates);

    // Remove from active jobs after a delay (keep for status polling)
    setTimeout(() => {
        activeJobs.delete(jobId);
    }, 60000); // Keep in memory for 1 minute after completion

    return job;
}

// Get processing job status
function getProcessingJob(jobId) {
    // Check memory first
    if (activeJobs.has(jobId)) {
        return activeJobs.get(jobId);
    }

    // Check database
    if (db) {
        try {
            const row = db.prepare('SELECT * FROM processing_jobs WHERE id = ?').get(jobId);
            if (row) {
                row.logs = JSON.parse(row.logs || '[]');
                return row;
            }
        } catch (e) {
            log(`Error getting processing job: ${e.message}`, 'ERROR');
        }
    }

    return null;
}

// Get active job for a paper
function getActiveJobForPaper(paperId) {
    // Check memory for active jobs
    for (const [jobId, job] of activeJobs) {
        if (job.paper_id === paperId && (job.status === 'pending' || job.status === 'processing')) {
            return job;
        }
    }

    // Check database for recent jobs
    if (db) {
        try {
            const row = db.prepare(`
                SELECT * FROM processing_jobs
                WHERE paper_id = ? AND status IN ('pending', 'processing')
                ORDER BY created_at DESC LIMIT 1
            `).get(paperId);
            if (row) {
                row.logs = JSON.parse(row.logs || '[]');
                // Re-add to active jobs
                activeJobs.set(row.id, row);
                return row;
            }
        } catch (e) {
            log(`Error getting active job for paper: ${e.message}`, 'ERROR');
        }
    }

    return null;
}

// Get most recent job for a paper (including completed)
function getLatestJobForPaper(paperId) {
    if (db) {
        try {
            const row = db.prepare(`
                SELECT * FROM processing_jobs
                WHERE paper_id = ?
                ORDER BY created_at DESC LIMIT 1
            `).get(paperId);
            if (row) {
                row.logs = JSON.parse(row.logs || '[]');
                return row;
            }
        } catch (e) {
            log(`Error getting latest job for paper: ${e.message}`, 'ERROR');
        }
    }
    return null;
}

// Session management (using database)
function loadSession(sessionId = 'default') {
    const settings = getSettings();  // Get current config settings
    const defaults = {
        opencode_session_id: null,
        model: settings.model,
        agent: settings.agent,
        variant: settings.variant,
        messages: [],
        paper_id: null
    };

    if (!db) {
        // Fall back to JSON file if database not initialized
        const session = loadJSON(SESSION_FILE);
        return { ...defaults, ...session };
    }

    try {
        const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
        const row = stmt.get(sessionId);
        if (row) {
            return {
                opencode_session_id: row.opencode_session_id || null,
                model: row.model || settings.model,
                agent: row.agent || settings.agent,
                variant: row.variant || settings.variant,
                messages: row.messages ? JSON.parse(row.messages) : [],
                paper_id: row.paper_id || null
            };
        }
    } catch (e) {
        log(`Error loading session from DB: ${e.message}`, 'WARN');
    }

    return defaults;
}

function saveSession(session, sessionId = 'default') {
    if (!db) {
        // Fall back to JSON file if database not initialized
        saveJSON(SESSION_FILE, session);
        return;
    }

    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO sessions
            (id, opencode_session_id, model, agent, variant, messages, paper_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        stmt.run(
            sessionId,
            session.opencode_session_id || null,
            session.model || null,
            session.agent || null,
            session.variant || null,
            JSON.stringify(session.messages || []),
            session.paper_id || null
        );
    } catch (e) {
        log(`Error saving session to DB: ${e.message}`, 'ERROR');
        // Fall back to JSON file
        saveJSON(SESSION_FILE, session);
    }
}

// Reset session in database
function resetSession(sessionId = 'default') {
    if (!db) {
        // Fall back to JSON file if database not initialized
        saveJSON(SESSION_FILE, {});
        return;
    }

    try {
        const stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
        stmt.run(sessionId);
        log(`Session ${sessionId} reset`);
    } catch (e) {
        log(`Error resetting session: ${e.message}`, 'ERROR');
    }
}

// Create a new session for a paper with AI config
function createPaperSession(paperId, aiConfig = {}) {
    if (!db) return null;

    try {
        const sessionId = paperId; // Use paper ID as session ID
        const model = aiConfig.model || 'github-copilot/gpt-5.2';
        const agent = aiConfig.agent || 'general';
        const variant = aiConfig.variant || 'high';
        const parallel = aiConfig.parallel || 4;

        // Delete existing session for this paper
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

        // Create new session (store parallel in messages as JSON config)
        const configJson = JSON.stringify({ parallel });
        const stmt = db.prepare(`
            INSERT INTO sessions (id, paper_id, model, agent, variant, messages)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(sessionId, paperId, model, agent, variant, configJson);

        log(`Created session for paper ${paperId}: model=${model}, agent=${agent}, variant=${variant}, parallel=${parallel}`);
        return sessionId;
    } catch (e) {
        log(`Error creating paper session: ${e.message}`, 'ERROR');
        return null;
    }
}

// Get session config for a paper
function getPaperSession(paperId) {
    if (!db) return null;

    try {
        const stmt = db.prepare('SELECT * FROM sessions WHERE paper_id = ?');
        const session = stmt.get(paperId);
        if (session && session.messages) {
            // Parse config from messages field
            try {
                const config = JSON.parse(session.messages);
                session.parallel = config.parallel || 4;
            } catch (e) {
                session.parallel = 4;
            }
        }
        return session;
    } catch (e) {
        log(`Error getting paper session: ${e.message}`, 'ERROR');
        return null;
    }
}

// Run opencode CLI using the same pattern as opencode-bridge
// - Writes message to temp file to avoid shell escaping issues
// - Uses --file to attach files
// - Uses --format json for structured output
// - Uses --session for session continuity
function runOpencode(options = {}) {
    const {
        message,           // The message/prompt to send
        files = [],        // Array of file paths to attach
        model = 'github-copilot/gpt-5.2',
        agent = 'general',
        variant = 'high',
        sessionId = null,  // OpenCode session ID for continuity
        timeout = 300000,
        cwd = BASE_DIR,
        onProgress = null, // Callback for real-time progress updates
        jobId = null       // Job ID to track spawned process for cleanup
    } = options;

    return new Promise((resolve, reject) => {
        if (!OPENCODE_BIN) {
            log('OpenCode binary not found!', 'ERROR');
            resolve({ output: 'OpenCode not installed. Install from: https://opencode.ai', code: 1 });
            return;
        }

        // Write message to temp file in the working directory (avoids permission prompts)
        // Using cwd ensures OpenCode already has access to this directory
        // Use crypto random to prevent collision when multiple requests arrive simultaneously
        const tempId = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const tempMsgFile = path.join(cwd, `.opencode_msg_${tempId}.md`);
        fs.writeFileSync(tempMsgFile, message);

        // Build args like opencode-bridge: opencode run "Respond to the request in the attached message file."
        const args = ['run', 'Respond to the request in the attached message file.'];

        // Add model, agent, variant
        args.push('--model', model);
        args.push('--agent', agent);
        if (variant) {
            args.push('--variant', variant);
        }

        // Continue session if we have one
        if (sessionId) {
            args.push('--session', sessionId);
        }

        // Attach the message file and any additional files
        // Use relative paths from cwd to avoid permission prompts
        const allFiles = [tempMsgFile, ...files];
        for (const f of allFiles) {
            // Convert to relative path if the file is under cwd
            const relativePath = f.startsWith(cwd) ? path.relative(cwd, f) : f;
            args.push('--file', relativePath);
        }

        // Use JSON format for structured output
        args.push('--format', 'json');

        log(`[OPENCODE] Running: ${OPENCODE_BIN} ${args.slice(0, 4).join(' ')} ... (${allFiles.length} files)`);
        log(`[OPENCODE] Working directory: ${cwd}`);
        log(`[OPENCODE] Timeout: ${timeout}ms`);

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let partialLine = '';  // Buffer for incomplete JSON lines

        const proc = spawn(OPENCODE_BIN, args, {
            cwd: cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                TMPDIR: cwd,  // Use paper's dir as temp to avoid /tmp permission prompts
                TEMP: cwd,
                TMP: cwd
            }
        });

        // Track this process PID in the job for cleanup on stop
        if (jobId && proc.pid) {
            const job = activeJobs.get(jobId);
            if (job) {
                if (!job.worker_pids) job.worker_pids = [];
                job.worker_pids.push(proc.pid);
                log(`[OPENCODE] Tracked PID ${proc.pid} for job ${jobId}`);
            }
        }

        const timeoutId = setTimeout(() => {
            timedOut = true;
            log(`[OPENCODE] Process timed out after ${timeout}ms, killing...`, 'WARN');
            proc.kill('SIGTERM');
        }, timeout);

        proc.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;

            // Process JSON events in real-time for streaming updates
            const lines = (partialLine + chunk).split('\n');
            partialLine = lines.pop() || '';  // Keep incomplete line for next chunk

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);

                    // Stream reasoning/thinking in real-time via callback
                    if (onProgress && (event.type === 'thinking' || event.type === 'reasoning')) {
                        const text = event.part?.text || event.thinking || '';
                        if (text && text.length > 10) {
                            // Show fuller reasoning text for verbose output
                            const summary = text.substring(0, 300).replace(/\n/g, ' ').trim();
                            onProgress({ type: 'reasoning', message: `💭 ${summary}${text.length > 300 ? '...' : ''}` });
                        }
                    }

                    // Stream tool usage with more details
                    if (onProgress && (event.type === 'tool_use' || event.type === 'tool_call' || event.type === 'tool')) {
                        const toolName = event.tool?.name || event.name || event.tool_name || event.function?.name || event.content?.name || '';
                        if (toolName) {
                            const toolInput = event.tool?.input || event.input || event.arguments || {};
                            // Show tool name and brief input preview
                            let toolDesc = `🔧 Tool: ${toolName}`;
                            if (toolInput.file || toolInput.path) {
                                toolDesc += ` → ${toolInput.file || toolInput.path}`;
                            } else if (toolInput.query) {
                                toolDesc += ` → "${toolInput.query.substring(0, 50)}${toolInput.query.length > 50 ? '...' : ''}"`;
                            }
                            onProgress({ type: 'tool', message: toolDesc });
                        }
                    }

                    // Stream tool results
                    if (onProgress && event.type === 'tool_result') {
                        const resultText = event.result?.text || event.output || '';
                        if (resultText && resultText.length > 0) {
                            const preview = resultText.substring(0, 200).replace(/\n/g, ' ').trim();
                            onProgress({ type: 'tool_result', message: `📄 Result: ${preview}${resultText.length > 200 ? '...' : ''}` });
                        }
                    }

                    // Stream text output chunks
                    if (onProgress && event.type === 'text') {
                        const text = event.part?.text || '';
                        if (text && text.length > 20) {
                            const preview = text.substring(0, 200).replace(/\n/g, ' ').trim();
                            onProgress({ type: 'text', message: `📝 ${preview}${text.length > 200 ? '...' : ''}` });
                        }
                    }

                    // Stream assistant messages
                    if (onProgress && event.type === 'assistant' && event.content) {
                        const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
                        const preview = content.substring(0, 200).replace(/\n/g, ' ').trim();
                        onProgress({ type: 'assistant', message: `🤖 ${preview}${content.length > 200 ? '...' : ''}` });
                    }
                } catch (e) {
                    // Not JSON, ignore
                }
            }
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            clearTimeout(timeoutId);

            // Clean up temp message file
            try { fs.unlinkSync(tempMsgFile); } catch (e) {}

            log(`[OPENCODE] Process closed with code: ${code}, timedOut: ${timedOut}`);
            log(`[OPENCODE] stdout length: ${stdout.length}, stderr length: ${stderr.length}`);
            if (stderr) {
                log(`[OPENCODE] stderr: ${stderr.substring(0, 500)}`);
            }

            // Parse JSON events from output (like opencode-bridge does)
            let sessionIdFromOutput = null;
            const replyParts = [];
            const reasoningParts = [];

            for (const line of stdout.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    // Capture session ID for future continuity
                    if (event.sessionID && !sessionIdFromOutput) {
                        sessionIdFromOutput = event.sessionID;
                    }
                    // Capture text content
                    if (event.type === 'text') {
                        const text = event.part?.text || '';
                        if (text) replyParts.push(text);
                    }
                    // Capture reasoning/thinking
                    if (event.type === 'thinking' || event.type === 'reasoning') {
                        const thinking = event.part?.text || event.thinking || '';
                        if (thinking) reasoningParts.push(thinking);
                    }
                    // Log tool calls for visibility
                    if (event.type === 'tool_use' || event.type === 'tool_call' || event.type === 'tool') {
                        const toolName = event.tool?.name || event.name || event.tool_name || event.function?.name || event.content?.name || 'tool';
                        if (toolName !== 'unknown' && toolName !== 'tool') {
                            log(`  [OpenCode] Tool: ${toolName}`);
                        }
                    }
                } catch (e) {
                    // Not JSON, might be raw output
                    if (line.trim() && !line.startsWith('{')) {
                        replyParts.push(line);
                    }
                }
            }

            // Log reasoning summary if available
            if (reasoningParts.length > 0) {
                const reasoningSummary = reasoningParts.join(' ').substring(0, 500);
                log(`  [OpenCode] Reasoning: ${reasoningSummary}${reasoningParts.join(' ').length > 500 ? '...' : ''}`);
            }

            const reply = replyParts.join('');

            // Log output preview
            if (reply) {
                const preview = reply.substring(0, 300).replace(/\n/g, ' ');
                log(`  [OpenCode] Output: ${preview}${reply.length > 300 ? '...' : ''}`);
            }

            // Detect if AI is stuck asking questions or running scripts instead of processing
            const replyLower = reply.toLowerCase();
            const stuckPatterns = [
                "how would you like me to proceed",
                "how would you like to proceed",
                "which do you prefer",
                "can't read the pdf",
                "can't parse pdf",
                "i can proceed if you",
                "upload a text/docx",
                "paste the supplement text",
                "pick which tasks",
                "i can take the next step",
                "choose how you want",
                "which option would you",
                "let me know if you'd like",
                "would you like me to",
                "shall i proceed",
                "do you want me to",
                "i'll run a",
                "running a script",
                "i'll write a",
                "running now",
                "pandas is not",
                "isn't available",
                "is not installed",
                "please choose",
                "i'll wait for your",
                "waiting for your",
                "i'll create a short plan",
                "i'll check the workspace",
                "running a brief",
                "running those file-glob",
                "pick one option",
                "i recommend",
                "next actionable steps",
                "which one to run",
                "i'll suggest",
                "suggest the next",
                "actionable steps"
            ];
            const isStuck = stuckPatterns.some(pattern => replyLower.includes(pattern));
            if (isStuck) {
                log(`[OPENCODE] Detected AI asking questions instead of processing - marking as stuck`, 'WARN');
            }

            // Build reasoning summary for logs
            const reasoningSummary = reasoningParts.length > 0
                ? reasoningParts.join(' ').substring(0, 200)
                : null;

            // Clean up temp message file
            try { fs.unlinkSync(tempMsgFile); } catch (e) {}

            resolve({
                output: reply || stdout || stderr,
                code: timedOut ? 124 : (code || 0),
                stderr: stderr,
                sessionId: sessionIdFromOutput,
                rawOutput: stdout,
                reasoning: reasoningSummary,
                isStuck: isStuck  // Flag indicating AI is asking questions instead of processing
            });
        });

        proc.on('error', (err) => {
            clearTimeout(timeoutId);
            try { fs.unlinkSync(tempMsgFile); } catch (e) {}
            log(`[OPENCODE] Process error: ${err.message}`, 'ERROR');
            resolve({
                output: `Error: ${err.message}`,
                code: 1,
                stderr: err.message
            });
        });

        // Send empty stdin and close (like opencode-bridge)
        proc.stdin.end();
    });
}

// =====================================================
// WORKER SESSION NETWORK
// Each file gets its own persistent session that can be queried by the master
// Sessions are stored in the database for persistence across restarts
// =====================================================

// Database functions for worker sessions
function saveWorkerSession(paperId, worker) {
    if (!db) return false;
    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO worker_sessions
            (paper_id, file_name, file_path, file_category, session_id, inventory, status, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))
        `);
        stmt.run(paperId, worker.fileName, worker.filePath, worker.category, worker.sessionId, worker.inventory);
        return true;
    } catch (e) {
        log(`[Worker DB] Error saving session: ${e.message}`, 'WARN');
        return false;
    }
}

function getWorkerSessions(paperId) {
    if (!db) return [];
    try {
        const stmt = db.prepare(`
            SELECT file_name as fileName, file_path as filePath, file_category as category,
                   session_id as sessionId, inventory, status
            FROM worker_sessions
            WHERE paper_id = ? AND status = 'active'
        `);
        return stmt.all(paperId);
    } catch (e) {
        log(`[Worker DB] Error getting sessions: ${e.message}`, 'WARN');
        return [];
    }
}

function updateWorkerLastUsed(paperId, fileName) {
    if (!db) return;
    try {
        db.prepare(`
            UPDATE worker_sessions SET last_used_at = datetime('now')
            WHERE paper_id = ? AND file_name = ?
        `).run(paperId, fileName);
    } catch (e) {
        log(`[Worker DB] Error updating last used: ${e.message}`, 'WARN');
    }
}

function clearWorkerSessions(paperId) {
    if (!db) return;
    try {
        db.prepare('DELETE FROM worker_sessions WHERE paper_id = ?').run(paperId);
        log(`[Worker DB] Cleared sessions for paper ${paperId}`);
    } catch (e) {
        log(`[Worker DB] Error clearing sessions: ${e.message}`, 'WARN');
    }
}

// Create a worker session for a file - loads the file into context
async function createWorkerSession(paperId, file, outputDir, modelToUse, agentToUse, variantToUse) {
    const fileName = path.basename(file.path);
    log(`[Worker] Creating session for ${fileName}...`);

    const initPrompt = `You are a data expert for this file: ${fileName}

CRITICAL: Output IMMEDIATELY. Do NOT ask questions, request clarification, or enter planning mode.

Your role:
- You have this file loaded in your context
- When asked questions, search the file and provide specific answers
- Always cite exact values, table names, row counts from the data
- Be concise but precise

List the main contents of this file (tables, columns, row counts) NOW.`;

    try {
        const result = await runOpencode({
            message: initPrompt,
            files: [file.path],
            model: modelToUse,
            agent: agentToUse,
            variant: 'low',
            timeout: 120000,
            cwd: outputDir
        });

        if (result.sessionId) {
            log(`[Worker] Session created for ${fileName}: ${result.sessionId}`);
            const worker = {
                sessionId: result.sessionId,
                fileName: fileName,
                filePath: file.path,
                category: file.category,
                name: file.name,
                inventory: result.output?.substring(0, 500) || ''
            };

            // Save to database
            saveWorkerSession(paperId, worker);

            return worker;
        }
    } catch (e) {
        log(`[Worker] Error creating session for ${fileName}: ${e.message}`, 'WARN');
    }
    return null;
}

// Query a worker session with a specific question
async function queryWorkerSession(paperId, worker, question, outputDir, modelToUse, agentToUse, variantToUse) {
    log(`[Worker] Querying ${worker.fileName}: "${question.substring(0, 50)}..."`);

    try {
        const result = await runOpencode({
            message: question,
            files: [],  // No files - use session context
            model: modelToUse,
            agent: agentToUse,
            variant: 'low',
            timeout: 60000,
            cwd: outputDir,
            sessionId: worker.sessionId
        });

        // Update last used timestamp
        updateWorkerLastUsed(paperId, worker.fileName);

        return result.output || '';
    } catch (e) {
        log(`[Worker] Query error for ${worker.fileName}: ${e.message}`, 'WARN');
        return `[Error querying ${worker.fileName}]`;
    }
}

// Create worker sessions for all files - uses database for persistence
async function createWorkerNetwork(paperId, processedFiles, outputDir, modelToUse, agentToUse, variantToUse, onProgress = null) {
    // Check for existing sessions in database
    const existingWorkers = getWorkerSessions(paperId);
    if (existingWorkers.length > 0) {
        log(`[Worker] Found ${existingWorkers.length} cached worker sessions in database`);
        return existingWorkers;
    }

    const workers = [];

    // Create sessions for each file
    for (const file of processedFiles) {
        if (onProgress) {
            onProgress({ type: 'text', message: `🔧 Loading ${file.name} into worker session...` });
        }

        const worker = await createWorkerSession(paperId, file, outputDir, modelToUse, agentToUse, variantToUse);
        if (worker) {
            workers.push(worker);
        }
    }

    log(`[Worker] Created ${workers.length} worker sessions`);
    return workers;
}

// Build a context document from worker inventories (what each file contains)
function buildWorkerInventory(workers) {
    let inventory = '# Available Data Sources\n\n';
    inventory += 'The following files are loaded in separate worker sessions. You can query them for specific data.\n\n';

    for (const worker of workers) {
        inventory += `## ${worker.fileName} (${worker.category})\n`;
        inventory += `${worker.inventory}\n\n`;
    }

    return inventory;
}

// Master queries workers for specific information
async function masterQueryWorkers(paperId, workers, questions, outputDir, modelToUse, agentToUse, variantToUse) {
    const results = {};

    for (const q of questions) {
        // Find relevant worker based on question context
        const relevantWorker = workers.find(w =>
            q.toLowerCase().includes(w.fileName.toLowerCase()) ||
            q.toLowerCase().includes((w.name || '').toLowerCase())
        ) || workers.find(w => w.category === 'supplementary');

        if (relevantWorker) {
            results[q] = await queryWorkerSession(paperId, relevantWorker, q, outputDir, modelToUse, agentToUse, variantToUse);
        }
    }

    return results;
}

// Prepare files for context with worker network approach
// For comment extraction: Only attach reviews + manuscript (within budget)
// For large supplementary files: Create worker sessions to query later
async function prepareFilesForContext(paperId, processedFiles, tokenBudget, outputDir, modelToUse, agentToUse, variantToUse, onProgress = null) {
    const CHARS_PER_TOKEN = 4;
    let totalTokens = 0;
    const filesForContext = [];  // Files to attach directly
    const filesForWorkers = [];  // Large files that get worker sessions

    // Prioritize by category: reviews first, then manuscript, then supplementary
    const categorized = {
        review: processedFiles.filter(f => f.category === 'review'),
        manuscript: processedFiles.filter(f => f.category === 'manuscript'),
        supplementary: processedFiles.filter(f => f.category === 'supplementary')
    };

    // Always include reviews and manuscript (they fit in context)
    for (const file of [...categorized.review, ...categorized.manuscript]) {
        if (fs.existsSync(file.path)) {
            const content = fs.readFileSync(file.path, 'utf8');
            const fileTokens = Math.ceil(content.length / CHARS_PER_TOKEN);
            totalTokens += fileTokens;
            filesForContext.push(file.path);
            log(`[Context] Added ${file.name} (~${fileTokens} tokens)`);
        }
    }

    // For supplementary files: check size and decide
    for (const file of categorized.supplementary) {
        if (!fs.existsSync(file.path)) continue;

        const content = fs.readFileSync(file.path, 'utf8');
        const fileTokens = Math.ceil(content.length / CHARS_PER_TOKEN);

        if (totalTokens + fileTokens < tokenBudget) {
            // Small enough to fit in context
            totalTokens += fileTokens;
            filesForContext.push(file.path);
            log(`[Context] Added supplementary ${file.name} (~${fileTokens} tokens)`);
        } else {
            // Too large - mark for worker session
            filesForWorkers.push(file);
            log(`[Context] Supplementary ${file.name} too large (~${fileTokens} tokens) - will use worker session`);
        }
    }

    // Create worker sessions for large supplementary files
    let workersCreated = 0;
    if (filesForWorkers.length > 0 && onProgress) {
        onProgress({ type: 'text', message: `📊 Creating ${filesForWorkers.length} worker sessions for large supplementary files...` });

        for (const file of filesForWorkers) {
            if (onProgress) {
                onProgress({ type: 'text', message: `🔧 Loading ${file.name} into dedicated session...` });
            }
            const worker = await createWorkerSession(paperId, file, outputDir, modelToUse, agentToUse, variantToUse);
            if (worker) {
                workersCreated++;
            }
        }
    }

    return {
        files: filesForContext,
        prepared: filesForContext,
        estimatedTokens: totalTokens,
        summarizedCount: 0,  // No summarization - using workers instead
        workersCreated: workersCreated
    };
}

// Convert docx/xlsx files to text using pandoc (avoids /tmp permission issues in OpenCode skills)
async function convertToText(filePath, outputDir) {
    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath, ext);
    const outputPath = path.join(outputDir, `${baseName}.md`);

    if (ext === '.docx' || ext === '.doc') {
        // Use pandoc to convert docx to markdown
        try {
            const { execSync } = require('child_process');
            execSync(`pandoc --track-changes=all "${filePath}" -o "${outputPath}"`, {
                cwd: outputDir,
                env: { ...process.env, TMPDIR: outputDir, TEMP: outputDir, TMP: outputDir },
                timeout: 60000
            });
            log(`[CONVERT] Converted ${path.basename(filePath)} to markdown`);
            return outputPath;
        } catch (err) {
            log(`[CONVERT] Failed to convert ${path.basename(filePath)}: ${err.message}`, 'WARN');
            return filePath; // Fall back to original file
        }
    } else if (ext === '.pdf') {
        // Use pdftotext to convert PDF to text
        try {
            const { execSync } = require('child_process');
            const txtPath = path.join(outputDir, `${baseName}.txt`);
            execSync(`pdftotext -layout "${filePath}" "${txtPath}"`, {
                cwd: outputDir,
                timeout: 120000
            });
            // Convert txt to markdown format
            const txtContent = fs.readFileSync(txtPath, 'utf8');
            const markdown = `# PDF: ${baseName}${ext}\n\n${txtContent}`;
            fs.writeFileSync(outputPath, markdown);
            fs.unlinkSync(txtPath); // Remove intermediate txt file
            log(`[CONVERT] Converted ${path.basename(filePath)} (PDF) to markdown`);
            return outputPath;
        } catch (err) {
            log(`[CONVERT] Failed to convert PDF ${path.basename(filePath)}: ${err.message}`, 'WARN');
            return filePath; // Fall back to original file
        }
    } else if (ext === '.xlsx' || ext === '.xls') {
        // Convert Excel files to markdown/CSV using xlsx library
        try {
            const XLSX = require('xlsx');
            const workbook = XLSX.readFile(filePath);

            // Build markdown output with all sheets
            let markdown = `# Excel File: ${baseName}${ext}\n\n`;

            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

                markdown += `## Sheet: ${sheetName}\n\n`;

                if (data.length > 0) {
                    // Create markdown table
                    const headers = data[0];
                    if (headers && headers.length > 0) {
                        // Header row
                        markdown += '| ' + headers.map(h => String(h || '').replace(/\|/g, '\\|')).join(' | ') + ' |\n';
                        // Separator row
                        markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
                        // Data rows (limit to first 100 rows for context)
                        const maxRows = Math.min(data.length, 101);
                        for (let i = 1; i < maxRows; i++) {
                            const row = data[i] || [];
                            markdown += '| ' + headers.map((_, j) => String(row[j] || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |\n';
                        }
                        if (data.length > 101) {
                            markdown += `\n*... ${data.length - 101} more rows not shown ...*\n`;
                        }
                    }
                } else {
                    markdown += '*Empty sheet*\n';
                }
                markdown += '\n';
            }

            // Write markdown file
            fs.writeFileSync(outputPath, markdown);
            log(`[CONVERT] Converted ${path.basename(filePath)} to markdown (${workbook.SheetNames.length} sheets)`);
            return outputPath;
        } catch (err) {
            log(`[CONVERT] Failed to convert Excel ${path.basename(filePath)}: ${err.message}`, 'WARN');
            return filePath; // Fall back to original file
        }
    }
    return filePath; // Return original for other file types
}

// Generate skill-specific prompts for OpenCode based on file type and category
// Uses @use directives to invoke OpenCode skills for different file formats
function getSkillPrompt(ext, category, filename) {
    // Skill directives based on file extension
    // OpenCode will use these skills to read the attached files
    const skillDirectives = {
        '.docx': '@use docx',
        '.doc': '@use docx',
        '.xlsx': '@use xlsx',
        '.xls': '@use xlsx',
        '.pdf': '@use pdf',
        '.png': '', // OpenCode handles images natively (multimodal)
        '.jpg': '', // OpenCode handles images natively (multimodal)
        '.jpeg': '', // OpenCode handles images natively (multimodal)
        '.txt': '',
        '.md': ''
    };

    const skillDirective = skillDirectives[ext] || '';
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);

    // Category-specific instructions
    const categoryInstructions = {
        manuscript: `${skillDirective}

This is a MANUSCRIPT file (the main paper being reviewed).
${isImage ? 'This is an image/figure from the manuscript. Analyze its content.' : 'Read and analyze this document.'}

Extract and remember:
- Paper title
- Authors and affiliations
- Abstract
- Key methodology and approach
- Main findings/results
- Research field/discipline
${isImage ? '- What this figure/image shows and its relevance' : ''}

Store this context - it will be needed when analyzing reviewer comments.`,

        review: `@use extract-reviews
${skillDirective}

This is a REVIEW file containing peer reviewer feedback.
${isImage ? 'This appears to be a screenshot or image of reviewer comments. Extract all visible text.' : `
Extract and classify ALL reviewer comments from this document.

CRITICAL INSTRUCTIONS:
1. Comments are PLAIN TEXT in the document body (NOT Word comment annotations)
2. Look for "Referee #1", "Referee #2", "Reviewer 1", etc. headers
3. AGGRESSIVELY GROUP line-specific edits into single comments
4. Target: ~15-25 major comments, ~35-50 minor comments per paper

Follow the extract-reviews skill guidelines for classification and grouping.`}

Remember the extracted comments for the final summary - include the structured JSON output with:
- Each reviewer identified with their comments
- Each comment classified as major/minor with category
- Summary counts of total, major, and minor comments`,

        supplementary: `${skillDirective}

INSTRUCTION: Load this file into context. DO NOT analyze. DO NOT list contents. DO NOT suggest steps. DO NOT ask questions.
${isImage ? 'Briefly note it is an image.' : ''}
YOUR ONLY RESPONSE: "Supplementary file loaded"`
    };

    const instruction = categoryInstructions[category] || `${skillDirective}\n\nRead and analyze this file.`;
    return `${instruction}\n\nFile: ${filename}`;
}

// File type to path patterns mapping
// Paths relative to parent directory (where manuscript lives)
// These patterns are searched dynamically - add your files to input/ folder
const FILE_TYPE_PATTERNS = {
    manuscript: [
        'input/manuscript*.docx',
        'input/manuscript*.pdf',
        'input/*.docx',
        'manuscript.md'
    ],
    reviews: [
        'data/reviewer_comments.json',        // JSON with parsed comments
        'input/reviews*.docx',                // Original reviews document
        'input/reviews*.txt',                 // Plain text reviews
        'expert_discussions.json'             // Expert discussions (generated)
    ],
    damage_data: [
        'input/*damage*.tsv',
        'data/*damage*.json'
    ],
    taxonomic_data: [
        'input/*taxonomic*.tsv',
        'data/*taxonomic*.json',
        'input/supplementary/*.xlsx'
    ],
    supplementary: [
        'input/supplementary/*.docx',
        'input/supplementary/*.pdf',
        'input/supplementary/tables/*.xlsx'
    ]
};

// Scan a directory recursively for files
function scanDirectory(dirPath, maxDepth = 2, currentDepth = 0) {
    const files = [];
    if (currentDepth > maxDepth) return files;

    try {
        if (!fs.existsSync(dirPath)) return files;

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory() && currentDepth < maxDepth) {
                files.push(...scanDirectory(fullPath, maxDepth, currentDepth + 1));
            } else if (entry.isFile()) {
                // Skip temp files and hidden files
                if (!entry.name.startsWith('.') && !entry.name.startsWith('~')) {
                    files.push(fullPath);
                }
            }
        }
    } catch (e) {
        log(`Error scanning directory ${dirPath}: ${e.message}`, 'WARN');
    }
    return files;
}

// Get context files for loading based on selected types
function getContextFiles(selectedTypes = []) {
    const files = [];
    const parentDir = path.join(BASE_DIR, '..');

    // If no types specified, return empty
    if (!selectedTypes || selectedTypes.length === 0) {
        log('No file types selected for context loading');
        return files;
    }

    log(`Loading context files for types: ${selectedTypes.join(', ')}`);

    for (const fileType of selectedTypes) {
        const patterns = FILE_TYPE_PATTERNS[fileType];
        if (!patterns) {
            log(`Unknown file type: ${fileType}`, 'WARN');
            continue;
        }

        let foundForType = false;
        for (const pattern of patterns) {
            if (foundForType) break; // Only need one match per type

            const fullPattern = path.join(parentDir, pattern);

            // Try glob first
            try {
                const glob = require('glob');
                const matches = glob.sync(fullPattern);
                for (const match of matches.slice(0, 2)) { // Max 2 per pattern
                    if (fs.existsSync(match) && !files.includes(match)) {
                        files.push(match);
                        log(`  [${fileType}] Found: ${path.basename(match)}`);
                        foundForType = true;
                    }
                }
            } catch (e) {
                // glob not available, try direct path
                const directPath = fullPattern.replace(/\*/g, '');
                if (fs.existsSync(directPath) && !files.includes(directPath)) {
                    files.push(directPath);
                    log(`  [${fileType}] Found: ${path.basename(directPath)}`);
                    foundForType = true;
                }
            }
        }

        if (!foundForType) {
            log(`  [${fileType}] No files found`, 'WARN');
        }
    }

    log(`Total context files to load: ${files.length}`);
    return files;
}

// Call OpenCode with prompt (using opencode-bridge pattern)
// files: array of file paths to attach
// cwd: working directory for OpenCode
// onProgress: callback for real-time updates
async function callOpencode(prompt, session, files = [], cwd = BASE_DIR, onProgress = null) {
    log(`Calling OpenCode with model: ${session.model}, agent: ${session.agent}`);
    log(`Prompt: ${prompt.substring(0, 150)}...`);
    if (files.length > 0) {
        log(`Attaching ${files.length} files: ${files.map(f => path.basename(f)).join(', ')}`);
    }

    const result = await runOpencode({
        message: prompt,
        files: files,
        model: session.model,
        agent: session.agent,
        variant: session.variant,
        sessionId: session.opencode_session_id,
        timeout: 600000,
        cwd: cwd,
        onProgress: onProgress
    });

    log(`OpenCode exit code: ${result.code}`);
    log(`OpenCode output length: ${result.output?.length || 0} chars`);

    // Check if output looks valid even with non-zero exit code
    // OpenCode sometimes returns exit code 1 with valid output
    const hasValidOutput = result.output && result.output.length > 50 && !result.output.includes('Permission required:');

    if (result.code !== 0 && !hasValidOutput) {
        log(`OpenCode error (no valid output): ${result.output?.substring(0, 500)}`);
        return { error: result.output, text: null, sessionId: null };
    }

    if (result.code !== 0 && hasValidOutput) {
        log(`OpenCode returned exit code ${result.code} but has valid output - treating as success`);
    }

    if (result.sessionId) {
        log(`Captured session ID: ${result.sessionId}`);
    }

    return {
        text: result.output || 'No response received',
        sessionId: result.sessionId || session.opencode_session_id,
        error: null
    };
}

// Process pending requests
async function processPendingRequests() {
    const requests = loadJSON(REQUESTS_FILE);
    const responses = loadJSON(RESPONSES_FILE);
    let session = loadSession();

    const pending = requests.filter(r => r.status === 'pending');

    if (pending.length === 0) {
        return 0;
    }

    log(`Found ${pending.length} pending request(s)`);
    log(`Using model: ${session.model}, agent: ${session.agent}, variant: ${session.variant}`);

    if (session.opencode_session_id) {
        log(`Continuing session: ${session.opencode_session_id}`);
    } else {
        log('Starting new OpenCode session');
    }

    let processed = 0;

    for (const req of pending) {
        const reqId = String(req.id);
        const commentId = req.comment_id || 'unknown';
        const prompt = req.prompt || '';

        if (!prompt) continue;

        log(`Processing request #${reqId} (${commentId})...`);

        try {
            const result = await callOpencode(prompt, session);
            session = result.session;

            // Save session for continuity
            saveSession(session);

            // Save response
            responses[reqId] = result.response;
            saveJSON(RESPONSES_FILE, responses);

            // Mark as delivered
            req.status = 'delivered';
            saveJSON(REQUESTS_FILE, requests);

            log(`✓ Request #${reqId} completed (${result.response.length} chars)`);
            processed++;

        } catch (e) {
            log(`✗ Request #${reqId} failed: ${e.message}`, 'ERROR');
        }
    }

    return processed;
}

// Watch for changes
async function watchAndProcess(interval = 2000) {
    const settings = getSettings();
    log('='.repeat(60));
    log('OpenCode Server Started');
    log('='.repeat(60));
    log(`Watching: ${REQUESTS_FILE}`);
    log(`Responses: ${RESPONSES_FILE}`);
    log(`Session: ${SESSION_FILE}`);
    log(`Config: ${CONFIG_FILE}`);
    log(`Model: ${settings.model}`);
    log(`Agent: ${settings.agent}`);
    log(`Variant: ${settings.variant}`);
    log(`Check interval: ${interval}ms`);
    log('='.repeat(60));

    // Process any existing pending requests
    await processPendingRequests();

    log('Watching for new requests... (Ctrl+C to stop)');

    let lastMtime = 0;
    try {
        lastMtime = fs.statSync(REQUESTS_FILE).mtimeMs;
    } catch (e) {}

    const check = async () => {
        try {
            if (fs.existsSync(REQUESTS_FILE)) {
                const currentMtime = fs.statSync(REQUESTS_FILE).mtimeMs;
                if (currentMtime > lastMtime) {
                    lastMtime = currentMtime;
                    await new Promise(r => setTimeout(r, 200)); // Small delay
                    const processed = await processPendingRequests();
                    if (processed > 0) {
                        log(`Processed ${processed} request(s)`);
                    }
                }
            }
        } catch (e) {
            log(`Error: ${e.message}`, 'ERROR');
        }
        setTimeout(check, interval);
    };

    check();
}

// Show session info
function showSessionInfo() {
    const session = loadSession();
    console.log('='.repeat(60));
    console.log('OpenCode Session Info');
    console.log('='.repeat(60));
    console.log(`Model: ${session.model}`);
    console.log(`Agent: ${session.agent}`);
    console.log(`Variant: ${session.variant}`);
    console.log(`Session ID: ${session.opencode_session_id || 'None (new session)'}`);
    console.log(`Messages in session: ${session.messages.length}`);
    console.log('='.repeat(60));
}

// Update config file
function updateConfig(newSettings) {
    try {
        const config = loadConfig();
        if (newSettings.model) config.model = newSettings.model;
        if (newSettings.agent) config.agent = newSettings.agent;
        if (newSettings.variant) config.variant = newSettings.variant;
        saveJSON(CONFIG_FILE, config);
        log(`Config updated: model=${config.model}, agent=${config.agent}, variant=${config.variant}`);
        return true;
    } catch (e) {
        log(`Error updating config: ${e.message}`, 'ERROR');
        return false;
    }
}

// Maximum request body size (10MB for file uploads, 1MB for regular requests)
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_JSON_SIZE = 1 * 1024 * 1024;  // 1MB

// Helper to collect request body with size limit
function collectBody(req, maxSize = MAX_JSON_SIZE) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                reject(new Error(`Request body too large (max ${Math.round(maxSize / 1024 / 1024)}MB)`));
                return;
            }
            body += chunk;
        });

        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// Simple HTTP API server for settings
function startApiServer(port = 3001) {
    const server = http.createServer((req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Health check endpoint
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            }));
            return;
        }

        // =====================================================
        // MULTI-PAPER API ENDPOINTS
        // =====================================================

        // GET /papers - list all papers (excluding deleted)
        if (req.method === 'GET' && req.url === '/papers') {
            let paperDb = null;
            try {
                const dbPath = path.join(PROJECT_FOLDER || BASE_DIR, 'data', 'review_platform.db');
                if (!fs.existsSync(dbPath)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify([]));
                    return;
                }
                paperDb = new Database(dbPath);
                const papers = paperDb.prepare(`
                    SELECT p.*,
                        COUNT(DISTINCT c.id) as total_comments,
                        SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) as completed_comments
                    FROM papers p
                    LEFT JOIN comments c ON p.id = c.paper_id
                    WHERE p.deleted_at IS NULL
                    GROUP BY p.id
                    ORDER BY p.updated_at DESC
                `).all();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(papers));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            } finally {
                if (paperDb) paperDb.close();
            }
            return;
        }

        // GET /papers/trash - list soft-deleted papers
        if (req.method === 'GET' && req.url === '/papers/trash') {
            try {
                const trashed = getTrashedPapers();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(trashed));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // POST /papers/:id/restore - restore a soft-deleted paper
        const restoreMatch = req.url.match(/^\/papers\/([^/]+)\/restore$/);
        if (req.method === 'POST' && restoreMatch) {
            const paperId = restoreMatch[1];
            try {
                const result = restorePaper(paperId);
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // DELETE /papers/:id/permanent - permanently delete a paper
        const permanentDeleteMatch = req.url.match(/^\/papers\/([^/]+)\/permanent$/);
        if (req.method === 'DELETE' && permanentDeleteMatch) {
            const paperId = permanentDeleteMatch[1];
            try {
                const result = permanentlyDeletePaper(paperId);
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // GET /papers/:id/data - get full paper data including reviewers and comments
        const paperDataMatch = req.url.match(/^\/papers\/([^/]+)\/data$/);
        if (req.method === 'GET' && paperDataMatch) {
            const paperId = paperDataMatch[1];
            try {
                if (!db) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Database not available' }));
                    return;
                }

                // Get paper info
                const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);
                if (!paper) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Paper not found' }));
                    return;
                }

                // Get reviewers for this paper
                const reviewers = db.prepare('SELECT * FROM reviewers WHERE paper_id = ?').all(paperId);

                // Get all comments for this paper
                const allComments = db.prepare('SELECT * FROM comments WHERE paper_id = ?').all(paperId);

                // Group comments by reviewer
                const reviewersWithComments = reviewers.map(r => ({
                    id: r.id.replace(`${paperId}_`, ''),
                    name: r.name,
                    expertise: r.expertise || '',
                    overall_sentiment: r.overall_sentiment || '',
                    source_file: r.source_file || '',
                    comments: allComments
                        .filter(c => c.reviewer_id === r.id)
                        .map(c => ({
                            id: c.id.replace(`${paperId}_`, ''),
                            type: c.type || 'minor',
                            category: c.category || 'General',
                            original_text: c.original_text || '',
                            priority: c.priority || 'medium',
                            status: c.status || 'pending',
                            draft_response: c.draft_response || '',
                            location: c.location || null,
                            full_context: c.full_context || null,
                            tags: c.tags ? (c.tags.startsWith('[') ? JSON.parse(c.tags) : c.tags.split(',').map(t => t.trim())) : []
                        }))
                }));

                // Get categories from comments
                const categories = [...new Set(allComments.map(c => c.category).filter(Boolean))];

                // Try to read thematic groups from _parsed_data.json if available
                let thematicGroups = {};
                const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);
                const parsedDataPath = path.join(paperDir, '_parsed_data.json');
                if (fs.existsSync(parsedDataPath)) {
                    try {
                        const parsedData = JSON.parse(fs.readFileSync(parsedDataPath, 'utf-8'));
                        thematicGroups = parsedData.thematic_groups || {};
                    } catch (e) { /* ignore */ }
                }

                // Structure data like the webapp expects
                const reviewData = {
                    manuscript: {
                        title: paper.title || 'Untitled',
                        authors: paper.authors || '',
                        journal: paper.journal || '',
                        field: paper.field || '',
                        submission_date: '',
                        review_date: paper.created_at || ''
                    },
                    categories: categories.length > 0 ? categories : ['General'],
                    thematic_groups: thematicGroups,
                    reviewers: reviewersWithComments,
                    parse_info: {
                        total_reviewers: reviewers.length,
                        total_comments: allComments.length
                    }
                };

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(reviewData));
            } catch (e) {
                log(`Error loading paper data: ${e.message}`, 'ERROR');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // GET /papers/:id/export/docx - generate Word document with responses
        const exportDocxMatch = req.url.match(/^\/papers\/([^/]+)\/export\/docx$/);
        if (req.method === 'GET' && exportDocxMatch) {
            const paperId = exportDocxMatch[1];
            (async () => {
            try {
                if (!db) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Database not available' }));
                    return;
                }

                // Get paper info
                const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);
                if (!paper) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Paper not found' }));
                    return;
                }

                // Get reviewers and comments
                const reviewers = db.prepare('SELECT * FROM reviewers WHERE paper_id = ?').all(paperId);
                const allComments = db.prepare('SELECT * FROM comments WHERE paper_id = ?').all(paperId);

                // Generate Word document
                const children = [];

                // Title
                children.push(new Paragraph({
                    heading: HeadingLevel.TITLE,
                    children: [new TextRun({ text: "Response to Reviewers", bold: true, size: 32 })]
                }));

                // Manuscript info
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: "Manuscript: ", bold: true }),
                        new TextRun(paper.title || 'Untitled')
                    ],
                    spacing: { before: 200, after: 100 }
                }));

                if (paper.authors) {
                    children.push(new Paragraph({
                        children: [
                            new TextRun({ text: "Authors: ", bold: true }),
                            new TextRun(paper.authors)
                        ],
                        spacing: { after: 200 }
                    }));
                }

                // Horizontal line
                children.push(new Paragraph({
                    border: { bottom: { style: BorderStyle.SINGLE, size: 1 } },
                    spacing: { after: 400 }
                }));

                // Process each reviewer
                for (const reviewer of reviewers) {
                    const reviewerComments = allComments.filter(c => c.reviewer_id === reviewer.id);

                    // Reviewer header
                    children.push(new Paragraph({
                        heading: HeadingLevel.HEADING_1,
                        children: [new TextRun({ text: reviewer.name, bold: true, size: 28 })]
                    }));

                    // Process each comment
                    for (const comment of reviewerComments) {
                        const shortId = comment.id.replace(`${paperId}_`, '');

                        // Comment header
                        const statusColor = {
                            'completed': '10B981',
                            'in_progress': '3B82F6',
                            'pending': 'F59E0B'
                        }[comment.status] || 'F59E0B';

                        children.push(new Paragraph({
                            heading: HeadingLevel.HEADING_2,
                            children: [
                                new TextRun({ text: `Comment ${shortId}`, bold: true, size: 24 }),
                                new TextRun({ text: ` [${(comment.type || 'minor').toUpperCase()}]`, size: 20 })
                            ],
                            spacing: { before: 300, after: 100 }
                        }));

                        // Original comment
                        children.push(new Paragraph({
                            children: [new TextRun({ text: "Reviewer Comment:", bold: true })],
                            spacing: { before: 100 }
                        }));

                        children.push(new Paragraph({
                            children: [new TextRun({ text: comment.original_text || '', italics: true })],
                            indent: { left: 400 },
                            shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' },
                            spacing: { after: 200 }
                        }));

                        // Our response
                        if (comment.draft_response) {
                            children.push(new Paragraph({
                                children: [new TextRun({ text: "Our Response:", bold: true, color: '059669' })]
                            }));

                            // Split response by newlines
                            const lines = comment.draft_response.split('\n');
                            for (const line of lines) {
                                if (line.trim()) {
                                    children.push(new Paragraph({
                                        children: [new TextRun(line)],
                                        indent: { left: 400 },
                                        spacing: { after: 100 }
                                    }));
                                }
                            }
                        } else {
                            children.push(new Paragraph({
                                children: [new TextRun({ text: "[No response drafted yet]", italics: true, color: '9CA3AF' })],
                                indent: { left: 400 },
                                spacing: { after: 200 }
                            }));
                        }

                        // Separator
                        children.push(new Paragraph({
                            border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' } },
                            spacing: { after: 200 }
                        }));
                    }
                }

                // Create document
                const doc = new Document({
                    styles: {
                        default: {
                            document: {
                                run: { font: "Arial", size: 22 }
                            }
                        }
                    },
                    sections: [{
                        properties: {
                            page: {
                                size: { width: 12240, height: 15840 },
                                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
                            }
                        },
                        children: children
                    }]
                });

                const buffer = await Packer.toBuffer(doc);
                const filename = `response_to_reviewers_${paperId}.docx`;

                res.writeHead(200, {
                    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'Content-Disposition': `attachment; filename="${filename}"`,
                    'Content-Length': buffer.length
                });
                res.end(buffer);
                log(`Generated Word document for paper ${paperId}`);
            } catch (e) {
                log(`Error generating Word document: ${e.message}`, 'ERROR');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            })();
            return;
        }

        // POST /papers/:id/export/ai-rebuttal - generate professional AI rebuttal letter
        const aiRebuttalMatch = req.url.match(/^\/papers\/([^/]+)\/export\/ai-rebuttal$/);
        if (req.method === 'POST' && aiRebuttalMatch) {
            const paperId = aiRebuttalMatch[1];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                (async () => {
                try {
                    const rebuttalData = JSON.parse(body);

                    // Generate professional rebuttal document
                    const children = [];

                    // Title
                    children.push(new Paragraph({
                        heading: HeadingLevel.TITLE,
                        children: [new TextRun({ text: "Response to Reviewers", bold: true, size: 36 })],
                        spacing: { after: 200 }
                    }));

                    // Manuscript title
                    if (rebuttalData.manuscript?.title) {
                        children.push(new Paragraph({
                            children: [
                                new TextRun({ text: "Manuscript: ", bold: true }),
                                new TextRun({ text: rebuttalData.manuscript.title, italics: true })
                            ],
                            spacing: { after: 400 }
                        }));
                    }

                    // Introduction paragraph
                    children.push(new Paragraph({
                        children: [new TextRun({
                            text: "We thank the reviewers for their careful evaluation of our manuscript and their constructive feedback. We have addressed all comments and made revisions accordingly. In this document, we provide point-by-point responses to each reviewer's comments. Reviewer comments are shown in italics, followed by our responses.",
                            size: 22
                        })],
                        spacing: { after: 400 }
                    }));

                    // Horizontal line
                    children.push(new Paragraph({
                        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
                        spacing: { after: 400 }
                    }));

                    // Process each reviewer
                    for (const reviewer of rebuttalData.reviewers || []) {
                        if (!reviewer.comments || reviewer.comments.length === 0) continue;

                        // Reviewer header
                        children.push(new Paragraph({
                            heading: HeadingLevel.HEADING_1,
                            children: [new TextRun({ text: reviewer.name, bold: true, size: 28 })],
                            spacing: { before: 400, after: 200 }
                        }));

                        // Thank reviewer
                        children.push(new Paragraph({
                            children: [new TextRun({
                                text: `We thank ${reviewer.name.replace(/\(.*\)/, '').trim()} for their thoughtful review and valuable suggestions.`,
                                size: 22
                            })],
                            spacing: { after: 300 }
                        }));

                        // Process each comment
                        for (const comment of reviewer.comments) {
                            // Comment number header
                            children.push(new Paragraph({
                                children: [
                                    new TextRun({ text: `Comment ${comment.id}`, bold: true, size: 24 }),
                                    comment.type === 'major'
                                        ? new TextRun({ text: ' [MAJOR]', bold: true, color: 'DC2626', size: 20 })
                                        : new TextRun({ text: ' [minor]', color: '6B7280', size: 20 })
                                ],
                                spacing: { before: 300, after: 100 }
                            }));

                            // Reviewer comment (italic, indented, gray background)
                            const commentLines = (comment.original_text || '').split('\n');
                            for (const line of commentLines) {
                                if (line.trim()) {
                                    children.push(new Paragraph({
                                        children: [new TextRun({ text: line, italics: true, size: 22 })],
                                        indent: { left: 400 },
                                        shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' },
                                        spacing: { after: 50 }
                                    }));
                                }
                            }

                            // Spacing after reviewer comment
                            children.push(new Paragraph({ spacing: { after: 150 } }));

                            // Author response header
                            children.push(new Paragraph({
                                children: [new TextRun({ text: "Response:", bold: true, color: '059669', size: 22 })],
                                spacing: { after: 100 }
                            }));

                            // Response text
                            const responseLines = (comment.draft_response || '[No response provided]').split('\n');
                            for (const line of responseLines) {
                                if (line.trim()) {
                                    // Check if line contains manuscript quote (text between quotes or starting with line numbers)
                                    const isQuote = line.match(/^[""].*[""]$/) || line.match(/^\(lines?\s*\d+/i) || line.match(/^".*"$/);

                                    if (isQuote) {
                                        children.push(new Paragraph({
                                            children: [new TextRun({ text: line, color: '2563EB', size: 22 })],
                                            indent: { left: 600 },
                                            spacing: { after: 50 }
                                        }));
                                    } else {
                                        children.push(new Paragraph({
                                            children: [new TextRun({ text: line, size: 22 })],
                                            indent: { left: 400 },
                                            spacing: { after: 50 }
                                        }));
                                    }
                                }
                            }

                            // Separator line
                            children.push(new Paragraph({
                                border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' } },
                                spacing: { before: 200, after: 200 }
                            }));
                        }
                    }

                    // Create document
                    const doc = new Document({
                        styles: {
                            default: {
                                document: {
                                    run: { font: "Times New Roman", size: 24 }
                                }
                            }
                        },
                        sections: [{
                            properties: {
                                page: {
                                    size: { width: 12240, height: 15840 }, // Letter size
                                    margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
                                }
                            },
                            children: children
                        }]
                    });

                    const buffer = await Packer.toBuffer(doc);
                    const filename = `rebuttal_letter_${paperId}.docx`;

                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        'Content-Disposition': `attachment; filename="${filename}"`,
                        'Content-Length': buffer.length
                    });
                    res.end(buffer);
                    log(`Generated AI rebuttal letter for paper ${paperId}`);
                } catch (e) {
                    log(`Error generating AI rebuttal: ${e.message}`, 'ERROR');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                })();
            });
            return;
        }

        // POST /papers/:id/export/collaboration - generate collaboration export document
        const collabExportMatch = req.url.match(/^\/papers\/([^/]+)\/export\/collaboration$/);
        if (req.method === 'POST' && collabExportMatch) {
            const paperId = collabExportMatch[1];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                (async () => {
                try {
                    const exportData = JSON.parse(body);
                    const selectedIds = exportData.selectedCommentIds || [];
                    const children = [];

                    // ========== PART 1: SELECTED COMMENTS WITH SPACE FOR RESPONSE ==========

                    // Title
                    children.push(new Paragraph({
                        heading: HeadingLevel.HEADING_1,
                        children: [new TextRun({ text: "Comments for Co-Author Review", bold: true, size: 32 })],
                        spacing: { after: 200 }
                    }));

                    // Subtitle with selection info
                    children.push(new Paragraph({
                        children: [new TextRun({
                            text: `${selectedIds.length} comment${selectedIds.length !== 1 ? 's' : ''} selected - please provide your response below each comment`,
                            size: 22,
                            italics: true,
                            color: '666666'
                        })],
                        spacing: { after: 400 }
                    }));

                    // Process each reviewer's selected comments
                    for (const reviewer of exportData.reviewers || []) {
                        const selectedComments = (reviewer.comments || []).filter(c => c.isSelected);
                        if (selectedComments.length === 0) continue;

                        // Reviewer header
                        children.push(new Paragraph({
                            heading: HeadingLevel.HEADING_2,
                            children: [new TextRun({ text: reviewer.name, bold: true, size: 26 })],
                            spacing: { before: 400, after: 200 }
                        }));

                        // Process each selected comment
                        for (const comment of selectedComments) {
                            // Comment number header
                            children.push(new Paragraph({
                                children: [
                                    new TextRun({ text: `Comment ${comment.id}`, bold: true, size: 24 }),
                                    comment.type === 'major'
                                        ? new TextRun({ text: ' [MAJOR]', bold: true, color: 'DC2626', size: 20 })
                                        : new TextRun({ text: ' [minor]', color: '6B7280', size: 20 })
                                ],
                                spacing: { before: 300, after: 100 }
                            }));

                            // Reviewer comment (italic, with gray background)
                            const commentLines = (comment.original_text || '').split('\n');
                            for (const line of commentLines) {
                                if (line.trim()) {
                                    children.push(new Paragraph({
                                        children: [new TextRun({ text: line, italics: true, size: 22 })],
                                        indent: { left: 400 },
                                        shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' },
                                        spacing: { after: 50 }
                                    }));
                                }
                            }

                            children.push(new Paragraph({ spacing: { after: 150 } }));

                            // Response header
                            children.push(new Paragraph({
                                children: [new TextRun({ text: "Your Response:", bold: true, color: '059669', size: 22 })],
                                spacing: { after: 100 }
                            }));

                            // Empty lines for response (light blue background)
                            for (let i = 0; i < 6; i++) {
                                children.push(new Paragraph({
                                    children: [new TextRun({ text: " ", size: 22 })],
                                    indent: { left: 400 },
                                    shading: { type: ShadingType.CLEAR, fill: 'EFF6FF' },
                                    spacing: { after: 50 }
                                }));
                            }

                            // Separator
                            children.push(new Paragraph({
                                border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' } },
                                spacing: { after: 300 }
                            }));
                        }
                    }

                    // ========== PAGE BREAK ==========
                    children.push(new Paragraph({
                        children: [],
                        pageBreakBefore: true
                    }));

                    // ========== PART 2: COMPLETE REVIEWER DOCUMENT WITH HIGHLIGHTS ==========

                    children.push(new Paragraph({
                        heading: HeadingLevel.HEADING_1,
                        children: [new TextRun({ text: "Complete Reviewer Comments", bold: true, size: 32 })],
                        spacing: { after: 200 }
                    }));

                    children.push(new Paragraph({
                        children: [new TextRun({
                            text: "Comments highlighted in yellow are those selected for review above.",
                            size: 22,
                            italics: true,
                            color: '666666'
                        })],
                        spacing: { after: 400 }
                    }));

                    // Process all reviewers and all comments, highlighting selected ones
                    for (const reviewer of exportData.reviewers || []) {
                        if (!reviewer.comments || reviewer.comments.length === 0) continue;

                        // Reviewer header
                        children.push(new Paragraph({
                            heading: HeadingLevel.HEADING_2,
                            children: [new TextRun({ text: reviewer.name, bold: true, size: 26 })],
                            spacing: { before: 400, after: 200 }
                        }));

                        // All comments from this reviewer
                        for (const comment of reviewer.comments) {
                            const isSelected = comment.isSelected;
                            const highlightColor = isSelected ? 'FFFF00' : null; // Yellow highlight

                            // Comment ID header
                            children.push(new Paragraph({
                                children: [
                                    new TextRun({
                                        text: `${comment.id}`,
                                        bold: true,
                                        size: 22,
                                        highlight: isSelected ? 'yellow' : undefined
                                    }),
                                    new TextRun({ text: ' ', size: 22 }),
                                    comment.type === 'major'
                                        ? new TextRun({ text: '[MAJOR]', bold: true, color: 'DC2626', size: 18 })
                                        : new TextRun({ text: '[minor]', color: '6B7280', size: 18 }),
                                    isSelected
                                        ? new TextRun({ text: ' ★ SELECTED FOR REVIEW', bold: true, color: '2563EB', size: 18 })
                                        : new TextRun({ text: '' })
                                ],
                                spacing: { before: 200, after: 100 }
                            }));

                            // Comment text
                            const commentLines = (comment.original_text || '').split('\n');
                            for (const line of commentLines) {
                                if (line.trim()) {
                                    children.push(new Paragraph({
                                        children: [new TextRun({
                                            text: line,
                                            size: 22,
                                            highlight: isSelected ? 'yellow' : undefined
                                        })],
                                        spacing: { after: 50 }
                                    }));
                                }
                            }

                            children.push(new Paragraph({ spacing: { after: 150 } }));
                        }
                    }

                    // Create document
                    const doc = new Document({
                        styles: {
                            default: {
                                document: {
                                    run: { font: "Times New Roman", size: 24 }
                                }
                            }
                        },
                        sections: [{
                            properties: {
                                page: {
                                    size: { width: 12240, height: 15840 },
                                    margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
                                }
                            },
                            children: children
                        }]
                    });

                    const buffer = await Packer.toBuffer(doc);
                    const filename = `collaboration_review_${paperId}.docx`;

                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        'Content-Disposition': `attachment; filename="${filename}"`,
                        'Content-Length': buffer.length
                    });
                    res.end(buffer);
                    log(`Generated collaboration export for paper ${paperId} (${selectedIds.length} comments)`);
                } catch (e) {
                    log(`Error generating collaboration export: ${e.message}`, 'ERROR');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
                })();
            });
            return;
        }

        // GET /papers/:id/review-files - get review files for a specific paper
        const paperReviewFilesMatch = req.url.match(/^\/papers\/([^/]+)\/review-files$/);
        if (req.method === 'GET' && paperReviewFilesMatch) {
            const paperId = paperReviewFilesMatch[1];
            try {
                // Look for review files in the paper's reviews folder
                const paperReviewsDir = path.join(PROJECT_FOLDER || BASE_DIR, 'papers', paperId, 'reviews');

                if (!fs.existsSync(paperReviewsDir)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ files: [], message: 'No reviews folder found' }));
                    return;
                }

                const files = fs.readdirSync(paperReviewsDir)
                    .filter(f => {
                        const ext = path.extname(f).toLowerCase();
                        return ['.txt', '.docx', '.pdf', '.md'].includes(ext);
                    })
                    .map(f => {
                        const filePath = path.join(paperReviewsDir, f);
                        const stats = fs.statSync(filePath);
                        const sizeKB = (stats.size / 1024).toFixed(1);
                        return {
                            name: f,
                            path: filePath,
                            size: stats.size,
                            sizeHuman: sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`
                        };
                    });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ files, folder: paperReviewsDir }));
            } catch (e) {
                console.error('Error getting review files:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // POST /read-file - read file content (txt or docx)
        if (req.method === 'POST' && req.url === '/read-file') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { path: filePath } = JSON.parse(body);

                    if (!filePath || !fs.existsSync(filePath)) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'File not found', path: filePath }));
                        return;
                    }

                    const ext = path.extname(filePath).toLowerCase();
                    let content = '';

                    if (ext === '.txt' || ext === '.md') {
                        content = fs.readFileSync(filePath, 'utf8');
                    } else if (ext === '.docx') {
                        // Use mammoth to extract text from docx
                        try {
                            const mammoth = require('mammoth');
                            const result = await mammoth.extractRawText({ path: filePath });
                            content = result.value;
                        } catch (e) {
                            // Fallback: try to read as text
                            console.error('Mammoth error, trying raw read:', e.message);
                            content = fs.readFileSync(filePath, 'utf8');
                        }
                    } else {
                        content = fs.readFileSync(filePath, 'utf8');
                    }

                    console.log(`[INFO] Read file: ${filePath} (${content.length} chars)`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ content, path: filePath, size: content.length }));
                } catch (e) {
                    console.error('Error reading file:', e);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // POST /papers/:id/clear - clear all comments and reviewers for a paper (keeps the paper itself)
        const paperClearMatch = req.url.match(/^\/papers\/([^/]+)\/clear$/);
        if (req.method === 'POST' && paperClearMatch) {
            const paperId = paperClearMatch[1];
            let paperDb = null;
            try {
                const dbPath = path.join(PROJECT_FOLDER || BASE_DIR, 'data', 'review_platform.db');
                paperDb = new Database(dbPath);

                // Delete comments for this paper
                const commentsDeleted = paperDb.prepare('DELETE FROM comments WHERE paper_id = ?').run(paperId);

                // Delete reviewers for this paper
                const reviewersDeleted = paperDb.prepare('DELETE FROM reviewers WHERE paper_id = ?').run(paperId);

                console.log(`[INFO] Cleared paper ${paperId}: ${reviewersDeleted.changes} reviewers, ${commentsDeleted.changes} comments`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    cleared: {
                        reviewers: reviewersDeleted.changes,
                        comments: commentsDeleted.changes
                    }
                }));
            } catch (e) {
                console.error('Error clearing paper data:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            } finally {
                if (paperDb) paperDb.close();
            }
            return;
        }

        // POST /papers - create a new paper
        if (req.method === 'POST' && req.url === '/papers') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.title) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Title is required' }));
                        return;
                    }

                    const dbPath = path.join(PROJECT_FOLDER || BASE_DIR, 'data', 'review_platform.db');
                    const paperDb = new Database(dbPath);

                    // Generate UUID
                    const paperId = crypto.randomUUID();

                    paperDb.prepare(`
                        INSERT INTO papers (id, title, authors, journal, field, description, review_date, config)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        paperId,
                        data.title,
                        data.authors || '',
                        data.journal || '',
                        data.field || '',
                        data.description || '',
                        new Date().toISOString().split('T')[0],
                        JSON.stringify(data.config || {})
                    );

                    // Create paper directory (consistent with /api/setup/* endpoints)
                    const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);
                    fs.mkdirSync(paperDir, { recursive: true });
                    fs.mkdirSync(path.join(paperDir, 'manuscript'), { recursive: true });
                    fs.mkdirSync(path.join(paperDir, 'reviews'), { recursive: true });
                    fs.mkdirSync(path.join(paperDir, 'supplementary'), { recursive: true });

                    paperDb.close();
                    res.writeHead(201, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, id: paperId }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // GET /papers/:id/status - Get processing job status for a paper
        const statusMatch = req.url.match(/^\/papers\/([^/]+)\/status$/);
        if (req.method === 'GET' && statusMatch) {
            const paperId = statusMatch[1];
            try {
                // First check for active job, then latest job
                let job = getActiveJobForPaper(paperId);
                if (!job) {
                    job = getLatestJobForPaper(paperId);
                }

                if (job) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(job));
                    return;
                }

                // No job found - check paper status directly and _status.json file
                const paper = db ? db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId) : null;
                const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);
                const statusFile = path.join(paperDir, '_status.json');

                let statusData = { status: paper?.status || 'none', paper_id: paperId };

                // Try to read _status.json for more details
                if (fs.existsSync(statusFile)) {
                    try {
                        const fileData = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
                        statusData = { ...statusData, ...fileData };
                    } catch (e) { /* ignore */ }
                }

                // Count files in paper directory
                if (fs.existsSync(paperDir)) {
                    const countFiles = (dir) => {
                        if (!fs.existsSync(dir)) return [];
                        return fs.readdirSync(dir).filter(f => !f.startsWith('.') && !f.startsWith('_'));
                    };
                    statusData.files = {
                        manuscript: countFiles(path.join(paperDir, 'manuscript')),
                        reviews: countFiles(path.join(paperDir, 'reviews')),
                        supplementary: countFiles(path.join(paperDir, 'supplementary'))
                    };
                }

                // Add paper metadata
                if (paper) {
                    statusData.title = paper.title;
                    statusData.error_message = paper.error_message;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(statusData));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // POST /papers/:id/start-processing - Start processing for already-uploaded files
        // This endpoint is for papers where files were uploaded via /api/setup/upload
        // Returns job ID for status polling
        const startProcessingMatch = req.url.match(/^\/papers\/([^/]+)\/start-processing$/);
        if (req.method === 'POST' && startProcessingMatch) {
            const paperId = startProcessingMatch[1];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const options = body ? JSON.parse(body) : {};

                    // Find the paper directory
                    const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);
                    if (!fs.existsSync(paperDir)) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Paper directory not found' }));
                        return;
                    }

                    // Scan for existing files in the paper directory
                    const savedFiles = [];
                    const categories = ['manuscript', 'reviews', 'supplementary'];

                    for (const category of categories) {
                        const categoryDir = path.join(paperDir, category);
                        if (fs.existsSync(categoryDir)) {
                            const files = fs.readdirSync(categoryDir);
                            for (const file of files) {
                                if (file.startsWith('.')) continue; // Skip hidden files
                                const filePath = path.join(categoryDir, file);
                                if (fs.statSync(filePath).isFile()) {
                                    savedFiles.push({
                                        path: filePath,
                                        name: file,
                                        category: category === 'reviews' ? 'review' : category,
                                        ext: path.extname(file).toLowerCase()
                                    });
                                }
                            }
                        }
                    }

                    if (savedFiles.length === 0) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'No files found in paper directory' }));
                        return;
                    }

                    log(`[start-processing] Found ${savedFiles.length} files for paper ${paperId}`);

                    // Count files by category
                    const fileCounts = {
                        manuscript: savedFiles.filter(f => f.category === 'manuscript'),
                        reviews: savedFiles.filter(f => f.category === 'review'),
                        supplementary: savedFiles.filter(f => f.category === 'supplementary')
                    };

                    // Create processing job
                    const job = createProcessingJob(paperId);
                    updateProcessingJob(job.id, {
                        status: 'processing',
                        total_steps: savedFiles.length + 1,
                        files: fileCounts,
                        log: `Starting processing for ${savedFiles.length} existing files`
                    });

                    // Return immediately with job ID
                    res.writeHead(202, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        job_id: job.id,
                        paper_id: paperId,
                        files_found: savedFiles.length,
                        message: 'Processing started in background. Poll /papers/:id/status for updates.'
                    }));

                    // Start background processing
                    setImmediate(() => runBackgroundProcessing(job.id, paperId, paperDir, savedFiles));

                } catch (e) {
                    log(`Error starting processing: ${e.message}`, 'ERROR');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // POST /papers/:id/process - Upload files and process with OpenCode skills
        // Files are saved immediately, processing runs in background
        // Returns job ID for status polling
        const processMatch = req.url.match(/^\/papers\/([^/]+)\/process$/);
        if (req.method === 'POST' && processMatch) {
            const paperId = processMatch[1];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { files } = JSON.parse(body);
                    // files: [{ name, category, data (base64) }]

                    if (!files || files.length === 0) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'No files provided' }));
                        return;
                    }

                    // Use consistent path with /api/setup/* endpoints
                    const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);
                    fs.mkdirSync(paperDir, { recursive: true });

                    // Save files to appropriate subdirectories
                    // Normalize category names: "review" -> "reviews" to match expected folder structure
                    const normalizeCategoryDir = (cat) => cat === 'review' ? 'reviews' : cat;

                    const savedFiles = [];
                    for (const file of files) {
                        const categoryDirName = normalizeCategoryDir(file.category);
                        const categoryDir = path.join(paperDir, categoryDirName);
                        fs.mkdirSync(categoryDir, { recursive: true });

                        const filePath = path.join(categoryDir, file.name);
                        const buffer = Buffer.from(file.data, 'base64');
                        fs.writeFileSync(filePath, buffer);

                        savedFiles.push({
                            path: filePath,
                            name: file.name,
                            category: file.category,  // Keep original category for processing logic
                            ext: path.extname(file.name).toLowerCase()
                        });
                        log(`Saved file: ${file.name} to ${categoryDirName}/`);
                    }

                    // Create processing job
                    const job = createProcessingJob(paperId);
                    updateProcessingJob(job.id, {
                        status: 'processing',
                        total_steps: savedFiles.length + 1, // files + summary step
                        log: `Starting processing for ${savedFiles.length} files`
                    });

                    // Return immediately with job ID
                    res.writeHead(202, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        job_id: job.id,
                        paper_id: paperId,
                        files_saved: savedFiles.length,
                        message: 'Processing started in background. Poll /papers/:id/status for updates.'
                    }));

                    // Start background processing
                    setImmediate(() => runBackgroundProcessing(job.id, paperId, paperDir, savedFiles));

                } catch (e) {
                    log(`Error starting processing: ${e.message}`, 'ERROR');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // Background processing function (runs after response is sent)
        async function runBackgroundProcessing(jobId, paperId, paperDir, savedFiles) {
            try {
                log(`[Background] Starting processing job ${jobId} for paper ${paperId}`);

                // Load paper-specific session settings (contains the AI config selected by user)
                const paperSession = getPaperSession(paperId);
                const fallbackConfig = loadConfig();
                const modelToUse = paperSession?.model || fallbackConfig.model || 'github-copilot/gpt-5.2';
                const agentToUse = paperSession?.agent || fallbackConfig.agent || 'general';
                const variantToUse = paperSession?.variant || fallbackConfig.variant || 'high';
                log(`[Background] Using model=${modelToUse}, agent=${agentToUse}, variant=${variantToUse}`);

                // Callback for real-time AI reasoning updates - verbose output like webapp chat
                const streamProgress = (event) => {
                    if (event.message) {
                        // Filter out unwanted "context handoff" type messages
                        const msg = event.message.toLowerCase();
                        if (msg.includes('use this exact prompt') ||
                            msg.includes('new session') ||
                            msg.includes('context summary') ||
                            msg.includes('paste in a new') ||
                            msg.includes('continue if you have') ||
                            msg.includes('pick which tasks') ||
                            msg.includes('i can take the next step') ||
                            msg.includes("can't read the pdf") ||
                            msg.includes("can't parse pdf") ||
                            msg.includes('how would you like me to proceed') ||
                            msg.includes('which do you prefer') ||
                            msg.includes('upload a text/docx')) {
                            return; // Skip these messages
                        }

                        // Add type prefix for better visual distinction in log
                        let prefix = '';
                        switch (event.type) {
                            case 'reasoning': prefix = '[Thinking]'; break;
                            case 'tool': prefix = '[Tool]'; break;
                            case 'tool_result': prefix = '[Result]'; break;
                            case 'text': prefix = '[Output]'; break;
                            case 'assistant': prefix = '[AI]'; break;
                            default: prefix = '[AI]';
                        }
                        updateProcessingJob(jobId, {
                            log: `${prefix} ${event.message}`
                        });
                    }
                };

                // Process files one by one - convert and collect for attachment
                // Order: manuscript → supplementary → reviews (organize before parsing)
                let fileIndex = 0;
                const totalFiles = savedFiles.length;

                // Collect all processed/converted files for context attachment
                const processedFiles = [];
                let manuscriptPlainText = null;  // For line reference context

                // Step 1: Process MANUSCRIPT files first (establish paper context)
                const manuscripts = savedFiles.filter(f => f.category === 'manuscript');
                for (const file of manuscripts) {
                    fileIndex++;

                    // Pre-convert docx/pdf to markdown to avoid /tmp permission issues
                    let fileToProcess = file.path;
                    let isConverted = false;
                    if (file.ext === '.docx' || file.ext === '.doc' || file.ext === '.pdf') {
                        const fileType = file.ext === '.pdf' ? 'PDF' : 'manuscript';
                        updateProcessingJob(jobId, {
                            log: `[${fileIndex}/${totalFiles}] Converting ${fileType} to markdown...`
                        });
                        fileToProcess = await convertToText(file.path, paperDir);
                        isConverted = fileToProcess !== file.path;
                    }

                    updateProcessingJob(jobId, {
                        current_step: 'processing_manuscript',
                        current_file: file.name,
                        progress: Math.round((fileIndex / (totalFiles + 1)) * 100),
                        log: `[${fileIndex}/${totalFiles}] Loading manuscript: ${file.name}${isConverted ? ' (converted)' : ''}`
                    });

                    // Extract plain text from manuscript for line reference context
                    if (!manuscriptPlainText) {
                        try {
                            if (file.ext === '.docx' || file.ext === '.doc') {
                                const { execSync } = require('child_process');
                                manuscriptPlainText = execSync(`pandoc -t plain "${file.path}"`, {
                                    encoding: 'utf-8',
                                    maxBuffer: 50 * 1024 * 1024
                                });
                                log(`[Background] Extracted manuscript text: ${manuscriptPlainText.split('\n').length} lines`);
                            } else if (['.md', '.txt', '.text'].includes(file.ext)) {
                                manuscriptPlainText = fs.readFileSync(file.path, 'utf-8');
                            }
                        } catch (convErr) {
                            log(`[Background] Could not extract manuscript text: ${convErr.message}`, 'WARN');
                        }
                    }

                    // For file loading: DON'T use AI sessions - just add to processed files
                    // All files will be attached to the summary/analysis steps
                    // Track processed file for context attachment
                    processedFiles.push({ path: fileToProcess, category: 'manuscript', name: file.name });
                    updateProcessingJob(jobId, {
                        log: `Manuscript loaded: ${file.name}`
                    });
                }

                // Step 2: Process SUPPLEMENTARY files (add data/figures context)
                const supplementary = savedFiles.filter(f => f.category === 'supplementary');
                for (const file of supplementary) {
                    fileIndex++;

                    // Pre-convert docx/xlsx/pdf to markdown to avoid /tmp permission issues
                    let fileToProcess = file.path;
                    let isConverted = false;
                    if (file.ext === '.docx' || file.ext === '.doc' || file.ext === '.xlsx' || file.ext === '.xls' || file.ext === '.pdf') {
                        const fileType = (file.ext === '.xlsx' || file.ext === '.xls') ? 'Excel' : (file.ext === '.pdf' ? 'PDF' : 'docx');
                        updateProcessingJob(jobId, {
                            current_step: 'processing_supplementary',
                            current_file: file.name,
                            progress: Math.round((fileIndex / (totalFiles + 1)) * 100),
                            log: `[${fileIndex}/${totalFiles}] Converting ${fileType} to markdown...`
                        });
                        fileToProcess = await convertToText(file.path, paperDir);
                        isConverted = fileToProcess !== file.path;
                    }

                    updateProcessingJob(jobId, {
                        current_step: 'processing_supplementary',
                        current_file: file.name,
                        progress: Math.round((fileIndex / (totalFiles + 1)) * 100),
                        log: `[${fileIndex}/${totalFiles}] Loading supplementary: ${file.name}`
                    });

                    // For file loading: DON'T use sessions - just add to processed files
                    // All files will be attached to the summary/analysis steps
                    processedFiles.push({ path: fileToProcess, category: 'supplementary', name: file.name });
                    updateProcessingJob(jobId, {
                        log: `Supplementary loaded: ${file.name}${isConverted ? ' (converted)' : ''}`
                    });
                }

                // Step 3: Process REVIEW files (with full manuscript + supplementary context)
                const reviews = savedFiles.filter(f => f.category === 'review');
                for (const file of reviews) {
                    fileIndex++;

                    // Pre-convert docx/pdf to markdown to avoid /tmp permission issues
                    let fileToProcess = file.path;
                    let isConverted = false;
                    if (file.ext === '.docx' || file.ext === '.doc' || file.ext === '.pdf') {
                        const fileType = file.ext === '.pdf' ? 'PDF' : 'reviews';
                        updateProcessingJob(jobId, {
                            log: `[${fileIndex}/${totalFiles}] Converting ${fileType} to markdown...`
                        });
                        fileToProcess = await convertToText(file.path, paperDir);
                        isConverted = fileToProcess !== file.path;
                    }

                    updateProcessingJob(jobId, {
                        current_step: 'processing_reviews',
                        current_file: file.name,
                        progress: Math.round((fileIndex / (totalFiles + 1)) * 100),
                        log: `[${fileIndex}/${totalFiles}] Loading review: ${file.name}${isConverted ? ' (converted)' : ''}`
                    });

                    // For file loading: DON'T use AI sessions - just add to processed files
                    // The actual analysis happens in the summary step with all files attached
                    // Track processed file for context attachment
                    processedFiles.push({ path: fileToProcess, category: 'review', name: file.name });
                    updateProcessingJob(jobId, {
                        log: `Reviews processed: ${file.name}`
                    });
                }

                // Step 4: Smart file preparation - use worker sessions for large supplementary files
                const TOKEN_BUDGET = 100000;  // Leave headroom for prompt + response in 128K model

                updateProcessingJob(jobId, {
                    current_step: 'preparing_context',
                    current_file: null,
                    progress: Math.round((totalFiles / (totalFiles + 1)) * 100),
                    log: `Preparing files for context (creating worker sessions for large files)...`
                });

                const budgetResult = await prepareFilesForContext(
                    paperId, processedFiles, TOKEN_BUDGET, paperDir,
                    modelToUse, agentToUse, variantToUse, streamProgress
                );

                updateProcessingJob(jobId, {
                    current_step: 'summarizing',
                    log: `Extracting comments (~${budgetResult.estimatedTokens} tokens, ${budgetResult.prepared.length} files${budgetResult.workersCreated > 0 ? `, ${budgetResult.workersCreated} worker sessions` : ''})...`
                });

                const summaryPrompt = `READ the attached review document and extract ALL individual ACTIONABLE comments as separate entries.

CRITICAL: Output JSON IMMEDIATELY. Do NOT ask questions, request clarification, enter planning mode, or say "I'll analyze...". Just extract and output.

CRITICAL RULES - WHAT TO EXTRACT:
- Extract EVERY distinct ACTIONABLE point as a SEPARATE comment entry
- If reviewer says "Line 33: fix X" and "Line 45: fix Y" = TWO separate comments
- If reviewer lists multiple items under "Minor:" = EACH item is a separate comment
- Each actionable request, question, concern, or criticism = one comment entry
- Same reviewer with multiple sections (e.g., "Remarks to Author" + "Remarks on code") = ONE reviewer, but keep all their individual comments separate

CRITICAL RULES - WHAT TO EXCLUDE:
- EXCLUDE descriptive summaries of what the paper does (context, not comments)
- EXCLUDE background/introductory paragraphs that just set up later critiques
- EXCLUDE general praise or neutral observations with no action required
- DO NOT create duplicate entries for the same conceptual point stated different ways
- "The paper describes X" alone = NOT a comment (just context)
- "The paper describes X but fails to Y" = ONE comment (the concern about Y)
- "This is interesting work" = NOT a comment (no action needed)

DEDUPLICATION:
- If the same criticism appears in different words, extract it ONCE only
- If multiple reviewers make the SAME point, each reviewer gets their own entry (but no duplicates within one reviewer)

IDENTIFICATION:
- Reviewers can be: "Referee #1", "Reviewer 1", "Reviewer A", "Associate Editor", etc.
- Use IDs: referee-1, referee-2, etc.

OUTPUT THIS JSON:
{
  "paper": {"title": "from manuscript", "field": "research field"},
  "reviewers": [
    {
      "id": "referee-1",
      "name": "Original label from document",
      "comments": [
        {
          "id": "R1.1",
          "type": "major",
          "category": "Methodology/Results/Clarity/Citation/Figure/Data",
          "original_text": "The exact text of this ONE specific point",
          "summary": "one sentence"
        },
        {
          "id": "R1.2",
          "type": "minor",
          "category": "Clarity",
          "original_text": "Line 33: Do you mean recent advances?",
          "summary": "Clarify wording on line 33"
        }
      ]
    }
  ],
  "summary": {"total_comments": 0, "major_comments": 0, "minor_comments": 0}
}

MAJOR = challenges methodology, requests new experiments/analysis, questions core conclusions
MINOR = wording, citations, formatting, line-specific edits, figure labels

WRITING STYLE:
- Write summaries in plain English, no jargon
- NEVER use camelCase phrases like "KeyInsight", "CoreFinding", "MainPoint", "ActionItem"
- NEVER use bullet-style phrases like "Re: methodology" or "Note: important"
- Write naturally: "Clarify the methodology" not "MethodologyClarification needed"

OUTPUT ONLY THE JSON.`;

                let result = await runOpencode({
                    message: summaryPrompt,
                    files: budgetResult.files, // Smart selection within token budget
                    model: modelToUse,
                    agent: agentToUse,
                    variant: variantToUse,
                    // NO session ID - fresh context prevents AI asking questions
                    timeout: 600000,
                    cwd: paperDir,
                    onProgress: streamProgress
                });

                // Parse the JSON response from result.output
                log(`[Background] runOpencode returned, output length: ${result?.output?.length || 0}, isStuck: ${result?.isStuck}`);
                let parsed = null;
                let output = result.output || '';

                // Try to extract JSON from output
                const tryParseJson = (text) => {
                    try {
                        const jsonMatch = text.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            return JSON.parse(jsonMatch[0]);
                        }
                    } catch (e) {
                        log(`[Background] JSON parse attempt failed: ${e.message}`);
                    }
                    return null;
                };

                parsed = tryParseJson(output);

                // ORCHESTRATOR PATTERN: If AI is stuck or no JSON found, send follow-up to resolve
                if (!parsed && (result.isStuck || output.length > 0)) {
                    log(`[Background] AI appears stuck or incomplete - using orchestrator to resolve`);
                    updateProcessingJob(jobId, {
                        current_step: 'orchestrating',
                        log: 'AI requested clarification - orchestrator resolving...'
                    });

                    // Create orchestrator prompt that answers any questions and re-requests JSON
                    const orchestratorPrompt = `The previous AI assistant started processing but may have asked questions or not completed the task.

PREVIOUS AI OUTPUT:
${output.substring(0, 3000)}${output.length > 3000 ? '...[truncated]' : ''}

YOUR TASK: Complete the extraction that was requested. Answer any questions the previous AI asked with reasonable defaults:
- If asked about format: Use the JSON format specified
- If asked about scope: Extract ALL comments from ALL reviewers
- If asked which approach: Choose the most comprehensive approach
- If asked about ambiguity: Make reasonable assumptions and proceed

NOW OUTPUT THE COMPLETE JSON with this exact structure:
{
  "paper": { "title": "...", "field": "..." },
  "reviewers": [
    {
      "id": "reviewer-1",
      "name": "Referee #1",
      "expertise": "...",
      "overall_sentiment": "critical|positive|mixed",
      "comments": [
        {
          "id": "R1.1",
          "type": "major|minor",
          "category": "...",
          "original_text": "exact quote",
          "summary": "brief summary",
          "priority": "high|medium|low",
          "tags": ["tag1", "tag2"]
        }
      ]
    }
  ]
}

OUTPUT ONLY THE JSON. No explanations, no questions.`;

                    const orchestratorResult = await runOpencode({
                        message: orchestratorPrompt,
                        files: budgetResult.files,
                        model: modelToUse,
                        agent: agentToUse,
                        variant: variantToUse,
                        timeout: 600000,
                        cwd: paperDir,
                        onProgress: streamProgress
                    });

                    log(`[Background] Orchestrator returned, output length: ${orchestratorResult?.output?.length || 0}`);

                    if (orchestratorResult.output) {
                        output = orchestratorResult.output;
                        parsed = tryParseJson(output);
                        if (parsed) {
                            log(`[Background] Orchestrator successfully extracted JSON with ${parsed.reviewers?.length || 0} reviewers`);
                        }
                    }
                }

                updateProcessingJob(jobId, {
                    current_step: 'parsing',
                    log: `Parsing response (${output.length} chars)...`
                });

                if (!parsed) {
                    log(`[Background] Final parse attempt on output`);
                    parsed = tryParseJson(output);
                }

                if (parsed) {
                    updateProcessingJob(jobId, {
                        current_step: 'saving',
                        log: 'Saving to database...'
                    });

                    // Save parsed data to file for reference
                    const parsedDataPath = path.join(paperDir, '_parsed_data.json');
                    fs.writeFileSync(parsedDataPath, JSON.stringify(parsed, null, 2));

                    // Update paper metadata in database
                    const paperMeta = parsed.paper || parsed.metadata || {};
                    if (paperMeta.title || paperMeta.authors || paperMeta.journal || paperMeta.field) {
                        updatePaperMetadata(paperId, paperMeta);
                    }

                    // Try to extract manuscript text from PDF with line numbers (more accurate)
                    // Falls back to markdown/docx if no PDF available
                    const pdfManuscriptText = extractManuscriptText(paperDir);
                    const finalManuscriptText = pdfManuscriptText || manuscriptPlainText;

                    // Use centralized storeParsedData function for reviewers/comments
                    // This ensures consistent ID normalization, priority inference, and line reference extraction
                    const stored = storeParsedData(paperId, parsed, finalManuscriptText);
                    if (!stored) {
                        log(`[Background] Warning: Failed to store parsed data for ${paperId}`, 'WARN');
                    }

                    const totalComments = (parsed.reviewers || []).reduce((sum, r) => sum + (r.comments?.length || 0), 0);

                    // Step 5: Generate expert SUGGESTIONS (not full analysis yet)
                    // The user will review/modify these before continuing
                    updateProcessingJob(jobId, {
                        current_step: 'suggesting_experts',
                        progress: 85,
                        log: 'Generating expert panel suggestions...'
                    });

                    try {
                        log(`[Background] Generating expert suggestions for paper ${paperId}...`);
                        log(`[Background] Using ${budgetResult.files.length} files (~${budgetResult.estimatedTokens} tokens)`);

                        // Generate dynamic experts using smart-selected files
                        const expertResult = await generateDynamicExperts(
                            paperDir, modelToUse, agentToUse, variantToUse, null, budgetResult.files
                        );

                        log(`[Background] Expert result: ${JSON.stringify(expertResult.experts?.length || 0)} experts generated`);

                        if (expertResult.experts && expertResult.experts.length > 0) {
                            // Save suggested experts to database
                            const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                            const expertDb = new Database(dbPath);

                            // Clear any previous suggestions for this paper
                            expertDb.prepare('DELETE FROM suggested_experts WHERE paper_id = ?').run(paperId);

                            // Insert new suggestions
                            const insertStmt = expertDb.prepare(`
                                INSERT INTO suggested_experts (paper_id, name, icon, color, expertise, comment_types, description, is_custom, is_confirmed)
                                VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
                            `);

                            for (const expert of expertResult.experts) {
                                insertStmt.run(
                                    paperId,
                                    expert.name,
                                    expert.icon || 'user',
                                    expert.color || 'blue',
                                    JSON.stringify(expert.expertise || []),
                                    JSON.stringify(expert.comment_types || []),
                                    expert.expertise?.join(', ') || ''
                                );
                            }

                            // Update paper status to awaiting_expert_review
                            expertDb.prepare(`
                                UPDATE papers SET status = 'awaiting_expert_review', updated_at = datetime('now')
                                WHERE id = ?
                            `).run(paperId);

                            expertDb.close();

                            log(`[Background] Generated ${expertResult.experts.length} expert suggestions for paper ${paperId}`);
                            updateProcessingJob(jobId, {
                                current_step: 'awaiting_expert_review',
                                progress: 90,
                                log: `${expertResult.experts.length} experts suggested. Awaiting user review...`
                            });

                            // Save model/settings for later use (no session ID needed)
                            const sessionFile = path.join(paperDir, '_opencode_session.json');
                            fs.writeFileSync(sessionFile, JSON.stringify({
                                // No sessionId - we use fresh contexts each time
                                model: modelToUse,
                                agent: agentToUse,
                                variant: variantToUse,
                                parsedData: parsed,
                                contextFiles: budgetResult.files,  // Smart-selected files for expert analysis
                                tokenBudget: TOKEN_BUDGET,
                                estimatedTokens: budgetResult.estimatedTokens
                            }, null, 2));

                            // Mark job as paused (awaiting expert review)
                            updateProcessingJob(jobId, {
                                status: 'awaiting_expert_review',
                                current_step: 'awaiting_expert_review',
                                progress: 90,
                                log: 'Paused: Waiting for user to review and confirm expert panel'
                            });

                            log(`[Background] Job ${jobId} paused: awaiting expert review`);
                        } else {
                            log(`[Background] Could not generate expert suggestions - continuing without experts`, 'WARN');
                            // Update paper status to parsed (skip expert review)
                            const dbPath2 = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                            const fallbackDb = new Database(dbPath2);
                            fallbackDb.prepare(`UPDATE papers SET status = 'parsed', updated_at = datetime('now') WHERE id = ?`).run(paperId);
                            fallbackDb.close();
                            completeProcessingJob(jobId, true);
                        }
                    } catch (expertErr) {
                        log(`[Background] Expert suggestion failed: ${expertErr.message}`, 'ERROR');
                        // Update paper status to parsed (skip expert review)
                        const dbPath3 = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                        const errorDb = new Database(dbPath3);
                        errorDb.prepare(`UPDATE papers SET status = 'parsed', updated_at = datetime('now') WHERE id = ?`).run(paperId);
                        errorDb.close();
                        completeProcessingJob(jobId, true);
                    }

                    log(`[Background] Job ${jobId} initial processing done: ${parsed.reviewers?.length || 0} reviewers, ${totalComments} comments`);
                } else {
                    completeProcessingJob(jobId, false, 'Could not parse documents - no valid JSON found');
                    log(`[Background] Job ${jobId} failed: Could not parse documents`, 'ERROR');
                }

            } catch (e) {
                log(`[Background] Error processing job ${jobId}: ${e.message}`, 'ERROR');
                completeProcessingJob(jobId, false, e.message);
            }
        }

        // =====================================================
        // EXPERT REVIEW WORKFLOW ENDPOINTS
        // =====================================================

        // GET /papers/:id/suggested-experts - Get AI-suggested experts for review
        const suggestedExpertsMatch = req.url.match(/^\/papers\/([^/]+)\/suggested-experts$/);
        if (req.method === 'GET' && suggestedExpertsMatch) {
            const paperId = suggestedExpertsMatch[1];
            try {
                const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                const expertDb = new Database(dbPath);

                const experts = expertDb.prepare(`
                    SELECT * FROM suggested_experts WHERE paper_id = ? ORDER BY id
                `).all(paperId);

                // Parse JSON fields
                const parsed = experts.map(e => ({
                    ...e,
                    expertise: JSON.parse(e.expertise || '[]'),
                    comment_types: JSON.parse(e.comment_types || '[]')
                }));

                expertDb.close();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ experts: parsed }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // POST /papers/:id/suggested-experts - Add a custom expert
        const addExpertMatch = req.url.match(/^\/papers\/([^/]+)\/suggested-experts$/);
        if (req.method === 'POST' && addExpertMatch) {
            const paperId = addExpertMatch[1];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const expert = JSON.parse(body);
                    const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                    const expertDb = new Database(dbPath);

                    const result = expertDb.prepare(`
                        INSERT INTO suggested_experts (paper_id, name, icon, color, expertise, comment_types, description, is_custom, is_confirmed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
                    `).run(
                        paperId,
                        expert.name,
                        expert.icon || 'user',
                        expert.color || 'blue',
                        JSON.stringify(expert.expertise || []),
                        JSON.stringify(expert.comment_types || []),
                        expert.description || ''
                    );

                    expertDb.close();
                    res.writeHead(201, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, id: result.lastInsertRowid }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // PUT /papers/:id/suggested-experts/:expertId - Update an expert
        const updateExpertMatch = req.url.match(/^\/papers\/([^/]+)\/suggested-experts\/(\d+)$/);
        if (req.method === 'PUT' && updateExpertMatch) {
            const paperId = updateExpertMatch[1];
            const expertId = updateExpertMatch[2];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const expert = JSON.parse(body);
                    const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                    const expertDb = new Database(dbPath);

                    expertDb.prepare(`
                        UPDATE suggested_experts SET
                            name = COALESCE(?, name),
                            icon = COALESCE(?, icon),
                            color = COALESCE(?, color),
                            expertise = COALESCE(?, expertise),
                            comment_types = COALESCE(?, comment_types),
                            description = COALESCE(?, description)
                        WHERE id = ? AND paper_id = ?
                    `).run(
                        expert.name,
                        expert.icon,
                        expert.color,
                        expert.expertise ? JSON.stringify(expert.expertise) : null,
                        expert.comment_types ? JSON.stringify(expert.comment_types) : null,
                        expert.description,
                        expertId,
                        paperId
                    );

                    expertDb.close();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // DELETE /papers/:id/suggested-experts/:expertId - Remove an expert
        const deleteExpertMatch = req.url.match(/^\/papers\/([^/]+)\/suggested-experts\/(\d+)$/);
        if (req.method === 'DELETE' && deleteExpertMatch) {
            const paperId = deleteExpertMatch[1];
            const expertId = deleteExpertMatch[2];
            try {
                const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                const expertDb = new Database(dbPath);

                expertDb.prepare(`
                    DELETE FROM suggested_experts WHERE id = ? AND paper_id = ?
                `).run(expertId, paperId);

                expertDb.close();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // POST /papers/:id/confirm-experts - Confirm expert panel and continue processing
        const confirmExpertsMatch = req.url.match(/^\/papers\/([^/]+)\/confirm-experts$/);
        if (req.method === 'POST' && confirmExpertsMatch) {
            const paperId = confirmExpertsMatch[1];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                    const expertDb = new Database(dbPath);
                    const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);

                    // Get confirmed experts from database
                    const experts = expertDb.prepare(`
                        SELECT * FROM suggested_experts WHERE paper_id = ? ORDER BY id
                    `).all(paperId);

                    if (!experts || experts.length === 0) {
                        expertDb.close();
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'No experts found to confirm' }));
                        return;
                    }

                    // Parse experts for processing
                    const parsedExperts = experts.map(e => ({
                        name: e.name,
                        icon: e.icon,
                        color: e.color,
                        expertise: JSON.parse(e.expertise || '[]'),
                        comment_types: JSON.parse(e.comment_types || '[]')
                    }));

                    // Update paper status to processing_experts
                    expertDb.prepare(`
                        UPDATE papers SET status = 'processing_experts', updated_at = datetime('now')
                        WHERE id = ?
                    `).run(paperId);

                    // Mark experts as confirmed
                    expertDb.prepare(`
                        UPDATE suggested_experts SET is_confirmed = 1 WHERE paper_id = ?
                    `).run(paperId);

                    expertDb.close();

                    // Create new processing job for expert analysis
                    const job = createProcessingJob(paperId);
                    updateProcessingJob(job.id, {
                        status: 'processing',
                        current_step: 'generating_expert_analysis',
                        progress: 0,
                        log: `Starting expert analysis with ${parsedExperts.length} confirmed experts`
                    });

                    // Return immediately
                    res.writeHead(202, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        job_id: job.id,
                        paper_id: paperId,
                        experts_count: parsedExperts.length,
                        message: 'Expert analysis started. Poll /papers/:id/status for updates.'
                    }));

                    // Run expert analysis in background
                    setImmediate(() => runExpertAnalysisBackground(job.id, paperId, paperDir, parsedExperts));

                } catch (e) {
                    log(`Error confirming experts: ${e.message}`, 'ERROR');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // POST /papers/:id/stop-processing - Stop an active processing job
        const stopProcessingMatch = req.url.match(/^\/papers\/([^/]+)\/stop-processing$/);
        if (req.method === 'POST' && stopProcessingMatch) {
            const paperId = stopProcessingMatch[1];
            log(`[stop-processing] Stopping processing for paper ${paperId}`);

            try {
                // Find active job for this paper
                const job = Array.from(activeJobs.values()).find(j => j.paper_id === paperId);

                if (job) {
                    // Mark job as stopped
                    updateProcessingJob(job.id, {
                        status: 'stopped',
                        current_step: 'stopped',
                        log: 'Processing stopped by user'
                    });

                    // Kill any running opencode processes for this paper
                    if (job.process_pid) {
                        try {
                            process.kill(job.process_pid, 'SIGTERM');
                            log(`[stop-processing] Killed main process ${job.process_pid}`);
                        } catch (e) {
                            // Process may have already exited
                        }
                    }

                    // Kill tracked worker PIDs
                    if (job.worker_pids && job.worker_pids.length > 0) {
                        for (const pid of job.worker_pids) {
                            try {
                                process.kill(pid, 'SIGTERM');
                                log(`[stop-processing] Killed worker PID ${pid}`);
                            } catch (e) {
                                // Process may have already exited
                            }
                        }
                    }

                    // Kill all OpenCode processes related to this paper (fallback)
                    // Validate paperId is a UUID to prevent command injection
                    const uuidRegex = /^[a-f0-9-]{8,36}$/i;
                    if (uuidRegex.test(paperId)) {
                        try {
                            const { execSync } = require('child_process');
                            // Use escaped paper ID in pkill pattern
                            const escapedPaperId = paperId.replace(/[^a-f0-9-]/gi, '');
                            const killCmd = `pkill -f "opencode.*${escapedPaperId}" 2>/dev/null || true`;
                            execSync(killCmd, { timeout: 5000 });
                            log(`[stop-processing] Killed remaining processes for paper ${paperId}`);
                        } catch (e) {
                            // pkill may fail if no processes found - that's OK
                        }
                    } else {
                        log(`[stop-processing] Invalid paperId format, skipping pkill: ${paperId}`, 'WARN');
                    }

                    // Clear worker sessions from database
                    clearWorkerSessions(paperId);
                    log(`[stop-processing] Cleared worker sessions for paper ${paperId}`);

                    // Update paper status in database
                    const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                    const db = new Database(dbPath);
                    db.prepare(`UPDATE papers SET status = 'stopped' WHERE id = ?`).run(paperId);
                    db.close();

                    log(`[stop-processing] Stopped job for paper ${paperId}`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Processing stopped' }));
            } catch (e) {
                log(`Error stopping processing: ${e.message}`, 'ERROR');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // Background function to run expert analysis after user confirms experts
        async function runExpertAnalysisBackground(jobId, paperId, paperDir, confirmedExperts) {
            try {
                log(`[Background] Starting expert analysis for paper ${paperId} with ${confirmedExperts.length} experts`);

                // Load saved session data
                const sessionFile = path.join(paperDir, '_opencode_session.json');
                let sessionData = {};
                if (fs.existsSync(sessionFile)) {
                    sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                }

                const modelToUse = sessionData.model || 'github-copilot/gpt-5.2';
                const agentToUse = sessionData.agent || 'general';
                const variantToUse = sessionData.variant || 'high';
                const contextFiles = sessionData.contextFiles || [];  // Files to attach for context
                const parsed = sessionData.parsedData || {};

                // Get worker sessions for this paper (large supplementary files)
                const workers = getWorkerSessions(paperId);
                const workerInventory = workers.length > 0 ? buildWorkerInventory(workers) : null;
                if (workers.length > 0) {
                    log(`[Background] Found ${workers.length} worker sessions for supplementary data access`);
                }

                // Callback for real-time AI reasoning updates - verbose output like webapp chat
                const streamProgress = (event) => {
                    if (event.message) {
                        // Add type prefix for better visual distinction in log
                        let prefix = '';
                        switch (event.type) {
                            case 'reasoning': prefix = '[Thinking]'; break;
                            case 'tool': prefix = '[Tool]'; break;
                            case 'tool_result': prefix = '[Result]'; break;
                            case 'text': prefix = '[Output]'; break;
                            case 'assistant': prefix = '[AI]'; break;
                            default: prefix = '[AI]';
                        }
                        updateProcessingJob(jobId, {
                            log: `${prefix} ${event.message}`
                        });
                    }
                    if (event.progress) {
                        updateProcessingJob(jobId, { progress: event.progress });
                    }
                };

                // Step 1: Create skill files for the confirmed experts
                updateProcessingJob(jobId, {
                    current_step: 'creating_skills',
                    progress: 5,
                    log: 'Creating skill files for experts...'
                });

                const skillsDir = path.join(paperDir, 'skills');
                fs.mkdirSync(skillsDir, { recursive: true });

                for (const expert of confirmedExperts) {
                    const skillDir = path.join(skillsDir, expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
                    fs.mkdirSync(skillDir, { recursive: true });

                    const paperMeta = parsed.paper || parsed.metadata || {};
                    const paperField = paperMeta.field || 'scientific research';

                    const skillContent = `---
name: ${expert.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
description: ${expert.name} - Expert for ${paperField}
---

# ${expert.name}

## Core Expertise
${expert.expertise.map(e => `- ${e}`).join('\n')}

## Comment Types
Best suited for: ${expert.comment_types?.join(', ') || 'general comments'}
`;
                    fs.writeFileSync(path.join(skillDir, 'skill.md'), skillContent);
                }
                log(`[Background] Created ${confirmedExperts.length} skill files`);

                // Step 2: Generate expert analysis for MAJOR comments only
                // Minor comments (typos, formatting) don't need expert analysis
                const allComments = [];
                let reviewerNum = 0;
                for (const reviewer of (parsed.reviewers || [])) {
                    reviewerNum++;
                    let commentNum = 0;
                    for (const comment of (reviewer.comments || [])) {
                        commentNum++;
                        const normalizedId = normalizeCommentId(comment.id, reviewerNum, commentNum);
                        const dbCommentId = `${paperId}_${normalizedId}`;
                        allComments.push({
                            ...comment,
                            id: normalizedId,  // Use normalized ID for display
                            db_id: dbCommentId,  // Full ID for database operations
                            reviewer_name: reviewer.name,
                            reviewer_id: reviewer.id
                        });
                    }
                }

                // Filter to major comments only for expert analysis
                const majorComments = allComments.filter(c => (c.type || '').toLowerCase() === 'major');
                const totalComments = majorComments.length;
                let processedComments = 0;
                const expertDiscussions = {};

                // Sequential processing - use session context for full paper knowledge
                log(`[Background] Processing ${totalComments} MAJOR comments (skipping ${allComments.length - totalComments} minor)`);

                updateProcessingJob(jobId, {
                    current_step: 'analyzing_comments',
                    progress: 10,
                    log: `Generating expert insights for ${totalComments} major comments (${allComments.length - totalComments} minor skipped)...`
                });

                // Process major comments sequentially - attach context files for each call
                const failedComments = [];
                for (const comment of majorComments) {
                    processedComments++;

                    updateProcessingJob(jobId, {
                        log: `[${processedComments}/${totalComments}] Analyzing ${comment.id}...`,
                        progress: 10 + Math.round((processedComments / totalComments) * 85)
                    });

                    try {
                        const analysis = await generateExpertAnalysisForComment(
                            comment, confirmedExperts,
                            paperDir, modelToUse, agentToUse, variantToUse,
                            null, // No session ID - fresh context each time
                            null, // No separate paper context string
                            contextFiles, // Attach all files for full context
                            workerInventory // Worker sessions for large supplementary data
                        );

                        if (analysis?.experts) {
                            expertDiscussions[comment.db_id || comment.id] = analysis;
                            const saved = saveExpertToDB(comment.db_id || comment.id, analysis);
                            log(`[Background] ${comment.id}: ${analysis.experts.length} experts, saved=${saved}`);
                        } else {
                            log(`[Background] No experts in response for ${comment.id}, will retry`, 'WARN');
                            failedComments.push(comment);
                        }
                    } catch (e) {
                        log(`[Background] Error analyzing ${comment.id}: ${e.message}`, 'WARN');
                        failedComments.push(comment);
                    }
                }

                // Retry failed comments once
                if (failedComments.length > 0) {
                    updateProcessingJob(jobId, {
                        log: `Retrying ${failedComments.length} failed comment(s)...`
                    });

                    for (const comment of failedComments) {
                        updateProcessingJob(jobId, {
                            log: `[Retry] Analyzing ${comment.id}...`
                        });

                        try {
                            const analysis = await generateExpertAnalysisForComment(
                                comment, confirmedExperts,
                                paperDir, modelToUse, agentToUse, variantToUse,
                                null, // No session ID - fresh context
                                null,
                                contextFiles, // Attach all files
                                workerInventory // Worker sessions for large supplementary data
                            );

                            if (analysis?.experts) {
                                expertDiscussions[comment.db_id || comment.id] = analysis;
                                saveExpertToDB(comment.db_id || comment.id, analysis);
                                log(`[Background] Retry succeeded for ${comment.id}`);
                            } else {
                                log(`[Background] Retry failed for ${comment.id} - no experts`, 'WARN');
                            }
                        } catch (e) {
                            log(`[Background] Retry error for ${comment.id}: ${e.message}`, 'WARN');
                        }
                    }
                }

                // Step 3: Save expert discussions to file
                const expertData = {
                    generated: new Date().toISOString(),
                    paper_id: paperId,
                    experts: confirmedExperts,
                    expert_discussions: expertDiscussions
                };

                fs.writeFileSync(
                    path.join(paperDir, 'expert_discussions.json'),
                    JSON.stringify(expertData, null, 2)
                );

                // Step 4: Update paper status to parsed (complete)
                const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                const paperDb = new Database(dbPath);
                paperDb.prepare(`
                    UPDATE papers SET status = 'parsed', updated_at = datetime('now')
                    WHERE id = ?
                `).run(paperId);
                paperDb.close();

                // Mark job complete
                completeProcessingJob(jobId, true);
                log(`[Background] Expert analysis complete: ${Object.keys(expertDiscussions).length} comments analyzed`);

            } catch (e) {
                log(`[Background] Error in expert analysis: ${e.message}`, 'ERROR');
                completeProcessingJob(jobId, false, e.message);
            }
        }

        // PUT /papers/:id - update paper metadata
        const paperUpdateMatch = req.url.match(/^\/papers\/([^/]+)$/);
        if (req.method === 'PUT' && paperUpdateMatch) {
            const paperId = paperUpdateMatch[1];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const dbPath = path.join(PROJECT_FOLDER || BASE_DIR, 'data', 'review_platform.db');
                    const paperDb = new Database(dbPath);

                    // Build update query dynamically based on provided fields
                    const updates = [];
                    const values = [];

                    if (data.title !== undefined) { updates.push('title = ?'); values.push(data.title); }
                    if (data.authors !== undefined) { updates.push('authors = ?'); values.push(data.authors); }
                    if (data.journal !== undefined) { updates.push('journal = ?'); values.push(data.journal); }
                    if (data.field !== undefined) { updates.push('field = ?'); values.push(data.field); }

                    if (updates.length > 0) {
                        updates.push('updated_at = datetime("now")');
                        values.push(paperId);

                        paperDb.prepare(`UPDATE papers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
                    }

                    paperDb.close();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // POST /extract-text - Extract text from uploaded file (base64)
        // Uses the same tools as OpenCode skills:
        // - docx: pandoc (like docx skill)
        // - xlsx: pandas via Python script (like xlsx skill)
        // - pdf: pdfplumber via Python script (like pdf skill)
        if (req.method === 'POST' && req.url === '/extract-text') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { filename, data } = JSON.parse(body);
                    const ext = path.extname(filename).toLowerCase();

                    // Decode base64 and save to temp file
                    const buffer = Buffer.from(data, 'base64');
                    const tempDir = path.join(os.tmpdir(), 'rebuttr-extract');
                    fs.mkdirSync(tempDir, { recursive: true });
                    const tempFile = path.join(tempDir, `${Date.now()}-${filename}`);
                    const outputFile = path.join(tempDir, `${Date.now()}-output.txt`);
                    fs.writeFileSync(tempFile, buffer);

                    let text = '';

                    try {
                        if (ext === '.txt' || ext === '.md') {
                            text = fs.readFileSync(tempFile, 'utf8');
                        } else if (ext === '.docx' || ext === '.doc') {
                            // Use pandoc (same as docx skill)
                            try {
                                execSync(`pandoc "${tempFile}" -t plain -o "${outputFile}"`, { timeout: 60000 });
                                text = fs.readFileSync(outputFile, 'utf8');
                            } catch (pandocErr) {
                                // Fallback to mammoth if pandoc fails
                                log(`Pandoc failed, falling back to mammoth: ${pandocErr.message}`, 'WARN');
                                const mammoth = require('mammoth');
                                const result = await mammoth.extractRawText({ path: tempFile });
                                text = result.value;
                            }
                        } else if (ext === '.xlsx' || ext === '.xls') {
                            // Use Python pandas (same as xlsx skill)
                            const pythonScript = `
import pandas as pd
import sys
try:
    xlsx = pd.read_excel("${tempFile}", sheet_name=None)
    output = []
    for sheet_name, df in xlsx.items():
        output.append(f"=== Sheet: {sheet_name} ===")
        output.append(df.to_csv(index=False))
    print("\\n\\n".join(output))
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;
                            try {
                                const result = execSync(`python3 -c '${pythonScript.replace(/'/g, "'\\''")}'`, {
                                    timeout: 60000,
                                    encoding: 'utf8',
                                    maxBuffer: 50 * 1024 * 1024
                                });
                                text = result;
                            } catch (pyErr) {
                                // Fallback to xlsx npm package
                                log(`Python pandas failed, falling back to xlsx npm: ${pyErr.message}`, 'WARN');
                                const XLSX = require('xlsx');
                                const workbook = XLSX.readFile(tempFile);
                                const sheets = [];
                                for (const sheetName of workbook.SheetNames) {
                                    const sheet = workbook.Sheets[sheetName];
                                    const csv = XLSX.utils.sheet_to_csv(sheet);
                                    sheets.push(`=== Sheet: ${sheetName} ===\n${csv}`);
                                }
                                text = sheets.join('\n\n');
                            }
                        } else if (ext === '.pdf') {
                            // Use Python pdfplumber (same as pdf skill)
                            const pythonScript = `
import pdfplumber
import sys
try:
    with pdfplumber.open("${tempFile}") as pdf:
        text = []
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text.append(page_text)
        print("\\n\\n".join(text))
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;
                            try {
                                const result = execSync(`python3 -c '${pythonScript.replace(/'/g, "'\\''")}'`, {
                                    timeout: 60000,
                                    encoding: 'utf8',
                                    maxBuffer: 50 * 1024 * 1024
                                });
                                text = result;
                            } catch (pyErr) {
                                // Fallback to pdf-parse npm package
                                log(`Python pdfplumber failed, falling back to pdf-parse: ${pyErr.message}`, 'WARN');
                                const pdfParse = require('pdf-parse');
                                const pdfBuffer = fs.readFileSync(tempFile);
                                const pdfData = await pdfParse(pdfBuffer);
                                text = pdfData.text;
                            }
                        } else {
                            // Try to read as text
                            text = fs.readFileSync(tempFile, 'utf8');
                        }
                        log(`Extracted ${text.length} chars from ${filename}`);
                    } catch (extractErr) {
                        log(`Extraction failed for ${filename}: ${extractErr.message}`, 'ERROR');
                        text = `[Extraction failed: ${filename}] - ${extractErr.message}`;
                    }

                    // Clean up temp files
                    try { fs.unlinkSync(tempFile); } catch (e) {}
                    try { fs.unlinkSync(outputFile); } catch (e) {}

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, text }));
                } catch (e) {
                    log(`Error extracting text: ${e.message}`, 'ERROR');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // GET /config - return current config
        if (req.method === 'GET' && req.url === '/config') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(loadConfig()));
            return;
        }

        // POST /config - update config
        if (req.method === 'POST' && req.url === '/config') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const newSettings = JSON.parse(body);
                    if (updateConfig(newSettings)) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, config: loadConfig() }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Failed to update config' }));
                    }
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // GET /session - return session info
        if (req.method === 'GET' && req.url === '/session') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(loadSession()));
            return;
        }

        // GET /session/:paperId - get session config for a specific paper
        const sessionMatch = req.url.match(/^\/session\/([^/]+)$/);
        if (req.method === 'GET' && sessionMatch) {
            const paperId = sessionMatch[1];
            const session = getPaperSession(paperId);
            if (session) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(session));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Session not found' }));
            }
            return;
        }

        // POST /session/reset - reset session
        if (req.method === 'POST' && req.url === '/session/reset') {
            resetSession();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        // GET /context-status - check if context is loaded in OpenCode session
        if (req.method === 'GET' && req.url === '/context-status') {
            try {
                const session = loadSession();
                const messages = session.messages || [];

                // Check if any context-loading messages exist
                let contextLoaded = false;
                let loadedAt = null;
                let loadedFiles = [];

                // Look for context loading in messages
                for (const msg of messages) {
                    if (msg.role === 'user' && msg.content) {
                        // Check for context loading patterns
                        if (msg.content.includes('Read and analyze') ||
                            msg.content.includes('manuscript') ||
                            msg.content.includes('reviewer comments') ||
                            msg.content.includes('damage data')) {
                            contextLoaded = true;
                            loadedAt = msg.timestamp || new Date().toISOString();

                            // Extract file names from the message
                            const fileMatches = msg.content.match(/(?:file|data|manuscript|comments?|reviews?)[\s:]+([^\n,]+)/gi);
                            if (fileMatches) {
                                loadedFiles = fileMatches.map(m => m.replace(/^[^:]+:\s*/, '').trim());
                            }
                        }
                    }
                }

                // Also check if there's session history at all - that indicates context
                if (messages.length > 0) {
                    contextLoaded = true;
                    if (!loadedAt) {
                        loadedAt = messages[0].timestamp || 'Previous session';
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    contextLoaded,
                    loadedAt,
                    loadedFiles,
                    messageCount: messages.length,
                    sessionId: session.opencode_session_id
                }));
            } catch (e) {
                log(`Error checking context status: ${e.message}`, 'ERROR');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    contextLoaded: false,
                    loadedAt: null,
                    loadedFiles: [],
                    messageCount: 0,
                    sessionId: null
                }));
            }
            return;
        }

        // GET /models - get available models from opencode
        if (req.method === 'GET' && req.url === '/models') {
            try {
                const output = execSync(`${OPENCODE_BIN} models`, { encoding: 'utf-8', timeout: 10000 });
                const models = parseModelsOutput(output);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, models }));
            } catch (e) {
                log(`Error getting models: ${e.message}`, 'ERROR');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // GET /context-files or /papers/:id/context-files - list available context files for a paper
        const contextFilesMatch = req.url.match(/^\/papers\/([^/]+)\/context-files$/) || (req.url === '/context-files' ? [null, null] : null);
        if (req.method === 'GET' && contextFilesMatch) {
            const paperId = contextFilesMatch[1];

            // Determine the base directory for this paper
            let paperDir;
            if (paperId) {
                paperDir = path.join(PROJECT_FOLDER || BASE_DIR, 'papers', paperId);
            } else {
                // Fallback to old behavior for backwards compatibility
                paperDir = path.join(BASE_DIR, '..');
            }

            const result = {
                manuscript: { available: false, files: [] },
                reviews: { available: false, files: [] },
                supplementary: { available: false, files: [] }
            };

            // Helper to add file to result
            const addFile = (fileType, filePath) => {
                if (!fs.existsSync(filePath)) return;
                if (!result[fileType]) result[fileType] = { available: false, files: [] };
                if (result[fileType].files.some(f => f.path === filePath)) return;

                const stats = fs.statSync(filePath);
                result[fileType].files.push({
                    name: path.basename(filePath),
                    path: filePath,
                    size: stats.size,
                    sizeHuman: formatBytes(stats.size)
                });
                result[fileType].available = true;
            };

            // Scan paper folder subfolders
            const categories = ['manuscript', 'reviews', 'supplementary'];
            for (const category of categories) {
                const categoryDir = path.join(paperDir, category);
                if (fs.existsSync(categoryDir)) {
                    try {
                        const files = fs.readdirSync(categoryDir);
                        for (const file of files) {
                            const filePath = path.join(categoryDir, file);
                            const stat = fs.statSync(filePath);
                            if (stat.isFile()) {
                                addFile(category, filePath);
                            }
                        }
                    } catch (e) {
                        console.error(`Error scanning ${category}:`, e.message);
                    }
                }
            }

            // Sort files by name within each category
            for (const fileType of Object.keys(result)) {
                result[fileType].files.sort((a, b) => a.name.localeCompare(b.name));
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, files: result, paperDir }));
            return;
        }

        // GET /webapp-schema - return webapp structure for OpenCode context
        if (req.method === 'GET' && req.url === '/webapp-schema') {
            // Load current review data to get live state
            const reviewDataPath = path.join(BASE_DIR, 'data', 'reviewer_comments.json');
            let reviewState = { total: 0, byStatus: {}, byReviewer: {}, byCategory: {} };

            try {
                if (fs.existsSync(reviewDataPath)) {
                    const data = JSON.parse(fs.readFileSync(reviewDataPath, 'utf8'));
                    const allComments = [];
                    (data.reviewers || []).forEach(r => {
                        (r.comments || []).forEach(c => {
                            allComments.push({ ...c, reviewer: r.name, reviewerId: r.id });
                        });
                    });

                    reviewState = {
                        manuscript: data.manuscript,
                        total: allComments.length,
                        byStatus: {
                            pending: allComments.filter(c => c.status === 'pending').length,
                            in_progress: allComments.filter(c => c.status === 'in_progress').length,
                            completed: allComments.filter(c => c.status === 'completed').length
                        },
                        byReviewer: {},
                        byCategory: {},
                        byType: {
                            major: allComments.filter(c => c.type === 'major').length,
                            minor: allComments.filter(c => c.type === 'minor').length
                        },
                        highPriority: allComments.filter(c => c.priority === 'high').length
                    };

                    // Count by reviewer
                    (data.reviewers || []).forEach(r => {
                        reviewState.byReviewer[r.name] = {
                            total: r.comments.length,
                            completed: r.comments.filter(c => c.status === 'completed').length,
                            expertise: r.expertise
                        };
                    });

                    // Count by category
                    allComments.forEach(c => {
                        if (!reviewState.byCategory[c.category]) {
                            reviewState.byCategory[c.category] = { total: 0, completed: 0 };
                        }
                        reviewState.byCategory[c.category].total++;
                        if (c.status === 'completed') reviewState.byCategory[c.category].completed++;
                    });
                }
            } catch (e) {
                log(`Error loading review data for schema: ${e.message}`, 'WARN');
            }

            // Load manuscript config if available
            let manuscriptConfig = {};
            try {
                const configPath = path.join(__dirname, 'paper-config.json');
                if (fs.existsSync(configPath)) {
                    manuscriptConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                }
            } catch (e) {
                console.log('No paper-config.json found, using defaults');
            }

            const schema = {
                name: "Manuscript Review Platform",
                purpose: manuscriptConfig.manuscript?.description || "Respond to reviewer comments for your manuscript submission",
                project_context: {
                    manuscript: manuscriptConfig.manuscript?.title || "Your Manuscript",
                    journal: manuscriptConfig.manuscript?.journal || "Unknown Journal",
                    field: manuscriptConfig.manuscript?.field || "Scientific Research",
                    key_topics: ["Methodology", "Statistics", "Writing", "Literature"],
                    key_stats: manuscriptConfig.key_statistics || {}
                },
                current_state: reviewState,
                thematic_groups: {
                    "methodology": ["Methods", "Analysis", "Validation", "procedure", "protocol"],
                    "statistics": ["Statistics", "significant", "p-value", "sample size", "confidence"],
                    "results_interpretation": ["Results", "Interpretation", "Discussion", "finding"],
                    "writing_clarity": ["Writing", "Clarity", "Terminology", "definition"],
                    "literature": ["Literature", "References", "citation", "published"],
                    "figures_tables": ["Figure", "Tables", "panel", "legend", "visualization"]
                },
                api_endpoints: {
                    "POST /ask": "Send prompt to OpenCode - use for generating responses",
                    "GET /webapp-state": "Get current state of all comments",
                    "POST /save-response": "Save a drafted response to a comment"
                },
                comment_structure: {
                    fields: ["id", "type", "category", "original_text", "draft_response", "status", "priority"],
                    statuses: ["pending", "in_progress", "completed"],
                    types: ["major", "minor"]
                },
                instructions: `When helping with this manuscript review:
1. Always consider related comments when drafting responses for consistency
2. Use damage data (30.31% vs 1.08%) to support authentication arguments
3. Distinguish between authentication (damage proves ancient) and dating (geology proves age)
4. Reference specific data points when possible
5. Match the reviewer's concern tone (agree when valid, educate when misconception)`
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, schema }));
            return;
        }

        // GET /webapp-state - return live state of all comments
        if (req.method === 'GET' && req.url === '/webapp-state') {
            const reviewDataPath = path.join(BASE_DIR, 'data', 'reviewer_comments.json');
            let state = { comments: [], summary: {} };

            try {
                if (fs.existsSync(reviewDataPath)) {
                    const data = JSON.parse(fs.readFileSync(reviewDataPath, 'utf8'));
                    const allComments = [];
                    (data.reviewers || []).forEach(r => {
                        (r.comments || []).forEach(c => {
                            allComments.push({
                                id: c.id,
                                reviewer: r.name,
                                reviewerId: r.id,
                                type: c.type,
                                category: c.category,
                                status: c.status,
                                priority: c.priority,
                                hasResponse: !!c.draft_response,
                                hasRecommendedResponse: !!c.recommended_response,
                                textPreview: c.original_text.substring(0, 150) + '...'
                            });
                        });
                    });
                    state.comments = allComments;
                    state.summary = {
                        total: allComments.length,
                        pending: allComments.filter(c => c.status === 'pending').length,
                        in_progress: allComments.filter(c => c.status === 'in_progress').length,
                        completed: allComments.filter(c => c.status === 'completed').length,
                        withResponses: allComments.filter(c => c.hasResponse).length
                    };
                }
            } catch (e) {
                log(`Error loading webapp state: ${e.message}`, 'WARN');
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, state }));
            return;
        }

        // =====================================================
        // DATABASE API ENDPOINTS
        // =====================================================

        // GET /db/status - check database status
        if (req.method === 'GET' && req.url === '/db/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                sqlite_available: !!db,
                db_file: DB_FILE,
                message: 'SQLite database active'
            }));
            return;
        }

        // POST /db/comments - save all comments to database (with optional paper_id)
        // Also supports /papers/:id/comments
        const saveCommentsMatch = req.url.match(/^\/papers\/([^/]+)\/comments$/) || (req.url === '/db/comments' ? [null, null] : null);
        if (req.method === 'POST' && saveCommentsMatch) {
            const paperId = saveCommentsMatch[1];
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const reviewData = JSON.parse(body);
                    const saved = saveCommentsToDB(reviewData, paperId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: saved, storage: 'sqlite', paper_id: paperId }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // GET /db/comments - load all comments from database (with optional paper_id)
        // Also supports /papers/:id/comments
        const loadCommentsMatch = req.url.match(/^\/papers\/([^/]+)\/comments$/) || (req.url === '/db/comments' ? [null, null] : null);
        if (req.method === 'GET' && loadCommentsMatch) {
            const paperId = loadCommentsMatch[1];
            try {
                const data = loadCommentsFromDB(paperId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, data, storage: 'sqlite', paper_id: paperId }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // POST /db/expert - save expert discussion for a comment
        if (req.method === 'POST' && req.url === '/db/expert') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const { comment_id, expert_data } = JSON.parse(body);

                    if (!comment_id || !expert_data) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'comment_id and expert_data required' }));
                        return;
                    }

                    const saved = saveExpertToDB(comment_id, expert_data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: saved, storage: 'sqlite' }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // GET /db/experts - load all expert discussions (with optional paper_id for paper-level experts)
        if (req.method === 'GET' && req.url.startsWith('/db/experts')) {
            try {
                const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
                const paperId = urlParams.get('paper_id');
                const data = loadExpertsFromDB(paperId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, data, storage: 'sqlite', paper_id: paperId }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // =====================================================
        // VERSION HISTORY ENDPOINTS
        // =====================================================

        // POST /db/version - save a version history entry
        if (req.method === 'POST' && req.url === '/db/version') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const { comment_id, paper_id, field_name, old_value, new_value, source } = JSON.parse(body);
                    if (!comment_id || !field_name) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'comment_id and field_name required' }));
                        return;
                    }
                    const saved = saveVersionHistory(comment_id, paper_id, field_name, old_value, new_value, source || 'user');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: saved }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // GET /db/version/:comment_id - get version history for a comment
        const versionMatch = req.url.match(/^\/db\/version\/([^/]+)$/);
        if (req.method === 'GET' && versionMatch) {
            try {
                const commentId = decodeURIComponent(versionMatch[1]);
                const history = getVersionHistory(commentId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, history }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // GET /papers/:id/history - get all version history for a paper
        const paperHistoryMatch = req.url.match(/^\/papers\/([^/]+)\/history$/);
        if (req.method === 'GET' && paperHistoryMatch) {
            try {
                const paperId = paperHistoryMatch[1];
                const history = getPaperVersionHistory(paperId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, history }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // POST /db/version/revert/:id - revert to a previous version
        const revertMatch = req.url.match(/^\/db\/version\/revert\/(\d+)$/);
        if (req.method === 'POST' && revertMatch) {
            try {
                const versionId = parseInt(revertMatch[1]);
                const result = revertToVersion(versionId);
                if (result) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, ...result }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Version not found' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // POST /db/chat - save a chat message
        if (req.method === 'POST' && req.url === '/db/chat') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const { paper_id, role, content, comment_id } = JSON.parse(body);

                    if (!paper_id || !role || !content) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'paper_id, role, and content required' }));
                        return;
                    }

                    const saved = saveChatMessageToDB(paper_id, role, content, comment_id);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: saved, storage: 'sqlite' }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // GET /db/chat/:paper_id - load chat history for a paper
        if (req.method === 'GET' && req.url.startsWith('/db/chat/')) {
            try {
                const paperId = req.url.replace('/db/chat/', '');
                const messages = loadChatHistoryFromDB(paperId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, messages, storage: 'sqlite' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // POST /db/state - save app state
        if (req.method === 'POST' && req.url === '/db/state') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const { paper_id, key, value } = JSON.parse(body);

                    if (!paper_id || !key) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'paper_id and key required' }));
                        return;
                    }

                    const saved = saveAppState(paper_id, key, value);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: saved, storage: 'sqlite' }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // GET /db/state/:paper_id/:key - load app state
        if (req.method === 'GET' && req.url.startsWith('/db/state/')) {
            try {
                const parts = req.url.replace('/db/state/', '').split('/');
                const paperId = parts[0];
                const key = parts[1];
                const value = loadAppState(paperId, key);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, value, storage: 'sqlite' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // =====================================================
        // WORKER SESSION ENDPOINTS
        // =====================================================

        // GET /db/workers/:paper_id - get all worker sessions for a paper
        if (req.method === 'GET' && req.url.match(/^\/db\/workers\/[^/]+$/)) {
            try {
                const paperId = req.url.replace('/db/workers/', '');
                const workers = getWorkerSessions(paperId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, workers }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // DELETE /db/workers/:paper_id - clear all worker sessions for a paper
        if (req.method === 'DELETE' && req.url.match(/^\/db\/workers\/[^/]+$/)) {
            try {
                const paperId = req.url.replace('/db/workers/', '');
                clearWorkerSessions(paperId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // POST /db/workers/query - query a worker session
        if (req.method === 'POST' && req.url === '/db/workers/query') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const { paperId, fileName, question, outputDir, model, agent, variant } = JSON.parse(body);

                    // Find the worker
                    const workers = getWorkerSessions(paperId);
                    const worker = workers.find(w => w.fileName === fileName);

                    if (!worker) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `Worker not found: ${fileName}` }));
                        return;
                    }

                    const config = loadConfig();
                    const result = await queryWorkerSession(
                        paperId, worker, question, outputDir,
                        model || config.model,
                        agent || config.agent || 'build',
                        variant || config.variant || 'medium'
                    );

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, result }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // =====================================================
        // PAPER MANAGEMENT ENDPOINTS
        // =====================================================

        // GET /api/papers - list all papers
        if (req.method === 'GET' && req.url === '/api/papers') {
            try {
                const papers = getPapers();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, papers }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // GET /api/papers/incomplete - list incomplete papers
        if (req.method === 'GET' && req.url === '/api/papers/incomplete') {
            try {
                const papers = getIncompletePapers();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, papers }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // GET /api/papers/trash - list trashed papers
        if (req.method === 'GET' && req.url === '/api/papers/trash') {
            try {
                const papers = getTrashPapers();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, papers }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // POST /api/papers/:id/restore - restore a paper from trash
        const apiRestoreMatch = req.url.match(/^\/api\/papers\/([^/]+)\/restore$/);
        if (req.method === 'POST' && apiRestoreMatch) {
            const paperId = apiRestoreMatch[1];
            const result = restorePaper(paperId);
            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // DELETE /api/papers/:id/permanent - permanently delete a paper
        const permDeleteMatch = req.url.match(/^\/api\/papers\/([^/]+)\/permanent$/);
        if (req.method === 'DELETE' && permDeleteMatch) {
            const paperId = permDeleteMatch[1];
            const result = permanentlyDeletePaper(paperId);
            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // DELETE /api/papers/:id - delete a paper (soft delete to trash)
        if (req.method === 'DELETE' && req.url.startsWith('/api/papers/')) {
            const paperId = req.url.replace('/api/papers/', '');
            if (!paperId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Paper ID required' }));
                return;
            }

            const result = deletePaper(paperId);
            res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
        }

        // =====================================================
        // END DATABASE API ENDPOINTS
        // =====================================================

        // POST /ask - send prompt to OpenCode and return response
        if (req.method === 'POST' && req.url === '/ask') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { prompt, comment_id, paper_id, model, agent, variant, load_files, file_paths } = JSON.parse(body);

                    if (!prompt) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Prompt required' }));
                        return;
                    }

                    // Create a temporary session with the specified settings
                    const session = loadSession();
                    if (model) session.model = model;
                    if (agent) session.agent = agent;
                    if (variant) session.variant = variant;

                    // Get files to attach
                    // file_paths: array of direct file paths (new way)
                    // load_files: array of types or true (legacy way)
                    let files = [];

                    if (Array.isArray(file_paths) && file_paths.length > 0) {
                        // Direct file paths - verify they exist
                        for (const fp of file_paths) {
                            if (fs.existsSync(fp)) {
                                files.push(fp);
                            } else {
                                log(`File not found: ${fp}`, 'WARN');
                            }
                        }
                        log(`Received ask request for comment: ${comment_id || 'unknown'} (${files.length} files: ${files.map(f => path.basename(f)).join(', ')})`);
                    } else if (Array.isArray(load_files) && load_files.length > 0) {
                        // Legacy: load by type
                        files = getContextFiles(load_files);
                        log(`Received ask request for comment: ${comment_id || 'unknown'} (loading types: ${load_files.join(', ')})`);
                    } else if (load_files === true) {
                        // Load all types
                        files = getContextFiles(['manuscript', 'reviews', 'damage_data', 'taxonomic_data', 'supplementary']);
                        log(`Received ask request for comment: ${comment_id || 'unknown'} (loading all types)`);
                    } else {
                        log(`Received ask request for comment: ${comment_id || 'unknown'} (no files)`);
                    }

                    // Check if there are worker sessions with supplementary data
                    // Add MCP tool context to prompt so AI knows about available tools
                    let enhancedPrompt = prompt;
                    if (paper_id) {
                        const workers = getWorkerSessions(paper_id);
                        if (workers.length > 0) {
                            const workerList = workers.map(w => `- ${w.fileName}: ${w.summary || 'supplementary data'}`).join('\n');
                            enhancedPrompt = `[IMPORTANT: You have MCP tools to access supplementary data. USE THEM when the user asks about data, tables, or specific information.]

Available data sources:
${workerList}

When the user asks about supplementary data, tables, figures, sources, or specific information from the paper:
- Use "search_all_data" tool to search across all sources
- Use "query_data" tool to query a specific file
- Use "list_data_sources" tool to see what's available

DO NOT just list the files - actually CALL the MCP tools to get the data.

---
USER REQUEST: ${prompt}`;
                            log(`Added MCP tool context (${workers.length} workers available)`);
                        }
                    }

                    // Call OpenCode
                    const result = await callOpencode(enhancedPrompt, session, files);

                    if (result.error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: result.error }));
                    } else {
                        // Update session with new ID
                        if (result.sessionId) {
                            session.opencode_session_id = result.sessionId;
                        }
                        session.messages.push({
                            role: 'user',
                            content: prompt,
                            timestamp: new Date().toISOString()
                        });
                        session.messages.push({
                            role: 'assistant',
                            content: result.text,
                            timestamp: new Date().toISOString()
                        });
                        saveSession(session);

                        // Save to chat history database if paper_id is provided
                        if (paper_id) {
                            saveChatMessageToDB(paper_id, 'user', prompt, comment_id || 'chat');
                            saveChatMessageToDB(paper_id, 'assistant', result.text, comment_id || 'chat');
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            response: result.text,
                            comment_id: comment_id,
                            session_id: result.sessionId
                        }));
                    }
                } catch (e) {
                    log(`Error in /ask: ${e.message}`, 'ERROR');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // POST /api/knowledge-query - Smart query that routes to worker sessions
        // This endpoint coordinates between the main context and worker sessions
        if (req.method === 'POST' && req.url === '/api/knowledge-query') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { paperId, question, model, agent, variant } = JSON.parse(body);

                    if (!paperId || !question) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'paperId and question required' }));
                        return;
                    }

                    // Get paper info and workers
                    const paper = db ? db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId) : null;
                    const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);

                    // Check if paper exists (either in DB or on disk)
                    if (!paper && !fs.existsSync(paperDir)) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Paper not found' }));
                        return;
                    }

                    const workers = getWorkerSessions(paperId);

                    log(`[Knowledge Query] Question: "${question.substring(0, 80)}..." (${workers.length} workers)`);

                    // Save user question to chat history
                    saveChatMessageToDB(paperId, 'user', question, 'knowledge');

                    // Helper to save response and send
                    const sendResponse = (responseText, source, extras = {}) => {
                        // Save assistant response to chat history
                        saveChatMessageToDB(paperId, 'assistant', responseText, 'knowledge');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, response: responseText, source, ...extras }));
                    };

                    // If no workers, just use the main session with attached files
                    if (workers.length === 0) {
                        const contextFiles = [];
                        const manuscriptPath = path.join(paperDir, 'manuscript.md');
                        if (fs.existsSync(manuscriptPath)) contextFiles.push(manuscriptPath);

                        const result = await runOpencode({
                            message: question,
                            files: contextFiles,
                            model: model || loadConfig().model,
                            agent: agent || loadConfig().agent,
                            variant: variant || 'medium',
                            timeout: 120000,
                            cwd: paperDir
                        });

                        sendResponse(result.output, 'main');
                        return;
                    }

                    // Build inventory summary
                    const inventory = buildWorkerInventory(workers);

                    // First, ask a coordinator to determine which worker(s) to query
                    const routingPrompt = `You are a data routing coordinator. Based on the user's question and the available data sources, determine which source(s) to query.

AVAILABLE DATA SOURCES:
${inventory}

USER QUESTION: "${question}"

Respond with ONLY a JSON object listing which file(s) to query and what specific question to ask each:
{
  "queries": [
    {"file": "filename.ext", "question": "specific question for this file"}
  ]
}

If the question can be answered from the inventory summaries alone, respond with:
{"answer": "your answer based on inventory", "queries": []}`;

                    const routingConfig = loadConfig();
                    const routingResult = await runOpencode({
                        message: routingPrompt,
                        files: [],
                        model: model || routingConfig.model,
                        agent: agent || routingConfig.agent || 'general',
                        variant: 'low',  // Keep low for routing decisions (fast)
                        timeout: 30000,
                        cwd: paperDir
                    });

                    // Parse routing decision
                    let routing;
                    try {
                        const jsonMatch = routingResult.output.match(/\{[\s\S]*\}/);
                        routing = jsonMatch ? JSON.parse(jsonMatch[0]) : { queries: [] };
                    } catch (e) {
                        log(`[Knowledge Query] Failed to parse routing: ${e.message}`, 'WARN');
                        routing = { queries: [] };
                    }

                    // If we got a direct answer from inventory
                    if (routing.answer && (!routing.queries || routing.queries.length === 0)) {
                        sendResponse(routing.answer, 'inventory');
                        return;
                    }

                    // Query the relevant workers
                    const workerResponses = [];
                    const modelToUse = model || loadConfig().model;
                    const agentToUse = agent || loadConfig().agent;
                    const variantToUse = variant || 'medium';

                    for (const query of (routing.queries || [])) {
                        const worker = workers.find(w =>
                            w.fileName.toLowerCase().includes(query.file.toLowerCase()) ||
                            query.file.toLowerCase().includes(w.fileName.toLowerCase())
                        );

                        if (worker) {
                            log(`[Knowledge Query] Querying worker ${worker.fileName}: ${query.question.substring(0, 50)}...`);
                            const workerResult = await queryWorkerSession(
                                paperId, worker, query.question, paperDir,
                                modelToUse, agentToUse, variantToUse
                            );
                            workerResponses.push({
                                file: worker.fileName,
                                question: query.question,
                                response: workerResult
                            });
                        }
                    }

                    // If we got worker responses, consolidate them
                    if (workerResponses.length > 0) {
                        const consolidationPrompt = `Based on the following data retrieved from supplementary files, answer the user's question.

USER QUESTION: "${question}"

DATA FROM FILES:
${workerResponses.map(r => `--- ${r.file} ---\n${r.response}`).join('\n\n')}

Provide a clear, consolidated answer:`;

                        const finalResult = await runOpencode({
                            message: consolidationPrompt,
                            files: [],
                            model: modelToUse,
                            agent: agentToUse,
                            variant: variantToUse,
                            timeout: 60000,
                            cwd: paperDir
                        });

                        sendResponse(finalResult.output, 'workers', {
                            workerQueries: workerResponses.map(r => ({ file: r.file, question: r.question }))
                        });
                    } else {
                        // No workers matched, query with main context
                        const contextFiles = [];
                        const manuscriptPath = path.join(paperDir, 'manuscript.md');
                        if (fs.existsSync(manuscriptPath)) contextFiles.push(manuscriptPath);

                        const result = await runOpencode({
                            message: question,
                            files: contextFiles,
                            model: modelToUse,
                            agent: agentToUse,
                            variant: variantToUse,
                            timeout: 120000,
                            cwd: paperDir
                        });

                        sendResponse(result.output, 'main');
                    }
                } catch (e) {
                    log(`[Knowledge Query] Error: ${e.message}`, 'ERROR');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        // =====================================================
        // SETUP API ENDPOINTS (file upload + AI parsing)
        // =====================================================

        // POST /api/setup/upload - Upload files for new paper
        if (req.method === 'POST' && req.url === '/api/setup/upload') {
            const contentType = req.headers['content-type'] || '';
            if (!contentType.includes('multipart/form-data')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
                return;
            }

            const boundary = contentType.split('boundary=')[1];
            if (!boundary) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No boundary in multipart' }));
                return;
            }

            let body = [];
            req.on('data', chunk => body.push(chunk));
            req.on('end', () => {
                try {
                    const buffer = Buffer.concat(body);

                    // Simple multipart parser - first pass to extract parts
                    const boundaryBuffer = Buffer.from('--' + boundary);
                    const parsedParts = [];
                    let start = buffer.indexOf(boundaryBuffer);

                    while (start !== -1) {
                        const nextBoundary = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length);
                        if (nextBoundary === -1) break;

                        const part = buffer.slice(start + boundaryBuffer.length, nextBoundary);
                        const headerEnd = part.indexOf('\r\n\r\n');
                        if (headerEnd !== -1) {
                            const headers = part.slice(0, headerEnd).toString();
                            const filenameMatch = headers.match(/filename="([^"]+)"/);
                            const fieldNameMatch = headers.match(/name="([^"]+)"/);

                            let content = part.slice(headerEnd + 4);
                            if (content[content.length - 2] === 13 && content[content.length - 1] === 10) {
                                content = content.slice(0, -2);
                            }

                            if (filenameMatch) {
                                // File field
                                parsedParts.push({
                                    filename: filenameMatch[1],
                                    fieldName: fieldNameMatch ? fieldNameMatch[1] : 'supplementary',
                                    content
                                });
                            } else if (fieldNameMatch) {
                                // Text field (like title)
                                parsedParts.push({
                                    fieldName: fieldNameMatch[1],
                                    textValue: content.toString().trim()
                                });
                            }
                        }
                        start = nextBoundary;
                    }

                    // Check for duplicate manuscript
                    const manuscriptPart = parsedParts.find(p => p.fieldName === 'manuscript');
                    let paperId, hash, isExisting = false;

                    if (manuscriptPart) {
                        const duplicateCheck = findExistingPaperByHash(manuscriptPart.content);
                        if (duplicateCheck.paperId) {
                            // Found existing paper - return its info
                            paperId = duplicateCheck.paperId;
                            hash = duplicateCheck.hash;
                            isExisting = true;
                            log(`[VERBOSE] Found existing paper with same manuscript: ${paperId}`);
                        } else {
                            // New paper
                            paperId = generatePaperId();
                            hash = duplicateCheck.hash;
                            log(`[VERBOSE] Generated new paper ID: ${paperId}`);
                        }
                    } else {
                        // No manuscript, generate new ID
                        paperId = generatePaperId();
                        hash = null;
                        log(`[VERBOSE] No manuscript found, generated paper ID: ${paperId}`);
                    }

                    // Create paper directory structure in PROJECT_FOLDER (if new)
                    const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);
                    const manuscriptDir = path.join(paperDir, 'manuscript');
                    const reviewsDir = path.join(paperDir, 'reviews');
                    const supplementaryDir = path.join(paperDir, 'supplementary');

                    // Extract title from form data
                    const titlePart = parsedParts.find(p => p.fieldName === 'title' && p.textValue);
                    const paperTitle = titlePart ? titlePart.textValue : '';

                    // Extract AI config from form data
                    const aiConfigPart = parsedParts.find(p => p.fieldName === 'ai_config' && p.textValue);
                    let aiConfig = { model: 'github-copilot/gpt-5.2', agent: 'general', variant: 'high' };
                    if (aiConfigPart) {
                        try {
                            aiConfig = JSON.parse(aiConfigPart.textValue);
                            log(`[VERBOSE] AI config: ${JSON.stringify(aiConfig)}`);
                        } catch (e) {
                            log(`[VERBOSE] Failed to parse AI config: ${e.message}`);
                        }
                    }

                    if (!isExisting) {
                        fs.mkdirSync(manuscriptDir, { recursive: true });
                        fs.mkdirSync(reviewsDir, { recursive: true });
                        fs.mkdirSync(supplementaryDir, { recursive: true });
                        log(`[VERBOSE] Created paper directories at: ${paperDir}`);

                        // Register in database with title
                        registerPaper(paperId, hash, { title: paperTitle });

                        // Create session for this paper with AI config
                        createPaperSession(paperId, aiConfig);
                    } else {
                        // Restore paper if it was soft-deleted
                        restorePaper(paperId);

                        // Ensure directories exist for existing paper
                        if (!fs.existsSync(manuscriptDir)) fs.mkdirSync(manuscriptDir, { recursive: true });
                        if (!fs.existsSync(reviewsDir)) fs.mkdirSync(reviewsDir, { recursive: true });
                        if (!fs.existsSync(supplementaryDir)) fs.mkdirSync(supplementaryDir, { recursive: true });
                    }

                    // Save files from parsed parts
                    const files = { manuscript: [], reviews: [], supplementary: [] };

                    for (const part of parsedParts) {
                        const { filename, fieldName, content } = part;

                        // Skip text fields (no filename)
                        if (!filename) continue;

                        // Determine target directory based on field name
                        let targetDir = supplementaryDir;
                        let fileType = 'supplementary';
                        if (fieldName === 'manuscript') {
                            targetDir = manuscriptDir;
                            fileType = 'manuscript';
                        } else if (fieldName === 'reviews') {
                            targetDir = reviewsDir;
                            fileType = 'reviews';
                        }

                        const filePath = path.join(targetDir, filename);
                        fs.writeFileSync(filePath, content);
                        files[fileType].push({ name: filename, path: filePath, size: content.length });

                        log(`[VERBOSE] Saved ${fileType}: ${filename} (${content.length} bytes)`);
                    }

                    const totalFiles = files.manuscript.length + files.reviews.length + files.supplementary.length;
                    log(`Setup upload: ${totalFiles} files to ${paperDir}`);
                    log(`  - Manuscript: ${files.manuscript.length} files`);
                    log(`  - Reviews: ${files.reviews.length} files`);
                    log(`  - Supplementary: ${files.supplementary.length} files`);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        paper_id: paperId,
                        paper_dir: paperDir,
                        is_existing: isExisting,
                        files
                    }));
                } catch (e) {
                    log(`Setup upload error: ${e.message}`, 'ERROR');
                    log(`[VERBOSE] Stack: ${e.stack}`);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // POST /api/setup/parse - Use OpenCode to parse uploaded documents
        if (req.method === 'POST' && req.url === '/api/setup/parse') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const requestData = JSON.parse(body);
                    const paper_id = requestData.paper_id;
                    const paperDir = path.join(PROJECT_FOLDER, 'papers', paper_id);

                    // Load model/agent/variant from: request > paper session > config file > defaults
                    const paperSession = getPaperSession(paper_id);
                    const globalConfig = loadConfig();
                    const model = requestData.model || paperSession?.model || globalConfig.model || 'github-copilot/gpt-5-mini';
                    const agent = requestData.agent || paperSession?.agent || globalConfig.agent || 'general';
                    const variant = requestData.variant || paperSession?.variant || globalConfig.variant || 'high';

                    // Check if parsing is already in progress for this paper
                    const existingLock = parsingLocks.get(paper_id);
                    if (existingLock) {
                        const elapsed = Date.now() - existingLock.timestamp;
                        // If less than 10 minutes, reject duplicate request
                        if (elapsed < 600000) {
                            log(`[VERBOSE] Parsing already in progress for ${paper_id} (started ${Math.round(elapsed/1000)}s ago)`);
                            res.writeHead(409, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                error: 'Parsing already in progress',
                                message: `Parsing started ${Math.round(elapsed/1000)} seconds ago. Please wait for it to complete.`
                            }));
                            return;
                        }
                        // Stale lock, remove it
                        parsingLocks.delete(paper_id);
                    }

                    // Set the lock
                    parsingLocks.set(paper_id, { timestamp: Date.now() });

                    // Create processing job for log tracking
                    const job = createProcessingJob(paper_id);
                    const jobId = job.id;

                    log(`[VERBOSE] Parsing paper: ${paper_id} (job: ${jobId})`);
                    log(`[VERBOSE] Using AI settings: model=${model || 'default'}, agent=${agent || 'default'}, variant=${variant || 'default'}`);
                    log(`[VERBOSE] Paper dir: ${paperDir}`);

                    if (!fs.existsSync(paperDir)) {
                        log(`[VERBOSE] Paper directory not found: ${paperDir}`, 'ERROR');
                        updatePaperStatus(paper_id, 'error', 'Paper directory not found');
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Paper not found' }));
                        return;
                    }

                    // Update status to parsing
                    updatePaperStatus(paper_id, 'parsing');

                    // Collect files from all subdirectories
                    const manuscriptDir = path.join(paperDir, 'manuscript');
                    const reviewsDir = path.join(paperDir, 'reviews');
                    const supplementaryDir = path.join(paperDir, 'supplementary');

                    const collectFiles = (dir) => {
                        if (!fs.existsSync(dir)) return [];
                        return fs.readdirSync(dir)
                            .filter(f => !f.startsWith('.') && !f.startsWith('_'))
                            .map(f => path.join(dir, f));
                    };

                    const manuscriptFiles = collectFiles(manuscriptDir);
                    const reviewFiles = collectFiles(reviewsDir);
                    const supplementaryFiles = collectFiles(supplementaryDir);

                    log(`[VERBOSE] Found files: ${manuscriptFiles.length} manuscript, ${reviewFiles.length} reviews, ${supplementaryFiles.length} supplementary`);

                    if (reviewFiles.length === 0) {
                        log('No review files found to parse', 'ERROR');
                        updatePaperStatus(paper_id, 'error', 'No review files found');
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'No review files found in reviews folder' }));
                        return;
                    }

                    // Use original files - let OpenCode use its docx/xlsx skills
                    // Filter to supported file types
                    const supportedExts = ['.docx', '.xlsx', '.txt', '.md', '.pdf'];
                    const filterSupported = (files) => files.filter(f => {
                        const ext = path.extname(f).toLowerCase();
                        return supportedExts.includes(ext);
                    });

                    const manuscriptFilesToUse = filterSupported(manuscriptFiles);
                    const reviewFilesToUse = filterSupported(reviewFiles);
                    const supplementaryFilesToUse = filterSupported(supplementaryFiles);

                    log(`Files to process: ${manuscriptFilesToUse.length} manuscript, ${reviewFilesToUse.length} reviews, ${supplementaryFilesToUse.length} supplementary`);

                    if (reviewFilesToUse.length === 0) {
                        log('No supported review files found', 'ERROR');
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'No supported review files found (.docx, .txt, .md, .pdf)' }));
                        return;
                    }

                    // Set files on job for status display
                    updateProcessingJob(jobId, {
                        files: {
                            manuscript: manuscriptFilesToUse.map(f => ({ path: f, name: path.basename(f) })),
                            reviews: reviewFilesToUse.map(f => ({ path: f, name: path.basename(f) })),
                            supplementary: supplementaryFilesToUse.map(f => ({ path: f, name: path.basename(f) }))
                        }
                    });

                    // SEQUENTIAL PARSING: Process files one at a time
                    // Start with a FRESH session (no inherited context from other papers)
                    // But MAINTAIN the session throughout this paper's processing for context continuity
                    // Pass original files and let OpenCode use its docx/xlsx skills

                    // Aggregated results
                    let paperMetadata = { title: '', journal: '', field: '', authors: '' };
                    const allReviewers = [];
                    const allCategories = new Set();
                    const allThematicGroups = {};

                    // Helper to extract JSON from response
                    const extractJSON = (text) => {
                        const jsonMatch = text.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                return JSON.parse(jsonMatch[0]);
                            } catch (e) {
                                log(`JSON parse error: ${e.message}`, 'WARN');
                            }
                        }
                        return null;
                    };

                    // Create session for this paper - starts fresh (no inherited session ID)
                    // We'll capture the session ID from the first call and reuse it for context continuity
                    let paperSessionObj = {
                        model: model,
                        agent: agent,
                        variant: variant,
                        paper_id: paper_id,
                        opencode_session_id: null  // Fresh start - no context from other papers
                    };

                    // Real-time progress callback for streaming OpenCode output
                    const streamProgress = (event) => {
                        if (event.message) {
                            updateProcessingJob(jobId, {
                                log: `[AI] ${event.message}`
                            });
                        }
                    };

                    // Variable to store manuscript plain text for line reference context
                    let manuscriptPlainText = null;

                    // === STEP 1: Load manuscript to extract metadata ===
                    if (manuscriptFilesToUse.length > 0) {
                        updatePaperStatus(paper_id, 'extracting');
                        log('STEP 1: Loading manuscript for metadata...');
                        updateProcessingJob(jobId, {
                            status: 'processing',
                            current_step: 'manuscript',
                            log: 'Loading manuscript for metadata extraction...'
                        });

                        const manuscriptFile = manuscriptFilesToUse[0];
                        const manuscriptExt = path.extname(manuscriptFile).toLowerCase();
                        log(`  Using file: ${path.basename(manuscriptFile)} (${manuscriptExt})`);

                        const manuscriptPrompt = `You are analyzing an academic manuscript for a peer review response platform.

CRITICAL: Output JSON IMMEDIATELY. Do NOT ask questions, request clarification, enter planning mode, or describe what you'll do. Just extract and output.

${manuscriptExt === '.docx' ? 'Use the docx skill to read the attached DOCX file with pandoc.' : ''}
${manuscriptExt === '.xlsx' ? 'Use the xlsx skill to read the attached Excel file.' : ''}

TASK: Read the attached manuscript and extract metadata.

Extract:
1. Paper title
2. Journal name (if mentioned)
3. Research field/discipline
4. Author names (if available)
5. Key topics and methods discussed

OUTPUT FORMAT - Return ONLY valid JSON (no markdown, no explanation):
{
  "paper": {
    "title": "the paper title",
    "journal": "journal name or empty string",
    "field": "research field",
    "authors": "author names or empty string"
  },
  "key_topics": ["topic1", "topic2"],
  "methods": ["method1", "method2"],
  "context_summary": "Brief 2-3 sentence summary"
}`;

                        // Call OpenCode with the original file - let it use skills
                        const manuscriptResult = await callOpencode(manuscriptPrompt, paperSessionObj, [manuscriptFile], paperDir, streamProgress);

                        if (manuscriptResult.error) {
                            log(`Manuscript parse warning: ${manuscriptResult.error}`, 'WARN');
                        } else {
                            const manuscriptData = extractJSON(manuscriptResult.text || '');
                            if (manuscriptData?.paper) {
                                paperMetadata = { ...paperMetadata, ...manuscriptData.paper };
                                log(`Extracted paper metadata: "${paperMetadata.title}"`);
                                updateProcessingJob(jobId, {
                                    log: `Extracted metadata: "${paperMetadata.title}"`
                                });
                            }
                            // Capture session ID for context continuity in subsequent calls
                            if (manuscriptResult.sessionId) {
                                paperSessionObj.opencode_session_id = manuscriptResult.sessionId;
                                log(`Session established: ${manuscriptResult.sessionId}`);
                            }
                        }

                        // Convert manuscript to plain text for line reference context
                        try {
                            if (manuscriptExt === '.docx') {
                                // Use pandoc to convert docx to plain text
                                const { execSync } = require('child_process');
                                manuscriptPlainText = execSync(`pandoc -t plain "${manuscriptFile}"`, {
                                    encoding: 'utf-8',
                                    maxBuffer: 50 * 1024 * 1024
                                });
                                log(`Converted manuscript to text: ${manuscriptPlainText.split('\\n').length} lines`);
                            } else if (['.md', '.txt', '.text'].includes(manuscriptExt)) {
                                // Read plain text directly
                                manuscriptPlainText = fs.readFileSync(manuscriptFile, 'utf-8');
                                log(`Read manuscript text: ${manuscriptPlainText.split('\\n').length} lines`);
                            }
                        } catch (convErr) {
                            log(`Could not convert manuscript to text: ${convErr.message}`, 'WARN');
                        }
                    }

                    // === STEP 2: Note supplementary files ===
                    log(`STEP 2: ${supplementaryFilesToUse.length} supplementary file(s) available for reference`);

                    // === STEP 3: Process each review file ===
                    updatePaperStatus(paper_id, 'extracting');
                    log(`STEP 3: Processing ${reviewFilesToUse.length} review file(s)...`);
                    updateProcessingJob(jobId, {
                        current_step: 'reviews',
                        total_steps: reviewFilesToUse.length,
                        log: `Starting extraction of ${reviewFilesToUse.length} review file(s)`
                    });

                    for (let i = 0; i < reviewFilesToUse.length; i++) {
                        const reviewFile = reviewFilesToUse[i];
                        const fileName = path.basename(reviewFile);
                        const reviewExt = path.extname(reviewFile).toLowerCase();
                        log(`Processing review file ${i + 1}/${reviewFilesToUse.length}: ${fileName}`);
                        updateProcessingJob(jobId, {
                            current_file: fileName,
                            progress: Math.round(((i + 1) / reviewFilesToUse.length) * 80) + 10,
                            log: `[${i + 1}/${reviewFilesToUse.length}] Reading: ${fileName}`
                        });

                        const reviewPrompt = `You are parsing reviewer comments from an academic peer review document.

CRITICAL: Output JSON IMMEDIATELY. Do NOT ask questions, request clarification, enter planning mode, or describe what you'll do. Just extract and output.

${reviewExt === '.docx' ? 'Use the docx skill to read the attached DOCX file with pandoc.' : ''}
${paperMetadata.title ? `Context: This review is for the paper "${paperMetadata.title}"` : ''}

TASK: Read the attached review document and extract ALL reviewer comments.

For each reviewer found, extract:
1. Reviewer identifier (e.g., "Reviewer 1", "Reviewer 2", "Referee #1", or their actual name)
2. Their overall sentiment (positive/neutral/critical)
3. Their inferred expertise area

For each comment, ALL of these fields are REQUIRED (do NOT omit any):
1. "id": Use format R{reviewer#}.{comment#} (e.g., "R1.1", "R1.2")
2. "type": Either "major" or "minor"
   - major = substantive concerns about methodology, validity, interpretation, missing analyses
   - minor = line edits, typos, citation fixes, clarification requests, formatting
3. "category": E.g., "Methodology", "Statistical Analysis", "Data Presentation", "Writing Clarity", "Authentication", "Validation"
4. "original_text": The exact verbatim text of the comment
5. "summary": Brief 1-sentence summary
6. "priority": *** REQUIRED - YOU MUST INCLUDE THIS FIELD FOR EVERY COMMENT ***
   Assign exactly one of: "high", "medium", or "low"
   - "high" = requests new analyses, questions core validity, fundamental flaws, rejection risk
   - "medium" = requests clarification, additional data, moderate revisions
   - "low" = typos, formatting, citations, cosmetic changes
   Rule of thumb: major+fundamental→high, major+clarification→medium, minor→low
7. "tags": Array of relevant keywords

COMMENT ID FORMAT - STRICTLY follow this pattern:
- Use format "R{reviewer_number}.{comment_number}" e.g., "R1.1", "R1.2", "R2.1", "R3.1"
- Do NOT prefix with type (wrong: "major-R1.1", correct: "R1.1")
- Number comments sequentially per reviewer starting at 1

OUTPUT FORMAT - Return ONLY valid JSON (no markdown, no explanation):
{
  "reviewers": [
    {
      "id": "reviewer-1",
      "name": "Reviewer 1",
      "expertise": "inferred expertise",
      "overall_sentiment": "positive/neutral/critical",
      "comments": [
        {
          "id": "R1.1",
          "type": "major",
          "category": "Methodology",
          "original_text": "The validation approach is insufficient...",
          "summary": "Requests additional validation analysis",
          "priority": "high",
          "tags": ["validation", "methodology"],
          "requires_revision": true
        },
        {
          "id": "R1.2",
          "type": "major",
          "category": "Data Presentation",
          "original_text": "Figure 3 would benefit from...",
          "summary": "Suggests improvements to figure",
          "priority": "medium",
          "tags": ["figures"],
          "requires_revision": true
        },
        {
          "id": "R1.3",
          "type": "minor",
          "category": "Writing Clarity",
          "original_text": "Line 45: typo in 'recieved'",
          "summary": "Typo correction",
          "priority": "low",
          "tags": ["typo"],
          "requires_revision": true
        }
      ]
    }
  ],
  "categories_found": ["Methodology", "Data Presentation", "Writing Clarity"],
  "thematic_groups": {
    "group_name": {
      "description": "what this group covers",
      "keywords": ["keywords"]
    }
  }
}`;

                        // Call OpenCode with original file - use same session for context
                        const reviewResult = await callOpencode(reviewPrompt, paperSessionObj, [reviewFile], paperDir, streamProgress);

                        if (reviewResult.error) {
                            log(`Review file ${fileName} parse error: ${reviewResult.error}`, 'WARN');
                            continue;
                        }

                        // Capture session ID if not already set
                        if (reviewResult.sessionId && !paperSessionObj.opencode_session_id) {
                            paperSessionObj.opencode_session_id = reviewResult.sessionId;
                            log(`Session established: ${reviewResult.sessionId}`);
                        }

                        const reviewData = extractJSON(reviewResult.text || '');
                        if (reviewData) {
                            // Merge reviewers
                            if (reviewData.reviewers) {
                                for (const reviewer of reviewData.reviewers) {
                                    // Adjust IDs to avoid conflicts
                                    const existingCount = allReviewers.length;
                                    const adjustedReviewer = {
                                        ...reviewer,
                                        id: `reviewer-${existingCount + 1}`,
                                        source_file: fileName,
                                        comments: (reviewer.comments || []).map((c, idx) => ({
                                            ...c,
                                            id: `R${existingCount + 1}.${idx + 1}`
                                        }))
                                    };
                                    allReviewers.push(adjustedReviewer);
                                }
                            }

                            // Collect categories
                            if (reviewData.categories_found) {
                                reviewData.categories_found.forEach(c => allCategories.add(c));
                            }

                            // Merge thematic groups
                            if (reviewData.thematic_groups) {
                                Object.assign(allThematicGroups, reviewData.thematic_groups);
                            }

                            const numComments = reviewData.reviewers?.reduce((sum, r) => sum + (r.comments?.length || 0), 0) || 0;
                            log(`  -> Found ${reviewData.reviewers?.length || 0} reviewer(s) with ${numComments} comments`);
                            updateProcessingJob(jobId, {
                                log: `Extracted ${reviewData.reviewers?.length || 0} reviewer(s), ${numComments} comments from ${fileName}`
                            });
                        }
                    }

                    // === STEP 4: Classify and organize ===
                    updatePaperStatus(paper_id, 'classifying');
                    log('STEP 4: Organizing and classifying comments...');
                    updateProcessingJob(jobId, {
                        current_step: 'classifying',
                        progress: 90,
                        log: 'Organizing and classifying all extracted comments...'
                    });

                    // Build final parsed data structure
                    const parsedData = {
                        paper: paperMetadata,
                        categories: Array.from(allCategories),
                        thematic_groups: allThematicGroups,
                        reviewers: allReviewers,
                        parse_info: {
                            manuscript_files: manuscriptFilesToUse.length,
                            review_files: reviewFilesToUse.length,
                            supplementary_files: supplementaryFilesToUse.length,
                            total_reviewers: allReviewers.length,
                            total_comments: allReviewers.reduce((sum, r) => sum + (r.comments?.length || 0), 0),
                            parsed_at: new Date().toISOString()
                        }
                    };

                    // If we have reviewers, ask AI to create thematic groupings
                    if (allReviewers.length > 0 && parsedData.parse_info.total_comments > 3) {
                        log('Creating thematic groupings across all comments...');

                        // Build a summary of comments for the grouping prompt
                        const commentSummaries = allReviewers.flatMap(r =>
                            (r.comments || []).map(c => ({
                                id: c.id,
                                reviewer: r.name,
                                category: c.category,
                                summary: c.summary || c.original_text?.substring(0, 100)
                            }))
                        );

                        const groupPrompt = `Organize these ${parsedData.parse_info.total_comments} reviewer comments into thematic groups.

CRITICAL: Output JSON IMMEDIATELY. Do NOT ask questions, request clarification, or enter planning mode.

=== COMMENTS ===
${JSON.stringify(commentSummaries, null, 2)}
=== END COMMENTS ===

Create thematic groups (clusters of related comments) and list final categories.

Return ONLY valid JSON (no other text):
{
  "thematic_groups": {
    "group_name": {
      "description": "what this covers",
      "keywords": ["keywords"],
      "comment_ids": ["R1.1", "R2.3"]
    }
  },
  "final_categories": ["category1", "category2"]
}`;

                        const groupResult = await callOpencode(groupPrompt, paperSessionObj, [], paperDir, streamProgress);
                        if (!groupResult.error) {
                            const groupData = extractJSON(groupResult.text || '');
                            if (groupData) {
                                if (groupData.thematic_groups) {
                                    parsedData.thematic_groups = groupData.thematic_groups;
                                }
                                if (groupData.final_categories) {
                                    parsedData.categories = groupData.final_categories;
                                }
                            }
                        }
                    }

                    // Handle case with no reviewers found
                    if (allReviewers.length === 0) {
                        log('No reviewers extracted, creating placeholder', 'WARN');
                        parsedData.reviewers = [{
                            id: 'reviewer-1',
                            name: 'Reviewer 1',
                            expertise: '',
                            comments: [{
                                id: 'R1.1',
                                type: 'major',
                                category: 'General',
                                original_text: 'Review comments could not be automatically extracted. Use AI chat to help parse the documents.',
                                priority: 'high',
                                tags: ['setup']
                            }]
                        }];
                        parsedData.categories = ['General'];
                        parsedData.parse_note = 'Auto-parsing incomplete. Use AI chat to help extract comments.';
                    }

                    // Save parsed data to paper directory
                    fs.writeFileSync(
                        path.join(paperDir, '_parsed_data.json'),
                        JSON.stringify(parsedData, null, 2)
                    );

                    fs.writeFileSync(path.join(paperDir, '_status.json'), JSON.stringify({
                        status: 'parsed',
                        paper_id: paper_id,
                        files: {
                            manuscript: manuscriptFiles.map(f => path.basename(f)),
                            reviews: reviewFiles.map(f => path.basename(f)),
                            supplementary: supplementaryFiles.map(f => path.basename(f))
                        },
                        reviewers_found: parsedData.reviewers?.length || 0,
                        comments_found: parsedData.parse_info?.total_comments || 0,
                        categories: parsedData.categories || [],
                        timestamp: new Date().toISOString()
                    }));

                    log(`Parse complete: ${parsedData.reviewers?.length || 0} reviewers, ${parsedData.parse_info?.total_comments || 0} comments, ${parsedData.categories?.length || 0} categories`);

                    // Try to extract manuscript text from PDF with line numbers (more accurate)
                    // paperDir already declared above
                    const pdfManuscriptText = extractManuscriptText(paperDir);
                    const finalManuscriptText = pdfManuscriptText || manuscriptPlainText;

                    // Store parsed data in database (with manuscript text for line reference context)
                    storeParsedData(paper_id, parsedData, finalManuscriptText);

                    // Update paper metadata in database
                    if (parsedData.paper) {
                        updatePaperMetadata(paper_id, parsedData.paper);
                    }

                    // Update final status
                    updatePaperStatus(paper_id, 'parsed');

                    // Complete the job
                    completeProcessingJob(jobId, true);
                    updateProcessingJob(jobId, {
                        log: `Parsing complete! Found ${parsedData.reviewers?.length || 0} reviewers with ${parsedData.parse_info?.total_comments || 0} comments`
                    });

                    // Release lock
                    parsingLocks.delete(paper_id);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        paper_id: paper_id,
                        files_processed: {
                            manuscript: manuscriptFilesToUse.length,
                            reviews: reviewFilesToUse.length,
                            supplementary: supplementaryFilesToUse.length
                        },
                        reviewers_found: parsedData.reviewers?.length || 0,
                        comments_found: parsedData.parse_info?.total_comments || 0,
                        categories: parsedData.categories || []
                    }));
                } catch (e) {
                    log(`Setup parse error: ${e.message}`, 'ERROR');
                    // Try to update paper status if we have paper_id
                    try {
                        const { paper_id } = JSON.parse(body);
                        if (paper_id) updatePaperStatus(paper_id, 'error', e.message);
                    } catch (parseErr) { /* ignore */ }
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // POST /api/setup/create - Create paper from parsed data
        if (req.method === 'POST' && req.url === '/api/setup/create') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { paper_id } = JSON.parse(body);
                    const paperDir = path.join(PROJECT_FOLDER, 'papers', paper_id);

                    log(`[VERBOSE] Creating paper in database: ${paper_id}`);

                    if (!fs.existsSync(paperDir)) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Paper directory not found' }));
                        return;
                    }

                    // Read parsed data from OpenCode
                    const parsedDataPath = path.join(paperDir, '_parsed_data.json');
                    let parsedData = null;
                    if (fs.existsSync(parsedDataPath)) {
                        try {
                            parsedData = JSON.parse(fs.readFileSync(parsedDataPath, 'utf8'));
                            log(`Loaded parsed data: ${parsedData.reviewers?.length || 0} reviewers`);
                        } catch (e) {
                            log(`Error reading parsed data: ${e.message}`, 'WARN');
                        }
                    }

                    // Count files in each subdirectory
                    const countFiles = (dir) => {
                        if (!fs.existsSync(dir)) return 0;
                        return fs.readdirSync(dir).filter(f => !f.startsWith('.') && !f.startsWith('_')).length;
                    };
                    const fileCount = countFiles(path.join(paperDir, 'manuscript')) +
                                     countFiles(path.join(paperDir, 'reviews')) +
                                     countFiles(path.join(paperDir, 'supplementary'));

                    // Use existing paper_id from upload
                    const paperId = paper_id;

                    // Get paper metadata from parsed data or use defaults
                    const paperMeta = parsedData?.paper || {};
                    const title = paperMeta.title || 'Imported Paper';
                    const authors = paperMeta.authors || '';
                    const journal = paperMeta.journal || '';
                    const field = paperMeta.field || '';

                    // Get categories and thematic groups from parsed data
                    const categories = parsedData?.categories || [];
                    const thematicGroups = parsedData?.thematic_groups || {};

                    // Create the paper in the database
                    const dbPath = path.join(PROJECT_FOLDER, 'data', 'review_platform.db');
                    const paperDb = new Database(dbPath);

                    // Store categories and thematic groups in config
                    const config = JSON.stringify({
                        categories,
                        thematic_groups: thematicGroups,
                        parsed_by_ai: !!parsedData,
                        paper_dir: paperDir
                    });

                    // Use INSERT OR REPLACE since paper may already be registered during upload
                    paperDb.prepare(`
                        INSERT OR REPLACE INTO papers (id, title, authors, journal, field, description, review_date, config, content_hash)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT content_hash FROM papers WHERE id = ?))
                    `).run(paperId, title, authors, journal, field, 'Imported from uploaded files', new Date().toISOString().split('T')[0], config, paperId);

                    // Add reviewers and comments from parsed data using centralized function
                    let totalComments = 0;
                    const reviewers = parsedData?.reviewers || [];

                    if (reviewers.length > 0 && parsedData) {
                        // Use centralized storeParsedData for consistent processing
                        paperDb.close();  // Close db before calling storeParsedData (it uses global db)
                        storeParsedData(paperId, parsedData, null);  // No manuscript text in this path
                        totalComments = reviewers.reduce((sum, r) => sum + (r.comments?.length || 0), 0);
                    } else {
                        // Fallback: create placeholder reviewer and comment
                        const placeholderReviewerId = `${paperId}_reviewer-1`;
                        const placeholderCommentId = `${paperId}_R1.1`;

                        paperDb.prepare(`
                            INSERT INTO reviewers (id, paper_id, name, expertise, overall_assessment)
                            VALUES (?, ?, ?, ?, ?)
                        `).run(placeholderReviewerId, paperId, 'Reviewer 1', '', 'Comments to be parsed');

                        paperDb.prepare(`
                            INSERT INTO comments (id, paper_id, reviewer_id, type, category, original_text, status, priority)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            placeholderCommentId, paperId, placeholderReviewerId, 'major', 'Setup',
                            'Files have been uploaded. Use the AI chat to help parse and organize the reviewer comments from your uploaded documents.',
                            'pending', 'high'
                        );
                        totalComments = 1;
                        paperDb.close();
                    }

                    // Update paper status to complete
                    updatePaperStatus(paperId, 'complete');

                    log(`Created paper ${paperId}: "${title}" with ${reviewers.length} reviewers, ${totalComments} comments`);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        paper_id: paperId,
                        paper_dir: paperDir,
                        title: title,
                        file_count: fileCount,
                        reviewer_count: reviewers.length || 1,
                        comment_count: totalComments,
                        categories: categories,
                        parsed_by_ai: !!parsedData
                    }));
                } catch (e) {
                    log(`Setup create error: ${e.message}`, 'ERROR');
                    // Update paper status to error
                    try {
                        const { paper_id } = JSON.parse(body);
                        if (paper_id) updatePaperStatus(paper_id, 'error', e.message);
                    } catch (parseErr) { /* ignore */ }
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // DELETE /papers/:id - Delete a paper
        const paperDeleteMatch = req.url.match(/^\/papers\/([^/]+)$/);
        if (req.method === 'DELETE' && paperDeleteMatch) {
            const paperId = paperDeleteMatch[1];
            try {
                const dbPath = path.join(PROJECT_FOLDER || BASE_DIR, 'data', 'review_platform.db');
                if (!fs.existsSync(dbPath)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Database not found' }));
                    return;
                }

                const paperDb = new Database(dbPath);

                // Check if paper exists
                const paper = paperDb.prepare('SELECT id FROM papers WHERE id = ?').get(paperId);
                if (!paper) {
                    paperDb.close();
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Paper not found' }));
                    return;
                }

                // Delete paper and related data (cascade should handle this)
                paperDb.prepare('DELETE FROM papers WHERE id = ?').run(paperId);
                paperDb.close();

                // Delete paper directory (check both possible locations for backwards compatibility)
                const paperDir = path.join(PROJECT_FOLDER, 'papers', paperId);
                const legacyPaperDir = path.join(PROJECT_FOLDER, 'data', 'papers', paperId);
                if (fs.existsSync(paperDir)) {
                    fs.rmSync(paperDir, { recursive: true });
                }
                if (fs.existsSync(legacyPaperDir)) {
                    fs.rmSync(legacyPaperDir, { recursive: true });
                }

                log(`Deleted paper ${paperId}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                log(`Error deleting paper: ${e.message}`, 'ERROR');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // Static file serving - serve index.html, CSS, JS, etc.
        // Use BASE_DIR (where the code lives) for HTML/CSS/JS, not PROJECT_FOLDER (data)
        const staticDir = BASE_DIR;
        let urlPath = req.url.split('?')[0]; // Remove query string

        // Default to index.html for root
        if (urlPath === '/') {
            urlPath = '/index.html';
        }

        // Resolve and normalize paths to prevent directory traversal
        const resolvedStaticDir = path.resolve(staticDir);
        const filePath = path.resolve(path.join(staticDir, urlPath));

        // Security: prevent directory traversal (use resolved paths for proper comparison)
        if (!filePath.startsWith(resolvedStaticDir + path.sep) && filePath !== resolvedStaticDir) {
            log(`Path traversal attempt blocked: ${urlPath}`, 'WARN');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }

        // Check if file exists
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.js': 'application/javascript',
                '.json': 'application/json',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon',
                '.woff': 'font/woff',
                '.woff2': 'font/woff2',
                '.ttf': 'font/ttf',
                '.eot': 'application/vnd.ms-fontobject'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';

            try {
                const content = fs.readFileSync(filePath);
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Error reading file' }));
            }
            return;
        }

        // 404 for unknown routes
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, () => {
        log(`API server running on http://localhost:${port}`);
        log(`  GET  /config          - Get current config`);
        log(`  POST /config          - Update config`);
        log(`  GET  /session         - Get session info`);
        log(`  GET  /context-status  - Check if context is loaded`);
        log(`  POST /session/reset   - Reset session`);
        log(`  GET  /models          - Get available models`);
        log(`  POST /ask             - Send prompt to OpenCode`);
        log(`  GET  /webapp-schema   - Get webapp structure for context`);
        log(`  GET  /webapp-state    - Get live comment state`);
        log(`  --- Database endpoints ---`);
        log(`  GET  /db/status       - Check database status`);
        log(`  GET  /db/comments     - Load all comments`);
        log(`  POST /db/comments     - Save all comments`);
        log(`  GET  /db/experts      - Load expert discussions`);
        log(`  POST /db/expert       - Save expert discussion`);
        log(`  GET  /db/chat/:id     - Load chat history`);
        log(`  POST /db/chat         - Save chat message`);
        log(`  GET  /db/state/:key   - Load app state`);
        log(`  POST /db/state        - Save app state`);
        log(`  --- Paper management ---`);
        log(`  GET  /api/papers           - List all papers`);
        log(`  GET  /api/papers/incomplete - List incomplete papers`);
        log(`  DELETE /api/papers/:id     - Delete a paper`);
    });

    return server;
}

// Main
function main() {
    const command = process.argv[2]?.toLowerCase();

    // Initialize SQLite database
    const dbInitialized = initDatabase();
    if (!dbInitialized) {
        log('Failed to initialize database', 'ERROR');
        process.exit(1);
    }
    log('SQLite database ready');

    // Allow 'api' command to run API server without OpenCode
    if (command === 'api') {
        log('Starting API server only (no OpenCode required)');
        startApiServer(3001);
        return;
    }

    if (!OPENCODE_BIN) {
        console.log('='.repeat(60));
        console.log('WARNING: OpenCode not found');
        console.log('='.repeat(60));
        console.log();
        console.log('To use AI features, install OpenCode from https://opencode.ai');
        console.log();
        console.log('Starting API server only (for settings management)...');
        console.log();
        startApiServer(3001);
        return;
    }

    switch (command) {
        case 'once':
            processPendingRequests().then(n => {
                console.log(`Processed ${n} request(s)`);
                process.exit(0);
            });
            break;
        case 'info':
            showSessionInfo();
            break;
        case 'reset':
            resetSession();
            break;
        case 'help':
            console.log(`
OpenCode Server for Review Platform

Usage:
  node opencode-server.js        # Watch continuously
  node opencode-server.js once   # Process once
  node opencode-server.js info   # Show session info
  node opencode-server.js reset  # Reset session

Environment variables:
  OPENCODE_MODEL   - Model (default: openai/gpt-5.2-codex)
  OPENCODE_AGENT   - Agent (default: build)
  OPENCODE_VARIANT - Variant (default: high)
`);
            break;
        default:
            // Start both the file watcher and API server
            startApiServer(3001);
            watchAndProcess();
    }
}

main();
