#!/usr/bin/env node
/**
 * Full flow test for Rebuttr
 * Tests the complete upload and processing workflow with real files
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'http://localhost:3001';

// Files to test
const FILES = {
    manuscript: [
        '/Users/kbd606/Library/CloudStorage/OneDrive-Personal/Dropbox/LIFE/CPH/GeoGenetics/manuscripts/KapK/submission/nature/2025/02/10/20250808-kapk-review/20250210_KapK-microbial-submission.docx'
    ],
    review: [
        '/Users/kbd606/Library/CloudStorage/OneDrive-Personal/Dropbox/LIFE/CPH/GeoGenetics/manuscripts/KapK/submission/nature/2025/02/10/20250808-kapk-review/20250808-kapk-rewiews-round-1.docx'
    ],
    supplementary: [
        '/Users/kbd606/Library/CloudStorage/OneDrive-Personal/Dropbox/LIFE/CPH/GeoGenetics/manuscripts/KapK/submission/nature/2025/02/10/20250808-kapk-review/supplementary/20250210_KapK-microbial-supp-submission.docx',
        // Skip large xlsx files for initial test - they can be added later
        '/Users/kbd606/Library/CloudStorage/OneDrive-Personal/Dropbox/LIFE/CPH/GeoGenetics/manuscripts/KapK/submission/nature/2025/02/10/20250808-kapk-review/supplementary/tables/sup_table_2.xlsx'  // smallest xlsx
    ]
};

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function createPaper(title) {
    console.log(`\n📄 Creating paper: ${title}`);
    const response = await fetch(`${API_BASE}/papers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
    });

    if (!response.ok) {
        throw new Error(`Failed to create paper: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`   ✓ Paper created with ID: ${data.id}`);
    return data.id;
}

async function processFiles(paperId, files) {
    console.log(`\n📤 Uploading and processing files...`);

    const filesToProcess = [];

    for (const category of ['manuscript', 'review', 'supplementary']) {
        for (const filePath of files[category] || []) {
            if (!fs.existsSync(filePath)) {
                console.log(`   ⚠ File not found: ${filePath}`);
                continue;
            }

            const stats = fs.statSync(filePath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`   📁 ${category}: ${path.basename(filePath)} (${sizeMB} MB)`);

            const content = fs.readFileSync(filePath);
            const base64 = content.toString('base64');

            filesToProcess.push({
                name: path.basename(filePath),
                category: category,
                data: base64
            });
        }
    }

    console.log(`\n   Total files to process: ${filesToProcess.length}`);

    // Start processing
    const response = await fetch(`${API_BASE}/papers/${paperId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filesToProcess })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to start processing: ${error.error || response.statusText}`);
    }

    const result = await response.json();
    console.log(`   ✓ Processing started: ${result.job_id}`);
    return result.job_id;
}

async function pollStatus(paperId, jobId) {
    console.log(`\n⏳ Monitoring progress...`);
    console.log('─'.repeat(60));

    let lastLogCount = 0;
    let status = null;

    while (true) {
        const response = await fetch(`${API_BASE}/papers/${paperId}/status`);
        if (!response.ok) {
            console.log('   ⚠ Failed to get status');
            await sleep(2000);
            continue;
        }

        status = await response.json();

        // Print new log entries
        if (status.logs && status.logs.length > lastLogCount) {
            for (let i = lastLogCount; i < status.logs.length; i++) {
                const log = status.logs[i];
                const time = new Date(log.time).toLocaleTimeString();
                console.log(`   [${time}] ${log.message}`);
            }
            lastLogCount = status.logs.length;
        }

        // Check if done
        if (status.status === 'completed' || status.status === 'failed') {
            break;
        }

        // Show progress bar
        const progressBar = '█'.repeat(Math.floor(status.progress / 5)) + '░'.repeat(20 - Math.floor(status.progress / 5));
        process.stdout.write(`\r   [${progressBar}] ${status.progress}% - ${status.current_step || 'processing'}   `);

        await sleep(1000);
    }

    console.log('\n' + '─'.repeat(60));
    return status;
}

async function getExtractedData(paperId) {
    console.log(`\n📊 Fetching extracted data...`);

    // Get reviewers and comments
    const response = await fetch(`${API_BASE}/papers/${paperId}/data`);
    if (!response.ok) {
        // Try alternative endpoint
        const altResponse = await fetch(`${API_BASE}/db/comments?paper_id=${paperId}`);
        if (altResponse.ok) {
            return await altResponse.json();
        }
        throw new Error('Failed to get extracted data');
    }

    return await response.json();
}

async function compareWithOriginal(paperId) {
    console.log(`\n🔍 Comparing extraction with original...`);

    // Read the original reviews file
    const reviewsPath = FILES.review[0];

    // We can't easily read docx without a library, but we can check what was extracted
    // Let's look at the paper folder
    const paperFolder = `/Users/kbd606/Library/CloudStorage/OneDrive-Personal/Dropbox/LIFE/CPH/GeoGenetics/manuscripts/reviews/papers/${paperId}`;

    console.log(`\n   Paper folder: ${paperFolder}`);

    if (fs.existsSync(paperFolder)) {
        const files = fs.readdirSync(paperFolder, { recursive: true });
        console.log(`   Files saved:`);
        for (const file of files) {
            const fullPath = path.join(paperFolder, file);
            if (fs.statSync(fullPath).isFile()) {
                const sizeMB = (fs.statSync(fullPath).size / 1024).toFixed(1);
                console.log(`     - ${file} (${sizeMB} KB)`);
            }
        }

        // Check for _parsed_data.json
        const parsedDataPath = path.join(paperFolder, '_parsed_data.json');
        if (fs.existsSync(parsedDataPath)) {
            const parsedData = JSON.parse(fs.readFileSync(parsedDataPath, 'utf8'));
            console.log(`\n   📋 Parsed Data Summary:`);
            console.log(`      Reviewers: ${parsedData.reviewers?.length || 0}`);

            let totalComments = 0;
            let majorComments = 0;
            let minorComments = 0;

            for (const reviewer of parsedData.reviewers || []) {
                const comments = reviewer.comments?.length || 0;
                const major = reviewer.comments?.filter(c => c.category === 'major').length || 0;
                const minor = reviewer.comments?.filter(c => c.category === 'minor').length || 0;
                totalComments += comments;
                majorComments += major;
                minorComments += minor;
                console.log(`      - ${reviewer.name}: ${comments} comments (${major} major, ${minor} minor)`);
            }

            console.log(`\n      Total comments: ${totalComments}`);
            console.log(`      Major: ${majorComments}`);
            console.log(`      Minor: ${minorComments}`);

            // Show sample comments
            console.log(`\n   📝 Sample Comments (first 3):`);
            let shown = 0;
            for (const reviewer of parsedData.reviewers || []) {
                for (const comment of reviewer.comments || []) {
                    if (shown >= 3) break;
                    console.log(`\n      [${reviewer.name}] ${comment.category?.toUpperCase() || 'N/A'}:`);
                    const text = comment.text || comment.content || '';
                    console.log(`      "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
                    shown++;
                }
                if (shown >= 3) break;
            }
        }
    } else {
        console.log(`   ⚠ Paper folder not found`);
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('   Rebuttr Full Test');
    console.log('═'.repeat(60));

    try {
        // Step 1: Create paper
        const paperId = await createPaper('KapK Microbial Manuscript - Test');

        // Step 2: Process files
        const jobId = await processFiles(paperId, FILES);

        // Step 3: Monitor progress
        const finalStatus = await pollStatus(paperId, jobId);

        if (finalStatus.status === 'completed') {
            console.log('\n✅ Processing completed successfully!');
        } else {
            console.log(`\n❌ Processing failed: ${finalStatus.error}`);
        }

        // Step 4: Compare results
        await compareWithOriginal(paperId);

        console.log('\n' + '═'.repeat(60));
        console.log('   Test Complete');
        console.log('═'.repeat(60) + '\n');

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
