/**
 * Generate Word document with formatted reviewer responses
 * Uses docx library for professional document generation
 */

const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
        BorderStyle, WidthType, AlignmentType, ShadingType } = require('docx');
const fs = require('fs');

// Load review data
function loadReviewData(jsonPath) {
    const data = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(data);
}

// Generate document sections
function generateDocument(data) {
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
            new TextRun(data.manuscript.title)
        ],
        spacing: { before: 200, after: 100 }
    }));

    children.push(new Paragraph({
        children: [
            new TextRun({ text: "Authors: ", bold: true }),
            new TextRun(data.manuscript.authors)
        ],
        spacing: { after: 200 }
    }));

    // Horizontal line
    children.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 1 } },
        spacing: { after: 400 }
    }));

    // Process each reviewer
    data.reviewers.forEach(reviewer => {
        // Reviewer header
        children.push(new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: reviewer.name, bold: true, size: 28 })]
        }));

        children.push(new Paragraph({
            children: [
                new TextRun({ text: "Expertise: ", bold: true, italics: true }),
                new TextRun({ text: reviewer.expertise, italics: true })
            ],
            spacing: { after: 100 }
        }));

        children.push(new Paragraph({
            children: [
                new TextRun({ text: "Assessment: ", bold: true, italics: true }),
                new TextRun({ text: reviewer.overall_assessment, italics: true })
            ],
            spacing: { after: 200 }
        }));

        // Process each comment
        reviewer.comments.forEach(comment => {
            // Comment header with status badge
            const statusColor = {
                'completed': '10B981',
                'in_progress': '3B82F6',
                'pending': 'F59E0B'
            }[comment.status] || 'F59E0B';

            children.push(new Paragraph({
                heading: HeadingLevel.HEADING_2,
                children: [
                    new TextRun({ text: `Comment ${comment.id}`, bold: true, size: 24 }),
                    new TextRun({ text: ` [${comment.type.toUpperCase()}]`, size: 20 }),
                    new TextRun({ text: ` - ${comment.status}`, size: 20, color: statusColor })
                ],
                spacing: { before: 300, after: 100 }
            }));

            // Location and category
            children.push(new Paragraph({
                children: [
                    new TextRun({ text: "Location: ", bold: true }),
                    new TextRun(comment.location || "General"),
                    new TextRun({ text: "  |  Category: ", bold: true }),
                    new TextRun(comment.category)
                ],
                spacing: { after: 150 }
            }));

            // Original comment in a box
            children.push(new Paragraph({
                children: [new TextRun({ text: "Reviewer Comment:", bold: true })],
                spacing: { before: 100 }
            }));

            children.push(new Paragraph({
                children: [new TextRun({ text: comment.original_text, italics: true })],
                indent: { left: 400 },
                shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' },
                spacing: { after: 200 }
            }));

            // Our response
            if (comment.draft_response) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: "Our Response:", bold: true, color: '059669' })]
                }));

                // Split response by newlines for proper formatting
                comment.draft_response.split('\n').forEach(line => {
                    if (line.trim()) {
                        children.push(new Paragraph({
                            children: [new TextRun(line)],
                            indent: { left: 400 },
                            spacing: { after: 100 }
                        }));
                    }
                });
            }

            // Required analyses
            if (comment.requires_new_analysis && comment.analysis_type && comment.analysis_type.length > 0) {
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: "Required Analyses: ", bold: true, color: '7C3AED' }),
                        new TextRun({ text: comment.analysis_type.join(', '), color: '7C3AED' })
                    ],
                    spacing: { before: 100, after: 200 }
                }));
            }

            // Separator
            children.push(new Paragraph({
                border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' } },
                spacing: { after: 200 }
            }));
        });
    });

    // Create document
    const doc = new Document({
        styles: {
            default: {
                document: {
                    run: { font: "Arial", size: 22 }
                }
            },
            paragraphStyles: [
                {
                    id: "Heading1",
                    name: "Heading 1",
                    basedOn: "Normal",
                    next: "Normal",
                    run: { size: 28, bold: true, font: "Arial" },
                    paragraph: { spacing: { before: 400, after: 200 } }
                },
                {
                    id: "Heading2",
                    name: "Heading 2",
                    basedOn: "Normal",
                    next: "Normal",
                    run: { size: 24, bold: true, font: "Arial" },
                    paragraph: { spacing: { before: 300, after: 150 } }
                }
            ]
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

    return doc;
}

// Generate summary statistics table
function generateStatistics(data) {
    const allComments = data.reviewers.flatMap(r => r.comments);
    return {
        total: allComments.length,
        completed: allComments.filter(c => c.status === 'completed').length,
        inProgress: allComments.filter(c => c.status === 'in_progress').length,
        pending: allComments.filter(c => c.status === 'pending').length,
        major: allComments.filter(c => c.type === 'major').length,
        minor: allComments.filter(c => c.type === 'minor').length,
        needsAnalysis: allComments.filter(c => c.requires_new_analysis).length
    };
}

// Main execution
async function main() {
    const jsonPath = process.argv[2] || 'data/reviewer_comments.json';
    const outputPath = process.argv[3] || 'response_to_reviewers.docx';

    console.log(`Loading review data from: ${jsonPath}`);
    const data = loadReviewData(jsonPath);

    console.log('Generating document...');
    const doc = generateDocument(data);

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);

    console.log(`Document saved to: ${outputPath}`);

    // Print statistics
    const stats = generateStatistics(data);
    console.log('\nStatistics:');
    console.log(`  Total comments: ${stats.total}`);
    console.log(`  Completed: ${stats.completed}`);
    console.log(`  In Progress: ${stats.inProgress}`);
    console.log(`  Pending: ${stats.pending}`);
    console.log(`  Major issues: ${stats.major}`);
    console.log(`  Needs new analysis: ${stats.needsAnalysis}`);
}

main().catch(console.error);
