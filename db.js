/**
 * ReviewFlow Database Module
 *
 * SQLite database layer using better-sqlite3
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;
const DB_PATH = path.join(BASE_DIR, 'data', 'review_platform.db');

// Load better-sqlite3 - required dependency
const Database = require('better-sqlite3');

// Schema for initializing the database
const SCHEMA = `
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

    CREATE TABLE IF NOT EXISTS reviewers (
        id TEXT NOT NULL,
        paper_id TEXT NOT NULL,
        name TEXT,
        expertise TEXT,
        overall_assessment TEXT,
        PRIMARY KEY (id, paper_id),
        FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

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

    CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT,
        comment_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_state (
        paper_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value JSON,
        PRIMARY KEY (paper_id, key)
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value JSON
    );

    CREATE INDEX IF NOT EXISTS idx_comments_paper ON comments(paper_id);
    CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(paper_id, status);
    CREATE INDEX IF NOT EXISTS idx_expert_paper ON expert_discussions(paper_id);
    CREATE INDEX IF NOT EXISTS idx_chat_paper ON chat_history(paper_id);
`;

// ============================================================================
// Main Database Interface
// ============================================================================

function getDb() {
    // Create data directory if needed
    const dataDir = path.join(BASE_DIR, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    return new Database(DB_PATH);
}

function initDatabase() {
    // Create directories
    const dirs = ['data', 'data/papers', 'input', 'output', 'sessions'];
    dirs.forEach(dir => {
        const p = path.join(BASE_DIR, dir);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });

    const db = getDb();
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    db.close();

    return true;
}

function dbExists() {
    return fs.existsSync(DB_PATH);
}

// ============================================================================
// Paper Operations
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
    const paperDir = path.join(BASE_DIR, 'data', 'papers', id);
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

function getPaperData(paperId) {
    const db = getDb();

    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);
    if (!paper) {
        db.close();
        return null;
    }

    const reviewers = db.prepare('SELECT * FROM reviewers WHERE paper_id = ?').all(paperId);
    const comments = db.prepare('SELECT * FROM comments WHERE paper_id = ?').all(paperId);

    const reviewData = {
        manuscript: {
            title: paper.title,
            authors: paper.authors,
            journal: paper.journal,
            field: paper.field,
            submission_date: paper.submission_date,
            review_date: paper.review_date
        },
        manuscript_data: paper.config ? JSON.parse(paper.config) : {},
        reviewers: reviewers.map(r => ({
            ...r,
            comments: comments
                .filter(c => c.reviewer_id === r.id)
                .map(c => ({
                    ...c,
                    analysis_type: c.analysis_type ? JSON.parse(c.analysis_type) : [],
                    experts: c.experts ? JSON.parse(c.experts) : []
                }))
        }))
    };

    db.close();
    return reviewData;
}

module.exports = {
    getDb,
    initDatabase,
    dbExists,
    listPapers,
    getPaper,
    addPaper,
    removePaper,
    importPaperData,
    getPaperData,
    generateId,
    DB_PATH
};
