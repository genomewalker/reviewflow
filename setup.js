#!/usr/bin/env node
/**
 * Paper Review Platform - Setup Script
 *
 * Uses OpenCode to parse reviewer comments and extract manuscript data.
 * Run with: node setup.js
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const INPUT_DIR = path.join(__dirname, 'input');
const DATA_DIR = path.join(__dirname, 'data');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

// Colors for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    red: '\x1b[31m',
    cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
    console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logStep(step, msg) {
    console.log(`${colors.cyan}[${step}]${colors.reset} ${msg}`);
}

function logSuccess(msg) {
    console.log(`${colors.green}✓${colors.reset} ${msg}`);
}

function logError(msg) {
    console.log(`${colors.red}✗${colors.reset} ${msg}`);
}

// Check if OpenCode is available
function checkOpenCode() {
    try {
        execSync('which opencode', { stdio: 'pipe' });
        return true;
    } catch {
        try {
            execSync('which claude', { stdio: 'pipe' });
            return 'claude';
        } catch {
            return false;
        }
    }
}

// Find input files
function findInputFiles() {
    if (!fs.existsSync(INPUT_DIR)) {
        return null;
    }

    const files = fs.readdirSync(INPUT_DIR);
    const result = {
        manuscript: null,
        reviews: null,
        supplementary: []
    };

    for (const file of files) {
        const lower = file.toLowerCase();
        const fullPath = path.join(INPUT_DIR, file);

        if (fs.statSync(fullPath).isDirectory()) {
            if (lower === 'supplementary' || lower === 'supp') {
                const suppFiles = fs.readdirSync(fullPath);
                result.supplementary = suppFiles.map(f => path.join(fullPath, f));
            }
            continue;
        }

        if (lower.includes('manuscript') || lower.includes('paper') || lower.includes('submission')) {
            result.manuscript = fullPath;
        } else if (lower.includes('review') || lower.includes('referee') || lower.includes('comment')) {
            result.reviews = fullPath;
        } else if (lower.endsWith('.pdf') || lower.endsWith('.txt') || lower.endsWith('.docx')) {
            // If not clearly labeled, try to guess
            if (!result.manuscript) {
                result.manuscript = fullPath;
            } else if (!result.reviews) {
                result.reviews = fullPath;
            }
        }
    }

    return result;
}

// Run OpenCode command and get output
async function runOpenCode(prompt, inputFiles = []) {
    return new Promise((resolve, reject) => {
        const cmd = checkOpenCode() === 'claude' ? 'claude' : 'opencode';

        // Build the command with file inputs
        let fullPrompt = prompt;
        if (inputFiles.length > 0) {
            fullPrompt = `First, read and analyze these files:\n${inputFiles.join('\n')}\n\nThen: ${prompt}`;
        }

        const args = ['--print', '-p', fullPrompt];

        const proc = spawn(cmd, args, {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let error = '';

        proc.stdout.on('data', (data) => {
            output += data.toString();
        });

        proc.stderr.on('data', (data) => {
            error += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(error || `OpenCode exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

// Parse reviewer comments using OpenCode
async function parseReviewerComments(reviewsPath) {
    logStep('2', 'Parsing reviewer comments with OpenCode...');

    const prompt = `Read the file at "${reviewsPath}" and parse all reviewer comments.

Output a JSON object with this exact structure:
{
  "manuscript": {
    "title": "Paper title if mentioned",
    "submission_date": "Date if known",
    "review_date": "Date if known"
  },
  "reviewers": [
    {
      "id": "R1",
      "name": "Referee #1",
      "expertise": "Inferred expertise area",
      "overall_assessment": "Brief summary of their overall view",
      "comments": [
        {
          "id": "R1-1",
          "type": "major",
          "category": "Methodology",
          "location": "Section/Figure if mentioned",
          "original_text": "The exact reviewer comment text",
          "full_context": "Any additional context",
          "priority": "high",
          "requires_new_analysis": false
        }
      ]
    }
  ]
}

Rules:
- Split multi-part comments into separate entries
- Infer "type" as "major", "minor", or "suggestion"
- Infer "category" from: Methodology, Data Analysis, Interpretation, Writing, Figures, Statistics, References, Other
- Infer "priority" as "high", "medium", or "low" based on importance
- Keep original_text as the exact quote
- Number comments sequentially per reviewer (R1-1, R1-2, R2-1, etc.)

Output ONLY valid JSON, no explanation.`;

    try {
        const output = await runOpenCode(prompt);

        // Extract JSON from output
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);

            // Add default fields to each comment
            for (const reviewer of data.reviewers) {
                for (const comment of reviewer.comments) {
                    comment.draft_response = '';
                    comment.status = 'pending';
                    comment.actions_taken = [];
                    comment.reviewerId = reviewer.id;
                    comment.reviewer = reviewer.name;
                }
            }

            return data;
        } else {
            throw new Error('Could not parse JSON from OpenCode output');
        }
    } catch (e) {
        logError(`Failed to parse reviews: ${e.message}`);
        return null;
    }
}

// Extract key data from manuscript
async function extractManuscriptData(manuscriptPath) {
    logStep('3', 'Extracting key data from manuscript...');

    const prompt = `Read the file at "${manuscriptPath}" and extract key statistics and claims.

Output a JSON object:
{
  "title": "Full paper title",
  "abstract_summary": "One paragraph summary",
  "key_statistics": [
    {"name": "Statistic name", "value": "Value", "context": "What it means"}
  ],
  "key_claims": [
    "Main claim 1",
    "Main claim 2"
  ],
  "methods_summary": "Brief methods description",
  "main_findings": ["Finding 1", "Finding 2"],
  "limitations_mentioned": ["Limitation 1"]
}

Output ONLY valid JSON.`;

    try {
        const output = await runOpenCode(prompt);
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (e) {
        logError(`Failed to extract manuscript data: ${e.message}`);
    }
    return null;
}

// Generate expert analysis for a comment
async function generateExpertAnalysis(comment, manuscriptData) {
    const prompt = `You are a panel of domain experts analyzing this reviewer comment.

COMMENT: "${comment.original_text}"
CATEGORY: ${comment.category}
TYPE: ${comment.type}

MANUSCRIPT DATA:
${JSON.stringify(manuscriptData, null, 2)}

Provide expert analysis as JSON:
{
  "experts": [
    {
      "name": "Expert title (e.g., Statistical Methods Expert)",
      "icon": "chart-bar",
      "color": "blue",
      "verdict": "One-line verdict",
      "assessment": "Detailed assessment",
      "data_analysis": ["Point 1", "Point 2"],
      "recommendation": "What to do",
      "key_data_points": ["Relevant stat 1"]
    }
  ],
  "recommended_response": "Draft response text addressing the comment with specific data",
  "advice_to_author": "Strategic advice"
}

Include 2-3 relevant experts. Use specific data from the manuscript. Output ONLY JSON.`;

    try {
        const output = await runOpenCode(prompt);
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (e) {
        // Return minimal structure on error
    }
    return {
        experts: [],
        recommended_response: '',
        advice_to_author: 'Analysis pending'
    };
}

// Main setup function
async function main() {
    console.log('\n' + '='.repeat(60));
    log('  Paper Review Platform - Setup', 'bright');
    console.log('='.repeat(60) + '\n');

    // Step 1: Check prerequisites
    logStep('1', 'Checking prerequisites...');

    const openCodeAvailable = checkOpenCode();
    if (!openCodeAvailable) {
        logError('OpenCode or Claude CLI not found. Please install it first.');
        logError('Visit: https://github.com/anthropics/anthropic-cli');
        process.exit(1);
    }
    logSuccess(`Found ${openCodeAvailable === 'claude' ? 'Claude' : 'OpenCode'} CLI`);

    // Check for input files
    const inputFiles = findInputFiles();
    if (!inputFiles || !inputFiles.reviews) {
        logError('No input files found!');
        log('\nPlease create an "input" folder with:', 'yellow');
        log('  - manuscript.pdf (or .txt, .docx) - Your submitted paper');
        log('  - reviews.txt (or .pdf) - The reviewer comments');
        log('  - supplementary/ (optional) - Supporting data files\n');

        // Create input directory with instructions
        if (!fs.existsSync(INPUT_DIR)) {
            fs.mkdirSync(INPUT_DIR, { recursive: true });
            fs.writeFileSync(path.join(INPUT_DIR, 'PUT_YOUR_FILES_HERE.txt'),
                'Add your files here:\n\n' +
                '1. manuscript.pdf - Your submitted manuscript\n' +
                '2. reviews.txt - The reviewer comments you received\n' +
                '3. supplementary/ - (optional) folder with data files\n\n' +
                'Then run: npm run setup\n'
            );
        }
        process.exit(1);
    }

    logSuccess(`Found reviews: ${path.basename(inputFiles.reviews)}`);
    if (inputFiles.manuscript) {
        logSuccess(`Found manuscript: ${path.basename(inputFiles.manuscript)}`);
    }
    if (inputFiles.supplementary.length > 0) {
        logSuccess(`Found ${inputFiles.supplementary.length} supplementary files`);
    }

    // Create data directory
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Step 2: Parse reviewer comments
    const reviewData = await parseReviewerComments(inputFiles.reviews);
    if (!reviewData) {
        logError('Failed to parse reviewer comments');
        process.exit(1);
    }

    const totalComments = reviewData.reviewers.reduce((sum, r) => sum + r.comments.length, 0);
    logSuccess(`Parsed ${totalComments} comments from ${reviewData.reviewers.length} reviewers`);

    // Step 3: Extract manuscript data (if available)
    let manuscriptData = null;
    if (inputFiles.manuscript) {
        manuscriptData = await extractManuscriptData(inputFiles.manuscript);
        if (manuscriptData) {
            logSuccess(`Extracted ${manuscriptData.key_statistics?.length || 0} key statistics`);
            reviewData.manuscript_data = manuscriptData;
        }
    }

    // Save the review data
    const reviewDataPath = path.join(DATA_DIR, 'reviewer_comments.json');
    fs.writeFileSync(reviewDataPath, JSON.stringify(reviewData, null, 2));
    logSuccess(`Saved review data to ${reviewDataPath}`);

    // Step 4: Generate expert analyses (optional, can be slow)
    console.log('');
    logStep('4', 'Generating expert analyses...');
    log('    This may take a few minutes for many comments.', 'yellow');
    log('    You can skip this and generate later from the web interface.\n', 'yellow');

    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const answer = await new Promise(resolve => {
        rl.question('Generate expert analyses now? (y/N): ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'y') {
        const expertDiscussions = {};
        let completed = 0;

        for (const reviewer of reviewData.reviewers) {
            for (const comment of reviewer.comments) {
                process.stdout.write(`\r    Processing ${++completed}/${totalComments}: ${comment.id}...`);

                const analysis = await generateExpertAnalysis(comment, manuscriptData);
                expertDiscussions[comment.id] = {
                    ...comment,
                    ...analysis,
                    generated_at: new Date().toISOString()
                };

                // Small delay to avoid rate limiting
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        console.log('');

        const expertPath = path.join(__dirname, 'expert_discussions.json');
        fs.writeFileSync(expertPath, JSON.stringify(expertDiscussions, null, 2));
        logSuccess(`Generated expert analyses for ${totalComments} comments`);
    } else {
        log('    Skipped. You can generate analyses from the web interface.', 'yellow');
    }

    // Done!
    console.log('\n' + '='.repeat(60));
    log('  Setup Complete!', 'green');
    console.log('='.repeat(60));
    console.log(`
Next steps:

1. Start the server:
   ${colors.cyan}npm start${colors.reset}

2. Open in browser:
   ${colors.cyan}open index.html${colors.reset}

3. (Optional) Generate/regenerate expert analyses from the web interface

`);
}

main().catch(e => {
    logError(`Setup failed: ${e.message}`);
    process.exit(1);
});
