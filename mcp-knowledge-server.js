#!/usr/bin/env node
/**
 * MCP Server for Rebuttr Knowledge Queries
 *
 * This server exposes tools that allow an AI to query worker sessions
 * that have context on supplementary files (tables, figures, data).
 *
 * Tools:
 * - list_data_sources: List available worker sessions and their content summaries
 * - query_data: Query a specific data source for information
 * - search_all_data: Search across all data sources for relevant information
 */

const http = require('http');

// Configuration
const REBUTTR_API = process.env.REBUTTR_API || process.env.REBUTTR_API || 'http://localhost:3001';
const PAPER_ID = process.env.PAPER_ID || null;

// Helper to make HTTP requests
async function fetchAPI(endpoint, options = {}) {
    const url = `${REBUTTR_API}${endpoint}`;

    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        };

        const req = http.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve({ raw: data });
                }
            });
        });

        req.on('error', reject);

        if (options.body) {
            req.write(JSON.stringify(options.body));
        }
        req.end();
    });
}

// Get current paper ID (from env or fetch from API)
async function getCurrentPaperId() {
    if (PAPER_ID) return PAPER_ID;

    // Try to get the most recent paper
    const result = await fetchAPI('/api/papers');
    if (result.success && result.papers && result.papers.length > 0) {
        return result.papers[0].id;
    }
    return null;
}

// MCP Tool definitions
const tools = [
    {
        name: 'list_data_sources',
        description: 'List all available data sources (worker sessions) that contain supplementary data like tables, figures, and processed files. Returns the filename, a summary of contents, and when it was last used.',
        inputSchema: {
            type: 'object',
            properties: {
                paper_id: {
                    type: 'string',
                    description: 'Optional paper ID. If not provided, uses the current paper.'
                }
            }
        }
    },
    {
        name: 'query_data',
        description: 'Query a specific data source for information. Use this when you need specific data from supplementary tables, figures, or other files. First use list_data_sources to see what\'s available.',
        inputSchema: {
            type: 'object',
            properties: {
                source_name: {
                    type: 'string',
                    description: 'The filename of the data source to query (e.g., "sup_table_2.md", "damage_data.json")'
                },
                question: {
                    type: 'string',
                    description: 'The question to ask about this data source'
                },
                paper_id: {
                    type: 'string',
                    description: 'Optional paper ID. If not provided, uses the current paper.'
                }
            },
            required: ['source_name', 'question']
        }
    },
    {
        name: 'search_all_data',
        description: 'Search across all available data sources to find relevant information. Use this when you\'re not sure which source contains the data you need. The system will automatically route your question to the appropriate sources.',
        inputSchema: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'The question to search for across all data sources'
                },
                paper_id: {
                    type: 'string',
                    description: 'Optional paper ID. If not provided, uses the current paper.'
                }
            },
            required: ['question']
        }
    }
];

// Tool implementations
async function listDataSources(args) {
    const paperId = args.paper_id || await getCurrentPaperId();
    if (!paperId) {
        return { error: 'No paper ID available. Please specify a paper_id.' };
    }

    const result = await fetchAPI(`/db/workers/${paperId}`);

    if (!result.success || !result.workers || result.workers.length === 0) {
        return {
            message: 'No data sources (worker sessions) found for this paper.',
            hint: 'Worker sessions are created when supplementary files are processed. Make sure the paper has been fully processed.'
        };
    }

    const sources = result.workers.map(w => ({
        name: w.fileName,
        summary: w.summary || 'No summary available',
        session_id: w.sessionId,
        last_used: w.lastUsed
    }));

    return {
        paper_id: paperId,
        data_sources: sources,
        count: sources.length,
        usage_hint: 'Use query_data with a source_name to query a specific source, or search_all_data to search across all sources.'
    };
}

async function queryData(args) {
    const paperId = args.paper_id || await getCurrentPaperId();
    if (!paperId) {
        return { error: 'No paper ID available. Please specify a paper_id.' };
    }

    if (!args.source_name || !args.question) {
        return { error: 'Both source_name and question are required.' };
    }

    // Query the specific worker
    const result = await fetchAPI('/db/workers/query', {
        method: 'POST',
        body: {
            paperId: paperId,
            fileName: args.source_name,
            question: args.question
        }
    });

    if (!result.success) {
        return {
            error: result.error || 'Failed to query data source',
            hint: 'Make sure the source_name matches one of the available data sources. Use list_data_sources to see available sources.'
        };
    }

    return {
        source: args.source_name,
        question: args.question,
        answer: result.response
    };
}

async function searchAllData(args) {
    const paperId = args.paper_id || await getCurrentPaperId();
    if (!paperId) {
        return { error: 'No paper ID available. Please specify a paper_id.' };
    }

    if (!args.question) {
        return { error: 'Question is required.' };
    }

    // Use the knowledge-query endpoint which does smart routing
    const result = await fetchAPI('/api/knowledge-query', {
        method: 'POST',
        body: {
            paperId: paperId,
            question: args.question
        }
    });

    if (!result.success) {
        return { error: result.error || 'Failed to search data sources' };
    }

    return {
        question: args.question,
        answer: result.response,
        source: result.source,
        queried_files: result.workerQueries?.map(q => q.file) || []
    };
}

// Handle tool calls
async function handleToolCall(toolName, args) {
    switch (toolName) {
        case 'list_data_sources':
            return await listDataSources(args);
        case 'query_data':
            return await queryData(args);
        case 'search_all_data':
            return await searchAllData(args);
        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

// MCP Protocol handling (stdio-based)
const readline = require('readline');

async function handleMessage(message) {
    const { jsonrpc, id, method, params } = message;

    if (jsonrpc !== '2.0') {
        return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } };
    }

    switch (method) {
        case 'initialize':
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: {
                        name: 'rebuttr-knowledge',
                        version: '1.0.0'
                    }
                }
            };

        case 'notifications/initialized':
            // Client acknowledged initialization
            return null;

        case 'tools/list':
            return {
                jsonrpc: '2.0',
                id,
                result: { tools }
            };

        case 'tools/call':
            const { name, arguments: args } = params;
            try {
                const result = await handleToolCall(name, args || {});
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                            }
                        ]
                    }
                };
            } catch (e) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({ error: e.message })
                            }
                        ],
                        isError: true
                    }
                };
            }

        default:
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Method not found: ${method}` }
            };
    }
}

// Main entry point
async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    // Log to stderr so it doesn't interfere with MCP protocol
    const log = (msg) => process.stderr.write(`[MCP Knowledge] ${msg}\n`);

    log('Starting MCP Knowledge Server...');
    log(`Rebuttr API: ${REBUTTR_API}`);
    if (PAPER_ID) log(`Paper ID: ${PAPER_ID}`);

    rl.on('line', async (line) => {
        try {
            const message = JSON.parse(line);
            const response = await handleMessage(message);
            if (response) {
                console.log(JSON.stringify(response));
            }
        } catch (e) {
            log(`Error processing message: ${e.message}`);
            console.log(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' }
            }));
        }
    });

    rl.on('close', () => {
        log('Connection closed');
        process.exit(0);
    });
}

main().catch(e => {
    process.stderr.write(`Fatal error: ${e.message}\n`);
    process.exit(1);
});
