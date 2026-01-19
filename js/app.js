/**
 * Rebuttr - Main Application JavaScript
 * Modularized from original monolithic index.html
 */

const API_BASE = 'http://localhost:3001';

        // HTML escape function to prevent XSS
        function escapeHtml(text) {
            if (text === null || text === undefined) return '';
            const str = String(text);
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        // Check for paper ID in URL - redirect to landing if not present
        (function() {
            const urlParams = new URLSearchParams(window.location.search);
            const paperId = urlParams.get('paper');
            if (!paperId) {
                window.location.href = 'index.html';
                return;
            }
        })();

        // Global state
        let reviewData = null;
        let currentView = 'overview';
        let currentFilter = null;
        let editingComment = null;

        // Multi-paper state
        let papers = [];           // All available papers
        let currentPaperId = null; // Currently selected paper

        // OpenCode API connection
        let apiConnected = false;
        let currentRequestId = null;
        let pollInterval = null;

        // Chat state
        let chatHistory = [];
        let chatIsOpen = false;
        let chatIsTyping = false;
        let chatConversations = {};  // Grouped by comment_id: { 'chat': [...], 'knowledge': [...], 'R1.1': [...] }
        let currentChatContext = 'chat';  // Which conversation is active

        // Comment relationship state
        let commentRelationships = {};  // Maps comment ID -> related comment IDs
        let commentChatContext = null;  // Current comment being discussed in chat

        // AI Settings (moved here to be available globally)
        let aiSettings = {
            model: 'openai/gpt-4o-mini',
            agent: 'build',
            variant: 'high'
        };

        // =====================================================
        // OPENCODE LOADING INDICATOR SYSTEM
        // =====================================================

        // Track active background tasks
        const activeLoadingIndicators = new Map();

        /**
         * Update the processing button visibility and count
         */
        function updateProcessingButton() {
            const btn = document.getElementById('processing-btn');
            const badge = document.getElementById('processing-count');
            const count = activeLoadingIndicators.size;

            if (count > 0) {
                btn?.classList.remove('hidden');
                if (badge) badge.textContent = count;
            } else {
                btn?.classList.add('hidden');
                // Also hide panel if no tasks
                document.getElementById('processing-panel')?.classList.add('hidden');
            }
        }

        /**
         * Update the processing panel list
         */
        function updateProcessingPanel() {
            const list = document.getElementById('processing-list');
            if (!list) return;

            if (activeLoadingIndicators.size === 0) {
                list.innerHTML = '<div class="processing-empty">No active tasks</div>';
                return;
            }

            let html = '';
            activeLoadingIndicators.forEach((info, id) => {
                const elapsed = Math.round((Date.now() - info.startTime) / 1000);
                html += `
                    <div class="processing-item" data-id="${id}">
                        <div class="processing-item-spinner"><i class="fas fa-circle-notch fa-spin"></i></div>
                        <div class="processing-item-text">${escapeHtml(info.message)}</div>
                        <div class="processing-item-time">${elapsed}s</div>
                    </div>
                `;
            });
            list.innerHTML = html;
        }

        /**
         * Toggle the processing panel visibility
         */
        function toggleProcessingPanel() {
            const panel = document.getElementById('processing-panel');
            if (panel) {
                panel.classList.toggle('hidden');
                if (!panel.classList.contains('hidden')) {
                    updateProcessingPanel();
                }
            }
        }

        /**
         * Show a loading indicator for OpenCode API calls
         * @param {string} id - Unique identifier for this loading operation
         * @param {string} message - Message to display
         * @param {object} options - Optional settings { style: 'toast'|'overlay' }
         * @returns {function} - Cleanup function to remove the indicator
         */
        function showOpenCodeLoading(id, message, options = {}) {
            const { style = 'toast' } = options;

            // Remove existing indicator with same ID
            hideOpenCodeLoading(id);

            // For overlay style, create a full-screen overlay (blocking)
            if (style === 'overlay') {
                const overlay = document.createElement('div');
                overlay.id = `opencode-loading-${id}`;
                overlay.className = 'opencode-overlay';
                overlay.innerHTML = `
                    <div class="opencode-overlay-content">
                        <i class="fas fa-circle-notch fa-spin"></i>
                        <div>${escapeHtml(message)}</div>
                    </div>
                `;
                document.body.appendChild(overlay);

                activeLoadingIndicators.set(id, {
                    element: overlay,
                    startTime: Date.now(),
                    message,
                    isOverlay: true
                });
            } else {
                // Add to background tasks (shown in processing panel)
                activeLoadingIndicators.set(id, {
                    element: null,
                    startTime: Date.now(),
                    message,
                    isOverlay: false
                });
            }

            updateProcessingButton();
            updateProcessingPanel();

            // Return cleanup function
            return () => hideOpenCodeLoading(id);
        }

        /**
         * Hide a loading indicator
         * @param {string} id - The ID of the indicator to hide
         * @param {object} options - Optional { success: boolean, message: string }
         */
        function hideOpenCodeLoading(id, options = {}) {
            const info = activeLoadingIndicators.get(id);
            if (!info) return;

            // Remove overlay if it exists
            if (info.isOverlay && info.element) {
                info.element.remove();
            }

            activeLoadingIndicators.delete(id);
            updateProcessingButton();
            updateProcessingPanel();

            // Show a brief notification if message provided
            if (options.message) {
                showNotification(options.message, options.success ? 'success' : 'error');
            }
        }

        /**
         * Update the message of an existing loading indicator
         * @param {string} id - The ID of the indicator
         * @param {string} message - New message to display
         */
        function updateOpenCodeLoading(id, message) {
            const info = activeLoadingIndicators.get(id);
            if (!info) return;

            info.message = message;
            updateProcessingPanel();
        }

        // Update elapsed times in processing panel periodically
        setInterval(() => {
            if (activeLoadingIndicators.size > 0) {
                const panel = document.getElementById('processing-panel');
                if (panel && !panel.classList.contains('hidden')) {
                    updateProcessingPanel();
                }
            }
        }, 1000);

        // =====================================================
        // MULTI-PAPER MANAGEMENT
        // =====================================================

        // Load all available papers from the database
        async function loadPapers() {
            try {
                const response = await fetch(`${API_BASE}/papers`);
                if (response.ok) {
                    papers = await response.json();
                    updatePaperDropdown();

                    // Check URL for paper parameter
                    const urlParams = new URLSearchParams(window.location.search);
                    const urlPaperId = urlParams.get('paper');

                    if (urlPaperId && papers.find(p => p.id === urlPaperId)) {
                        currentPaperId = urlPaperId;
                    } else if (papers.length > 0) {
                        currentPaperId = papers[0].id;
                    }

                    if (currentPaperId) {
                        await loadPaperData(currentPaperId);
                    }
                }
            } catch (e) {
                console.log('Could not load papers from API, using local data');
                // Fall back to existing data loading
            }
        }

        // Update the paper dropdown in sidebar
        function updatePaperDropdown() {
            const dropdown = document.getElementById('paper-dropdown');
            if (!dropdown) return;

            dropdown.innerHTML = papers.length === 0
                ? '<option value="">No papers yet - add one!</option>'
                : papers.map(p => `<option value="${p.id}" ${p.id === currentPaperId ? 'selected' : ''}>${p.title}</option>`).join('');
        }

        // Switch to a different paper
        async function switchPaper(paperId) {
            if (!paperId || paperId === currentPaperId) return;

            currentPaperId = paperId;
            localStorage.setItem('rebuttr_last_paper', paperId);
            await loadPaperData(paperId);

            // Update URL without reload
            const url = new URL(window.location);
            url.searchParams.set('paper', paperId);
            window.history.pushState({}, '', url);
        }

        // Load data for a specific paper
        async function loadPaperData(paperId) {
            // Show skeleton loader while fetching
            if (currentView === 'overview') {
                showOverviewSkeleton();
            } else if (currentView === 'comments' || currentView === 'byreviewer') {
                showCommentsSkeleton();
            }

            try {
                const response = await fetch(`${API_BASE}/papers/${paperId}/data`);
                if (response.ok) {
                    reviewData = await response.json();
                    console.log('Loaded paper data:', {
                        title: reviewData?.manuscript?.title,
                        reviewers: reviewData?.reviewers?.length,
                        comments: reviewData?.reviewers?.reduce((sum, r) => sum + (r.comments?.length || 0), 0)
                    });

                    // Load expert discussions for this paper
                    await loadExpertDiscussions();
                    console.log('Loaded expert discussions:', Object.keys(expertDiscussions?.expert_discussions || {}).length);

                    // Load chat history for this paper
                    await loadChatHistoryFromDB();

                    // Sync expert data with comments for consistent display
                    syncExpertDataWithComments();

                    buildCommentRelationships();

                    // Set view from URL parameter or default
                    currentView = getInitialView();
                    setView(currentView);

                    document.getElementById('manuscript-title').textContent = reviewData?.manuscript?.title || 'Untitled';
                    updateSidebar(); // Update sidebar progress
                    console.log('Sidebar updated');
                    // Update context status to reflect loaded data
                    if (typeof updateContextFromLoadedData === 'function') {
                        updateContextFromLoadedData();
                    }
                } else {
                    console.error('Failed to load paper data:', response.status);
                    showNotification('Failed to load paper data', 'error');
                }
            } catch (e) {
                console.error('Could not load paper data from API:', e);
                showNotification('Could not connect to server', 'error');
            }
        }

        // =====================================================
        // COMMENT RELATIONSHIP SYSTEM
        // =====================================================

        // Define thematic groups that link comments together
        const THEMATIC_GROUPS = {
            'dna_damage_authentication': {
                name: 'DNA Damage & Authentication',
                keywords: ['damage', 'deamination', 'authentication', 'cytosine', 'ancient', 'C→T', 'terminal', 'mapDamage', 'pydamage'],
                categories: ['Authentication'],
                color: 'red'
            },
            'contamination_controls': {
                name: 'Contamination & Controls',
                keywords: ['contamination', 'control', 'blank', 'extraction', 'laboratory', 'modern', 'contaminant'],
                categories: [],
                color: 'orange'
            },
            'age_dating': {
                name: 'Age & Dating',
                keywords: ['age', 'dating', 'million', 'years', 'magnetostratigraphy', 'olduvai', 'geological', 'geochronology'],
                categories: [],
                color: 'purple'
            },
            'evolution_phylogeny': {
                name: 'Evolution & Phylogeny',
                keywords: ['evolution', 'phylogen', 'molecular clock', 'divergence', 'branch', 'tree', 'related', 'similarity'],
                categories: [],
                color: 'blue'
            },
            'methodology': {
                name: 'Methods & Analysis',
                keywords: ['method', 'pipeline', 'analysis', 'software', 'tool', 'parameter', 'threshold'],
                categories: ['Methods', 'Analysis', 'Validation'],
                color: 'cyan'
            },
            'terminology': {
                name: 'Terminology & Definitions',
                keywords: ['term', 'definition', 'biomarker', 'eDNA', 'sedaDNA', 'nomenclature'],
                categories: ['Terminology', 'Clarity'],
                color: 'yellow'
            },
            'ecology_interpretation': {
                name: 'Ecology & Interpretation',
                keywords: ['ecology', 'ecosystem', 'environment', 'habitat', 'community', 'methane', 'wetland', 'boreal'],
                categories: ['Interpretation', 'Discussion'],
                color: 'green'
            },
            'figures_tables': {
                name: 'Figures & Tables',
                keywords: ['figure', 'table', 'panel', 'legend', 'axis', 'label', 'visualization'],
                categories: ['Figure', 'Tables'],
                color: 'indigo'
            }
        };

        // Build relationships between comments
        function buildCommentRelationships() {
            if (!reviewData) return;

            const allComments = getAllComments();
            commentRelationships = {};

            // Initialize empty arrays for each comment
            allComments.forEach(c => {
                commentRelationships[c.id] = {
                    direct: [],      // Same category
                    thematic: [],    // Same thematic group
                    groups: []       // Which thematic groups this belongs to
                };
            });

            // Group comments by category
            const byCategory = {};
            allComments.forEach(c => {
                if (!byCategory[c.category]) byCategory[c.category] = [];
                byCategory[c.category].push(c.id);
            });

            // Add category-based relationships
            Object.values(byCategory).forEach(ids => {
                ids.forEach(id1 => {
                    ids.forEach(id2 => {
                        if (id1 !== id2 && !commentRelationships[id1].direct.includes(id2)) {
                            commentRelationships[id1].direct.push(id2);
                        }
                    });
                });
            });

            // Add thematic group relationships
            Object.entries(THEMATIC_GROUPS).forEach(([groupId, group]) => {
                const matchingComments = allComments.filter(c => {
                    // Check if category matches
                    if (group.categories.includes(c.category)) return true;

                    // Check if any keyword matches in the comment text
                    const text = (c.original_text + ' ' + (c.full_context || '')).toLowerCase();
                    return group.keywords.some(kw => text.includes(kw.toLowerCase()));
                });

                // Link all comments in this thematic group
                matchingComments.forEach(c1 => {
                    commentRelationships[c1.id].groups.push(groupId);
                    matchingComments.forEach(c2 => {
                        if (c1.id !== c2.id && !commentRelationships[c1.id].thematic.includes(c2.id)) {
                            commentRelationships[c1.id].thematic.push(c2.id);
                        }
                    });
                });
            });

            console.log('Built comment relationships:', Object.keys(commentRelationships).length, 'comments mapped');
        }

        // Get related comments for a given comment
        function getRelatedComments(commentId) {
            const rel = commentRelationships[commentId];
            if (!rel) return { direct: [], thematic: [], groups: [] };

            // Get unique related IDs
            const allRelated = [...new Set([...rel.direct, ...rel.thematic])];
            const comments = getAllComments();

            return {
                direct: rel.direct.map(id => comments.find(c => c.id === id)).filter(Boolean),
                thematic: rel.thematic.filter(id => !rel.direct.includes(id)).map(id => comments.find(c => c.id === id)).filter(Boolean),
                groups: rel.groups.map(g => THEMATIC_GROUPS[g]),
                allIds: allRelated
            };
        }

        // Show related comments panel
        function showRelatedComments(commentId) {
            const related = getRelatedComments(commentId);
            const comment = getAllComments().find(c => c.id === commentId);

            if (!comment) return;

            const modal = document.createElement('div');
            modal.id = 'related-comments-modal';
            modal.className = 'modal-overlay';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

            const groupBadges = related.groups.map(g =>
                `<span class="badge badge-${g.color === 'blue' ? 'inprogress' : g.color === 'green' ? 'complete' : 'pending'}">${g.name}</span>`
            ).join('');

            modal.innerHTML = `
                <div class="modal" style="max-width: 700px;">
                    <div class="modal-header" style="background: var(--scholar); color: white; border-bottom: none;">
                        <div>
                            <h3 class="modal-title" style="color: white;">Related Comments for ${commentId}</h3>
                            <p style="font-size: var(--text-sm); opacity: 0.8;">${comment.category} - ${comment.type}</p>
                            <div style="display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-2);">${groupBadges}</div>
                        </div>
                        <button onclick="this.closest('#related-comments-modal').remove()" class="btn-icon" style="color: white;">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="modal-body" style="max-height: 60vh; overflow-y: auto;">
                        ${related.direct.length > 0 ? `
                            <div style="margin-bottom: var(--sp-4);">
                                <h4 style="font-weight: 600; color: var(--ink); margin-bottom: var(--sp-2); display: flex; align-items: center; gap: var(--sp-2);">
                                    <i class="fas fa-link" style="color: var(--scholar);"></i>
                                    Same Category (${related.direct.length})
                                </h4>
                                <div style="display: flex; flex-direction: column; gap: var(--sp-2);">
                                    ${related.direct.map(c => renderRelatedCommentItem(c, commentId)).join('')}
                                </div>
                            </div>
                        ` : ''}
                        ${related.thematic.length > 0 ? `
                            <div>
                                <h4 style="font-weight: 600; color: var(--ink); margin-bottom: var(--sp-2); display: flex; align-items: center; gap: var(--sp-2);">
                                    <i class="fas fa-project-diagram" style="color: #9333ea;"></i>
                                    Thematically Related (${related.thematic.length})
                                </h4>
                                <div style="display: flex; flex-direction: column; gap: var(--sp-2);">
                                    ${related.thematic.map(c => renderRelatedCommentItem(c, commentId)).join('')}
                                </div>
                            </div>
                        ` : ''}
                        ${related.direct.length === 0 && related.thematic.length === 0 ? `
                            <p style="color: var(--ink-muted); text-align: center; padding: var(--sp-8);">No related comments found.</p>
                        ` : ''}
                    </div>
                    <div class="modal-footer">
                        <button onclick="discussCommentInChat('${commentId}')" class="btn btn-primary">
                            <i class="fas fa-comments"></i> Discuss in Chat
                        </button>
                        <button onclick="this.closest('#related-comments-modal').remove()" class="btn btn-secondary">
                            Close
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);
        }

        // Render a related comment item
        function renderRelatedCommentItem(comment, currentId) {
            const statusClasses = {
                'pending': 'badge-pending',
                'in_progress': 'badge-inprogress',
                'completed': 'badge-complete'
            };
            return `
                <div class="related-comment-item"
                     onclick="openCommentModal('${comment.reviewerId}', '${comment.id}'); document.getElementById('related-comments-modal')?.remove();">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--sp-1);">
                        <span style="font-weight: 600; color: var(--ink);">${comment.id}</span>
                        <span class="badge ${statusClasses[comment.status] || 'badge-pending'}">${comment.status}</span>
                    </div>
                    <p style="font-size: var(--text-sm); color: var(--ink-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${comment.original_text.substring(0, 120)}...</p>
                    <div style="display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-2);">
                        <span class="badge badge-pending">${comment.category}</span>
                        <span style="font-size: var(--text-xs); color: var(--ink-light);">${comment.reviewer}</span>
                    </div>
                </div>
            `;
        }

        // Discuss a comment in the floating chat
        function discussCommentInChat(commentId) {
            const comment = getAllComments().find(c => c.id === commentId);
            if (!comment) return;

            // Close related comments modal if open
            document.getElementById('related-comments-modal')?.remove();

            // Set chat context
            commentChatContext = {
                id: commentId,
                reviewer: comment.reviewer,
                category: comment.category,
                text: comment.original_text.substring(0, 500),
                currentResponse: comment.draft_response || null,
                status: comment.status,
                relatedIds: getRelatedComments(commentId).allIds
            };

            // Open chat
            if (!chatIsOpen) toggleChat();

            // Add context message
            const contextMsg = `📌 **Now discussing: ${commentId}**
**Reviewer:** ${comment.reviewer}
**Category:** ${comment.category}
**Status:** ${comment.status}
${commentChatContext.relatedIds.length > 0 ? `**Related:** ${commentChatContext.relatedIds.slice(0, 5).join(', ')}${commentChatContext.relatedIds.length > 5 ? '...' : ''}` : ''}

"${comment.original_text.substring(0, 200)}${comment.original_text.length > 200 ? '...' : ''}"

---
Ask me anything about this comment, or request a draft response.`;

            addChatMessage('assistant', contextMsg);
            updateChatContextBadge();
        }

        // Update chat context badge
        function updateChatContextBadge() {
            const badge = document.getElementById('chat-context-badge');
            if (badge) {
                if (commentChatContext) {
                    badge.innerHTML = `<i class="fas fa-comment-dots mr-1"></i>${commentChatContext.id}`;
                    badge.classList.remove('hidden');
                } else if (contextLoaded) {
                    badge.innerHTML = `<i class="fas fa-database mr-1"></i>Context`;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        }

        // Check API connection status
        async function checkApiConnection() {
            try {
                const response = await fetch(`${API_BASE}/config`);
                apiConnected = response.ok;
            } catch (e) {
                apiConnected = false;
            }
            updateApiStatus();
            return apiConnected;
        }

        function updateApiStatus() {
            const statusEl = document.getElementById('ws-status');
            if (statusEl) {
                statusEl.className = `text-xs px-2 py-1 rounded ${apiConnected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`;
                statusEl.textContent = apiConnected ? '● OpenCode Ready' : '○ API Offline';
            }
            // Also update modal status if it exists
            const modalStatus = document.getElementById('ws-status-modal');
            if (modalStatus) {
                modalStatus.className = `text-xs px-2 py-1 rounded ${apiConnected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`;
                modalStatus.textContent = apiConnected ? '● OpenCode Ready' : '○ Not Connected';
            }
        }

        // Submit request to OpenCode via file-based API
        async function submitToOpenCode(prompt, commentId) {
            const requestId = `req_${Date.now()}`;

            // Write request to claude_requests.json
            const request = {
                id: requestId,
                comment_id: commentId,
                prompt: prompt,
                status: 'pending',
                timestamp: new Date().toISOString()
            };

            try {
                // Read existing requests
                let requests = [];
                try {
                    const resp = await fetch('claude_requests.json');
                    if (resp.ok) requests = await resp.json();
                } catch (e) {}

                // Add new request
                requests.push(request);

                // Save requests file - this triggers the opencode-server.js
                await saveJsonFile('claude_requests.json', requests);

                return requestId;
            } catch (e) {
                console.error('Error submitting request:', e);
                return null;
            }
        }

        // Save JSON file via simple POST (for local development)
        async function saveJsonFile(filename, data) {
            // Try API endpoint first
            try {
                const response = await fetch(`${API_BASE}/request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, data })
                });
                if (response.ok) return true;
            } catch (e) {}

            // Fallback: write to localStorage for manual processing
            localStorage.setItem(filename, JSON.stringify(data));
            return true;
        }

        // Poll for response
        async function pollForResponse(requestId, commentId, maxAttempts = 60) {
            let attempts = 0;
            let localPollInterval = null;

            return new Promise((resolve, reject) => {
                localPollInterval = setInterval(async () => {
                    attempts++;

                    try {
                        const resp = await fetch('claude_responses.json?t=' + Date.now());
                        if (resp.ok) {
                            const responses = await resp.json();
                            const response = responses.find(r => r.request_id === requestId);

                            if (response && response.status === 'completed') {
                                clearInterval(localPollInterval);
                                resolve(response.response);
                                return;
                            }
                        }
                    } catch (e) {
                        // Clear interval on error to prevent memory leak
                        clearInterval(localPollInterval);
                        reject(e);
                        return;
                    }

                    if (attempts >= maxAttempts) {
                        clearInterval(localPollInterval);
                        reject(new Error('Response timeout'));
                    }
                }, 2000); // Poll every 2 seconds

                // Store reference for external cleanup if needed
                pollInterval = localPollInterval;
            });
        }

        function handleOpenCodeResponse(data) {
            if (data.type === 'opencode_response') {
                // Check if this is an agent consultation response
                if (data.comment_id === 'agent-consultation' || currentAgentConsultation) {
                    handleAgentResponse(data.response);
                    return;
                }

                // Otherwise it's a comment response
                const loadingEl = document.getElementById('opencode-loading');
                if (loadingEl) loadingEl.classList.add('hidden');

                const responseEl = document.getElementById('edit-response');
                if (responseEl && data.response) {
                    responseEl.value = data.response;
                    // Trigger preview update
                    responseEl.dispatchEvent(new Event('input'));
                }

                // Update the comment data
                if (editingComment) {
                    const reviewer = reviewData.reviewers.find(r => r.id === editingComment.reviewerId);
                    const comment = reviewer?.comments.find(c => c.id === editingComment.commentId);
                    if (comment) {
                        comment.draft_response = data.response;
                    }
                }
            } else if (data.type === 'request_received') {
                console.log('Request received by OpenCode:', data.request_id);
            }
        }

        async function askOpenCodeForResponse() {
            if (!editingComment) return;

            const reviewer = reviewData.reviewers.find(r => r.id === editingComment.reviewerId);
            const comment = reviewer?.comments.find(c => c.id === editingComment.commentId);
            if (!comment) return;

            if (comment.actions_taken.length === 0) {
                alert('Please check at least one action you have taken before generating a response.');
                return;
            }

            const prompt = buildPrompt(comment, reviewer);
            const loadingEl = document.getElementById('opencode-loading');
            const btnEl = document.getElementById('ask-opencode-btn');

            // Show loading state
            if (loadingEl) loadingEl.classList.remove('hidden');
            if (btnEl) btnEl.disabled = true;

            try {
                // Submit request to OpenCode API
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: prompt,
                        comment_id: comment.id,
                        model: aiSettings.model,
                        agent: aiSettings.agent,
                        variant: aiSettings.variant
                    })
                });

                if (response.ok) {
                    const result = await response.json();

                    // Update the response textarea
                    const responseEl = document.getElementById('edit-response');
                    if (responseEl && result.response) {
                        // Track version history for AI-generated response
                        const oldResponse = comment.draft_response || '';
                        if (oldResponse !== result.response) {
                            await saveVersionHistoryEntry(
                                comment.id,
                                currentPaperId,
                                'draft_response',
                                oldResponse,
                                result.response,
                                'ai'
                            );
                        }

                        responseEl.value = result.response;
                        responseEl.dispatchEvent(new Event('input'));
                        comment.draft_response = result.response;
                        showNotification('Response generated successfully!', 'success');
                        scheduleAutoSave(); // Auto-save after AI response
                    }
                } else {
                    throw new Error('API request failed');
                }
            } catch (e) {
                console.error('OpenCode error:', e);
                // Fallback: copy prompt to clipboard
                navigator.clipboard.writeText(prompt).then(() => {
                    alert('OpenCode server not available.\n\nPrompt copied to clipboard!\nRun: node opencode-server.js\nOr paste the prompt in your AI tool.');
                });
            } finally {
                if (loadingEl) loadingEl.classList.add('hidden');
                if (btnEl) btnEl.disabled = false;
            }
        }

        async function pasteResponse() {
            try {
                const text = await navigator.clipboard.readText();
                const responseEl = document.getElementById('edit-response');
                if (responseEl && text) {
                    responseEl.value = text;
                    responseEl.dispatchEvent(new Event('input'));

                    // Update comment data
                    if (editingComment) {
                        const reviewer = reviewData.reviewers.find(r => r.id === editingComment.reviewerId);
                        const comment = reviewer?.comments.find(c => c.id === editingComment.commentId);
                        if (comment) {
                            comment.draft_response = text;
                        }
                    }
                }
            } catch (err) {
                alert('Could not read clipboard. Please paste manually into the response box.');
            }
        }

        // API Base URL is defined at the top of this file

        // Context state
        let contextLoaded = false;
        let contextLoadedAt = null;
        let contextLoadedFiles = [];

        // Check if OpenCode already has context loaded (on page load)
        async function checkOpenCodeContextStatus() {
            try {
                const response = await fetch(`${API_BASE}/context-status`);
                if (response.ok) {
                    const status = await response.json();
                    console.log('OpenCode context status:', status);

                    if (status.contextLoaded) {
                        contextLoaded = true;
                        contextLoadedAt = status.loadedAt || new Date().toLocaleTimeString();
                        contextLoadedFiles = status.loadedFiles || [];

                        // If we don't have specific file names, show generic message
                        if (contextLoadedFiles.length === 0 && status.messageCount > 0) {
                            contextLoadedFiles = [`${status.messageCount} messages in session`];
                        }

                        updateContextStatusDisplay();
                        console.log('Context was already loaded in OpenCode session');
                        return true;
                    }
                }
            } catch (e) {
                console.log('Could not check OpenCode context status:', e.message);
            }

            // Keep contextLoaded = false (default)
            updateContextStatusDisplay();
            return false;
        }

        // Context files cache
        let contextFilesCache = null;

        // File type metadata
        const FILE_TYPE_META = {
            manuscript: { icon: 'fa-file-word', color: 'text-blue-500', label: 'Manuscript', checked: true },
            reviews: { icon: 'fa-comments', color: 'text-purple-500', label: 'Reviewer Comments', checked: true },
            damage_data: { icon: 'fa-dna', color: 'text-green-500', label: 'DNA Damage Data', checked: true },
            taxonomic_data: { icon: 'fa-bacteria', color: 'text-yellow-500', label: 'Taxonomic Data', checked: false },
            supplementary: { icon: 'fa-folder', color: 'text-orange-500', label: 'Supplementary Files', checked: false }
        };

        // Open context modal
        function openContextModal() {
            document.getElementById('context-modal').classList.remove('hidden');
            updateContextStatusDisplay();
            refreshContextFiles();
        }

        // Close context modal
        function closeContextModal() {
            document.getElementById('context-modal').classList.add('hidden');
        }

        // =====================================================
        // IMPORT REVIEWS WITH AI
        // =====================================================

        let importCurrentStep = 1;
        let extractedCommentsData = [];

        function openImportReviewsModal() {
            document.getElementById('import-reviews-modal').classList.remove('hidden');
            importCurrentStep = 1;
            updateImportStepUI();
        }

        function closeImportReviewsModal() {
            document.getElementById('import-reviews-modal').classList.add('hidden');
            importCurrentStep = 1;
            extractedCommentsData = [];
        }

        function updateImportStepUI() {
            // Update step indicators
            for (let i = 1; i <= 3; i++) {
                const stepEl = document.getElementById(`import-step-${i}`);
                const contentEl = document.getElementById(`import-step-content-${i}`);

                if (i < importCurrentStep) {
                    stepEl.classList.remove('opacity-50');
                    stepEl.querySelector('span:first-child').className = 'w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center text-sm font-bold';
                } else if (i === importCurrentStep) {
                    stepEl.classList.remove('opacity-50');
                    stepEl.querySelector('span:first-child').className = 'w-7 h-7 rounded-full bg-purple-600 text-white flex items-center justify-center text-sm font-bold';
                } else {
                    stepEl.classList.add('opacity-50');
                    stepEl.querySelector('span:first-child').className = 'w-7 h-7 rounded-full bg-gray-300 text-gray-600 flex items-center justify-center text-sm font-bold';
                }

                contentEl.classList.toggle('hidden', i !== importCurrentStep);
            }

            // Update buttons
            const prevBtn = document.getElementById('import-prev-btn');
            const nextBtn = document.getElementById('import-next-btn');

            prevBtn.classList.toggle('hidden', importCurrentStep === 1);

            if (importCurrentStep === 1) {
                nextBtn.innerHTML = '<i class="fas fa-magic mr-1"></i>Extract Comments';
            } else if (importCurrentStep === 2) {
                nextBtn.innerHTML = '<i class="fas fa-brain mr-1"></i>Generate Expert Analysis';
            } else {
                nextBtn.innerHTML = '<i class="fas fa-check mr-1"></i>Import to Rebuttr';
            }
        }

        function prevImportStep() {
            if (importCurrentStep > 1) {
                importCurrentStep--;
                updateImportStepUI();
            }
        }

        async function nextImportStep() {
            if (importCurrentStep === 1) {
                await extractReviewComments();
            } else if (importCurrentStep === 2) {
                await generateExpertAnalysisForImported();
            } else {
                await finalizeImport();
            }
        }

        async function extractReviewComments() {
            const rawText = document.getElementById('raw-reviews-input').value.trim();
            const reviewerId = document.getElementById('reviewer-id-input').value.trim() || 'R1';
            const reviewerName = document.getElementById('reviewer-name-input').value.trim() || 'Referee #1';

            if (!rawText) {
                showNotification('Please paste reviewer comments first', 'error');
                return;
            }

            // Show processing
            document.getElementById('import-processing').classList.remove('hidden');
            document.getElementById('import-processing-status').textContent = 'Extracting and categorizing comments with AI...';

            const extractionPrompt = `Extract ALL individual comments from this peer review with MAXIMUM GRANULARITY.

## CRITICAL: SPLIT INTO SEPARATE COMMENTS
- Every LINE NUMBER reference = separate comment
- Every FIGURE reference = separate comment
- Every DISTINCT POINT = separate comment
- A reviewer's single paragraph may contain 3-5+ separate actionable items

REVIEWER: ${reviewerName} (ID: ${reviewerId})

RAW TEXT:
"""
${rawText}
"""

TASK: Extract EVERY SINGLE distinct point. A detailed review typically has 15-40+ points. If extracting <10 from a thorough review, you're merging too much.

Return JSON:
{
  "reviewer": {
    "id": "${reviewerId}",
    "name": "${reviewerName}",
    "expertise": "Infer from comments",
    "overall_assessment": "Brief summary of stance"
  },
  "comments": [
    {
      "id": "${reviewerId}-1",
      "type": "major|minor",
      "category": "Category",
      "location": "Line X | Lines X-Y | Figure X | General",
      "priority": "high|medium|low",
      "original_text": "Exact text for THIS SPECIFIC point only",
      "full_context": "Additional context if any",
      "requires_new_analysis": true|false,
      "analysis_type": ["type1", "type2"]
    }
  ]
}

CATEGORIES: Authentication, Methods, Analysis, Interpretation, Terminology, Clarity, Figure, Formatting, Novelty, Citation, Validation, Results, Discussion, Focus, Database, Accuracy
PRIORITY: high (core claims), medium (important), low (minor)
TYPE: major (significant revision) or minor (quick fix)

EXAMPLE - If reviewer says "Line 100 citation wrong. Lines 102-103 unclear. Figure 3 needs scale bar."
CORRECT: 3 separate comments for Line 100, Lines 102-103, and Figure 3
WRONG: 1 merged comment about multiple issues

Number sequentially: ${reviewerId}-1, ${reviewerId}-2, etc.`;

            try {
                showOpenCodeLoading('extract-comments', 'Extracting comments from review text...');
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: extractionPrompt,
                        comment_id: 'extract-reviews',
                        model: aiSettings.model,
                        agent: aiSettings.agent,
                        variant: aiSettings.variant
                    })
                });

                if (!response.ok) {
                    hideOpenCodeLoading('extract-comments', { success: false, message: 'API request failed' });
                    throw new Error('API request failed');
                }

                const result = await response.json();

                // Parse JSON from response
                const jsonMatch = result.response.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    hideOpenCodeLoading('extract-comments', { success: false, message: 'No JSON in response' });
                    throw new Error('No JSON in response');
                }

                const extracted = JSON.parse(jsonMatch[0]);
                extractedCommentsData = extracted;

                // Show extracted comments
                renderExtractedComments(extracted);

                importCurrentStep = 2;
                updateImportStepUI();
                hideOpenCodeLoading('extract-comments', { success: true, message: `Extracted ${extracted.comments?.length || 0} comments` });

            } catch (e) {
                hideOpenCodeLoading('extract-comments', { success: false, message: e.message });
                showNotification('Error extracting comments: ' + e.message, 'error');
                console.error('Extraction error:', e);
            } finally {
                document.getElementById('import-processing').classList.add('hidden');
            }
        }

        // =====================================================
        // CLEAN START / RE-EXTRACT FUNCTIONS
        // =====================================================

        // =====================================================
        // GLOBAL PROGRESS OVERLAY
        // =====================================================

        let progressCancelled = false;

        function isProgressCancelled() {
            return progressCancelled;
        }

        function showProgress(title, options = {}) {
            const overlay = document.getElementById('progress-modal');
            const titleEl = document.getElementById('progress-modal-title');
            const stepEl = document.getElementById('progress-step');
            const detailEl = document.getElementById('progress-detail');
            const barEl = document.getElementById('progress-modal-bar');
            const percentEl = document.getElementById('progress-modal-status');
            const countEl = document.getElementById('progress-count');
            const logEl = document.getElementById('progress-modal-logs');
            const cancelContainer = document.getElementById('progress-cancel-container');

            if (titleEl) titleEl.innerHTML = `<i class="fas fa-cog fa-spin"></i> ${title}`;
            if (stepEl) stepEl.textContent = options.step || 'Initializing...';
            if (detailEl) detailEl.textContent = options.detail || '';
            if (barEl) barEl.style.width = '0%';
            if (percentEl) percentEl.textContent = '0%';
            if (countEl) countEl.textContent = '';
            if (logEl) logEl.innerHTML = '';
            progressCancelled = false;

            if (cancelContainer) {
                if (options.cancellable) {
                    cancelContainer.classList.remove('hidden');
                } else {
                    cancelContainer.classList.add('hidden');
                }
            }

            if (overlay) overlay.classList.remove('hidden');
        }

        function updateProgress(options) {
            const stepEl = document.getElementById('progress-step');
            const detailEl = document.getElementById('progress-detail');
            const barEl = document.getElementById('progress-modal-bar');
            const percentEl = document.getElementById('progress-modal-status');
            const countEl = document.getElementById('progress-count');

            if (options.step && stepEl) stepEl.textContent = options.step;
            if (options.detail && detailEl) detailEl.textContent = options.detail;

            if (options.percent !== undefined && barEl && percentEl) {
                barEl.style.width = `${options.percent}%`;
                percentEl.textContent = `${Math.round(options.percent)}%`;
            }

            if (options.current !== undefined && options.total !== undefined && barEl && percentEl && countEl) {
                const percent = (options.current / options.total) * 100;
                barEl.style.width = `${percent}%`;
                percentEl.textContent = `${Math.round(percent)}%`;
                countEl.textContent = `${options.current} / ${options.total}`;
            }
        }

        function addProgressLog(message, type = 'info') {
            const logEl = document.getElementById('progress-modal-logs');
            if (!logEl) return;

            const icons = {
                info: '<i class="fas fa-info-circle text-blue-500"></i>',
                success: '<i class="fas fa-check-circle text-green-500"></i>',
                error: '<i class="fas fa-times-circle text-red-500"></i>',
                warning: '<i class="fas fa-exclamation-circle text-yellow-500"></i>'
            };

            const entry = document.createElement('div');
            entry.className = 'flex items-start gap-2';
            entry.innerHTML = `${icons[type] || icons.info} <span class="text-gray-700">${message}</span>`;
            logEl.appendChild(entry);
            logEl.scrollTop = logEl.scrollHeight;
        }

        function hideProgress() {
            const modal = document.getElementById('progress-modal');
            if (modal) modal.classList.add('hidden');
            // Reset close button
            const closeBtn = document.getElementById('progress-close-btn');
            if (closeBtn) closeBtn.classList.add('hidden');
        }

        // =========================================
        // Minimizable Progress Widget System
        // =========================================
        let activeJobId = null;
        let activeJobPaperId = null;
        let progressPollInterval = null;
        let progressWidgetMinimized = false;

        function showProgressWidget(title = 'Processing...') {
            const widget = document.getElementById('progress-widget');
            widget.classList.remove('hidden');
            widget.classList.remove('minimized');
            document.getElementById('progress-widget-title').textContent = title;
            document.getElementById('progress-current-step').textContent = 'Initializing...';
            document.getElementById('progress-widget-percent').textContent = '0%';
            document.getElementById('progress-widget-bar').style.width = '0%';
            document.getElementById('progress-widget-log').innerHTML = '';
            document.getElementById('progress-fab-percent').textContent = '';
            progressWidgetMinimized = false;

            // Disable close button while processing
            document.getElementById('progress-close-widget-btn').classList.add('opacity-50', 'pointer-events-none');
        }

        function toggleProgressWidget() {
            const widget = document.getElementById('progress-widget');
            progressWidgetMinimized = !progressWidgetMinimized;

            if (progressWidgetMinimized) {
                widget.classList.add('minimized');
            } else {
                widget.classList.remove('minimized');
            }
        }

        function closeProgressWidget() {
            const widget = document.getElementById('progress-widget');
            widget.classList.add('hidden');

            // Stop polling
            if (progressPollInterval) {
                clearInterval(progressPollInterval);
                progressPollInterval = null;
            }

            // Clear stored job
            localStorage.removeItem('rebuttr_active_job');
            activeJobId = null;
            activeJobPaperId = null;
        }

        async function updateProgressWidget(data) {
            const stepEl = document.getElementById('progress-current-step');
            const percentEl = document.getElementById('progress-widget-percent');
            const barEl = document.getElementById('progress-widget-bar');
            const fabPercentEl = document.getElementById('progress-fab-percent');
            const logEl = document.getElementById('progress-widget-log');
            const closeBtn = document.getElementById('progress-close-widget-btn');
            const headerIcon = document.querySelector('#progress-widget .progress-panel-header i');

            // Update step
            const stepNames = {
                'pending': 'Waiting to start...',
                'saving_files': 'Saving uploaded files...',
                'processing_manuscript': 'Processing manuscript...',
                'processing_supplementary': 'Processing supplementary files...',
                'processing_reviews': 'Processing review documents...',
                'summarizing': 'Summarizing content...',
                'parsing_comments': 'Extracting reviewer comments...',
                'saving_to_db': 'Saving to database...',
                'completed': 'Complete!',
                'failed': 'Failed'
            };

            stepEl.textContent = stepNames[data.current_step] || data.current_step || 'Processing...';

            // Update progress bar
            const percent = data.progress || 0;
            percentEl.textContent = `${percent}%`;
            barEl.style.width = `${percent}%`;
            fabPercentEl.textContent = `${percent}%`;

            // Update log entries from server logs
            if (data.logs && Array.isArray(data.logs)) {
                const existingCount = logEl.children.length;
                const newLogs = data.logs.slice(existingCount);

                for (const log of newLogs) {
                    addProgressWidgetLog(log.message, log.type || 'info');
                }
            }

            // Handle completion or failure
            if (data.status === 'completed' || data.status === 'failed') {
                // Stop spinning icon
                if (headerIcon) {
                    headerIcon.classList.remove('fa-spin');
                    headerIcon.classList.remove('fa-cog');
                    if (data.status === 'completed') {
                        headerIcon.classList.add('fa-check-circle');
                    } else {
                        headerIcon.classList.add('fa-times-circle');
                    }
                }

                // Update FAB icon
                const fabIcon = document.querySelector('#progress-widget .progress-fab i');
                if (fabIcon) {
                    fabIcon.classList.remove('fa-spin', 'fa-sync-alt');
                    fabIcon.classList.add(data.status === 'completed' ? 'fa-check' : 'fa-exclamation-triangle');
                }

                // Enable close button
                closeBtn.classList.remove('opacity-50', 'pointer-events-none');

                // Stop polling
                if (progressPollInterval) {
                    clearInterval(progressPollInterval);
                    progressPollInterval = null;
                }

                // Clear stored job
                localStorage.removeItem('rebuttr_active_job');

                // Update title
                document.getElementById('progress-widget-title').textContent =
                    data.status === 'completed' ? 'Processing Complete' : 'Processing Failed';

                // Reload data if completed successfully
                if (data.status === 'completed' && activeJobPaperId) {
                    // Set current paper and save to localStorage
                    currentPaperId = activeJobPaperId;
                    localStorage.setItem('rebuttr_last_paper', activeJobPaperId);

                    // Load data (await to ensure proper sequencing)
                    await loadPapers();
                    await loadPaperData(activeJobPaperId);
                    refreshAllUI();
                    showNotification('Paper processed successfully!', 'success');
                } else if (data.status === 'failed') {
                    showNotification('Processing failed: ' + (data.error || 'Unknown error'), 'error');
                }
            }
        }

        function addProgressWidgetLog(message, type = 'info') {
            const logEl = document.getElementById('progress-widget-log');
            const icons = {
                info: 'fa-info-circle',
                success: 'fa-check-circle',
                error: 'fa-times-circle',
                warning: 'fa-exclamation-circle'
            };

            const entry = document.createElement('div');
            entry.className = `progress-log-entry ${type}`;
            entry.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${message}</span>`;
            logEl.appendChild(entry);
            logEl.scrollTop = logEl.scrollHeight;
        }

        function startProgressPolling(jobId, paperId) {
            activeJobId = jobId;
            activeJobPaperId = paperId;

            // Store in localStorage for recovery
            localStorage.setItem('rebuttr_active_job', JSON.stringify({
                jobId,
                paperId,
                startedAt: Date.now()
            }));

            // Start polling
            progressPollInterval = setInterval(async () => {
                try {
                    const response = await fetch(`${API_BASE}/papers/${paperId}/status`);
                    if (response.ok) {
                        const status = await response.json();
                        updateProgressWidget(status);
                    }
                } catch (e) {
                    console.error('Error polling progress:', e);
                }
            }, 1000); // Poll every second
        }

        async function recoverProgressOnLoad() {
            const stored = localStorage.getItem('rebuttr_active_job');
            if (!stored) return;

            try {
                const { jobId, paperId, startedAt } = JSON.parse(stored);

                // Check if job is still recent (within 30 minutes)
                if (Date.now() - startedAt > 30 * 60 * 1000) {
                    localStorage.removeItem('rebuttr_active_job');
                    return;
                }

                // Check current status
                const response = await fetch(`${API_BASE}/papers/${paperId}/status`);
                if (!response.ok) {
                    localStorage.removeItem('rebuttr_active_job');
                    return;
                }

                const status = await response.json();

                // If still processing, show widget and resume polling
                if (status.status === 'processing' || status.status === 'pending') {
                    showProgressWidget('Resuming Processing...');
                    updateProgressWidget(status);
                    startProgressPolling(jobId, paperId);
                } else if (status.status === 'completed' || status.status === 'failed') {
                    // Show completed/failed state briefly
                    showProgressWidget(status.status === 'completed' ? 'Processing Complete' : 'Processing Failed');
                    updateProgressWidget(status);
                }
            } catch (e) {
                console.error('Error recovering progress:', e);
                localStorage.removeItem('rebuttr_active_job');
            }
        }

        function openCleanStartModal() {
            document.getElementById('clean-start-modal').classList.remove('hidden');
            // Set up radio button listeners
            document.querySelectorAll('input[name="clean-option"]').forEach(radio => {
                radio.addEventListener('change', handleCleanOptionChange);
            });
            handleCleanOptionChange();
        }

        function closeCleanStartModal() {
            document.getElementById('clean-start-modal').classList.add('hidden');
        }

        function handleCleanOptionChange() {
            const selected = document.querySelector('input[name="clean-option"]:checked')?.value;
            const filesDiv = document.getElementById('clean-start-files');

            if (selected === 're-extract') {
                filesDiv.classList.remove('hidden');
                loadCleanStartFiles();
            } else {
                filesDiv.classList.add('hidden');
            }
        }

        async function loadCleanStartFiles() {
            const container = document.getElementById('clean-start-file-list');
            container.innerHTML = '<div class="text-sm text-gray-500 text-center"><i class="fas fa-spinner fa-spin mr-2"></i>Loading files...</div>';

            console.log('loadCleanStartFiles called, currentPaperId:', currentPaperId);

            try {
                // First try to get review files from the current paper
                let reviewFiles = [];

                if (currentPaperId) {
                    console.log('Fetching review files for paper:', currentPaperId);
                    const paperResponse = await fetch(`${API_BASE}/papers/${currentPaperId}/review-files`);
                    console.log('Response status:', paperResponse.status);
                    if (paperResponse.ok) {
                        const paperData = await paperResponse.json();
                        console.log('Paper data:', paperData);
                        reviewFiles = paperData.files || [];
                    }
                } else {
                    console.log('No currentPaperId set');
                }

                // Fallback to context-files if no paper-specific files
                if (reviewFiles.length === 0) {
                    const response = await fetch(`${API_BASE}/context-files`);
                    if (response.ok) {
                        const data = await response.json();
                        reviewFiles = data.files?.reviews?.files || [];
                    }
                }

                if (reviewFiles.length === 0) {
                    container.innerHTML = `
                        <div class="text-sm text-gray-500 text-center py-4">
                            <i class="fas fa-folder-open text-2xl text-gray-300 mb-2"></i>
                            <div>No review files found</div>
                            <div class="text-xs mt-1">Upload review files to the paper's reviews folder</div>
                        </div>`;
                    return;
                }

                container.innerHTML = reviewFiles.map(f => `
                    <label class="flex items-center gap-2 p-2 hover:bg-white rounded cursor-pointer">
                        <input type="checkbox" class="clean-start-file" value="${f.path}" checked>
                        <i class="fas fa-file-alt text-purple-400"></i>
                        <span class="text-sm flex-1 truncate">${f.name}</span>
                        <span class="text-xs text-gray-400">${f.sizeHuman}</span>
                    </label>
                `).join('');
            } catch (e) {
                console.error('Error loading clean start files:', e);
                container.innerHTML = '<div class="text-sm text-red-500 text-center">Error loading files: ' + e.message + '</div>';
            }
        }

        async function executeCleanStart() {
            const selected = document.querySelector('input[name="clean-option"]:checked')?.value;

            // IMPORTANT: Capture selected files BEFORE closing the modal
            const selectedFiles = Array.from(document.querySelectorAll('.clean-start-file:checked')).map(cb => cb.value);

            console.log('executeCleanStart called:', { selected, selectedFiles });

            // Validate selection
            if (!selected) {
                showNotification('Please select an option', 'error');
                return;
            }

            if (selected === 're-extract' && selectedFiles.length === 0) {
                showNotification('Please select at least one review file', 'error');
                return;
            }

            // Close the modal and show progress overlay
            closeCleanStartModal();

            const titles = {
                'clear-all': 'Clearing All Data',
                're-extract': 'Re-extracting Reviews',
                'clear-experts': 'Clearing Expert Analysis',
                'clear-responses': 'Clearing Draft Responses'
            };

            showProgress(titles[selected] || 'Processing...', {
                step: 'Starting...',
                cancellable: selected === 're-extract'
            });

            addProgressLog(`Selected operation: ${selected}`, 'info');
            if (selected === 're-extract') {
                addProgressLog(`Files to process: ${selectedFiles.length}`, 'info');
                selectedFiles.forEach(f => addProgressLog(`  • ${f.split('/').pop()}`, 'info'));
            }

            try {
                switch (selected) {
                    case 'clear-all':
                        // Count what we're clearing
                        const reviewerCount = reviewData.reviewers?.length || 0;
                        const commentCount = reviewData.reviewers?.reduce((sum, r) => sum + (r.comments?.length || 0), 0) || 0;
                        const expertCount = Object.keys(expertDiscussions?.expert_discussions || {}).length;

                        addProgressLog(`Current data: ${reviewerCount} reviewers, ${commentCount} comments, ${expertCount} expert analyses`, 'info');

                        updateProgress({ step: 'Clearing reviewers...', percent: 20 });
                        addProgressLog('Clearing reviewers and comments...', 'info');
                        await new Promise(r => setTimeout(r, 200));

                        updateProgress({ step: 'Clearing expert discussions...', percent: 40 });
                        addProgressLog('Clearing expert discussions...', 'info');
                        await new Promise(r => setTimeout(r, 200));

                        updateProgress({ step: 'Clearing local storage...', percent: 60 });
                        addProgressLog('Clearing local storage...', 'info');
                        await new Promise(r => setTimeout(r, 200));

                        updateProgress({ step: 'Syncing with server...', percent: 80 });
                        addProgressLog('Syncing with server...', 'info');
                        await clearAllData();

                        updateProgress({ step: 'Complete', percent: 100 });
                        addProgressLog(`Cleared: ${reviewerCount} reviewers, ${commentCount} comments, ${expertCount} expert analyses`, 'success');
                        break;

                    case 're-extract':
                        await reExtractFromFiles(selectedFiles);
                        break;

                    case 'clear-experts':
                        const expertCountBefore = Object.keys(expertDiscussions?.expert_discussions || {}).length;
                        addProgressLog(`Found ${expertCountBefore} expert analyses to clear`, 'info');

                        updateProgress({ step: 'Removing expert analysis...', percent: 50 });
                        await clearExpertAnalysis();

                        updateProgress({ step: 'Complete', percent: 100 });
                        addProgressLog(`Cleared ${expertCountBefore} expert analyses`, 'success');
                        break;

                    case 'clear-responses':
                        const responseCount = reviewData.reviewers?.reduce((sum, r) =>
                            sum + (r.comments?.filter(c => c.draft_response)?.length || 0), 0) || 0;
                        addProgressLog(`Found ${responseCount} draft responses to clear`, 'info');

                        updateProgress({ step: 'Resetting responses...', percent: 50 });
                        await clearDraftResponses();

                        updateProgress({ step: 'Complete', percent: 100 });
                        addProgressLog(`Cleared ${responseCount} draft responses`, 'success');
                        break;
                }

                // Show completion
                addProgressLog('', 'info');
                addProgressLog('Done!', 'success');
                showProgressCloseButton();
                updateSidebar();
                setView('overview');

            } catch (e) {
                console.error('executeCleanStart error:', e);
                addProgressLog(`Error: ${e.message}`, 'error');
                addProgressLog('Stack: ' + (e.stack || 'N/A').split('\n')[1], 'error');
                showProgressCloseButton();
            }
        }

        async function clearAllData() {
            // Clear from database first
            if (currentPaperId) {
                try {
                    const response = await fetch(`${API_BASE}/papers/${currentPaperId}/clear`, {
                        method: 'POST'
                    });
                    if (response.ok) {
                        const result = await response.json();
                        console.log('Database cleared:', result);
                    }
                } catch (e) {
                    console.error('Error clearing database:', e);
                }
            }

            // Clear in-memory data
            reviewData = {
                manuscript: reviewData.manuscript || { title: 'New Manuscript', authors: '', submission_date: '', review_date: '' },
                reviewers: []
            };
            expertDiscussions = { expert_discussions: {} };
            contextLoaded = false;
            contextLoadedFiles = [];

            // Clear localStorage
            localStorage.removeItem('expertDiscussions');
            localStorage.removeItem('reviewData');

            // Refresh all UI components
            refreshAllUI();
        }

        // Refresh all UI components after data changes
        function refreshAllUI() {
            updateContextStatusDisplay();
            updateSidebar();
            // Re-render current view if it's an overview/comments view
            const currentView = document.querySelector('.tab-active')?.dataset?.view || 'overview';
            if (typeof setView === 'function') {
                setView(currentView);
            }
        }

        // Extract ALL reviewers and their comments from a review document using AI
        async function extractAllReviewersFromDocument(content) {
            const extractionPrompt = `You are an expert scientific reviewer analyst extracting ACTIONABLE reviewer comments from a peer review document.

## DOCUMENT TO ANALYZE:
"""
${content}
"""

## YOUR GOAL:
Extract comments that REQUIRE A RESPONSE from the authors. Focus on quality over quantity.

## WHAT TO EXTRACT (ACTIONABLE ITEMS):
- Specific criticisms or concerns requiring response
- Requests for clarification or additional explanation
- Suggested analyses, experiments, or revisions
- Questions about methods, results, or interpretation
- Issues with figures, tables, or data presentation
- Requests for citations or references
- Technical corrections (typos, formatting) - group nearby ones together

## WHAT TO SKIP (NON-ACTIONABLE):
- Praise or positive summary statements ("well written", "interesting study")
- Descriptive summaries of what the paper does
- General background or context the reviewer provides
- Statements that are observations without requiring action

## GROUPING RULES:
- Merge a PROBLEM + its SUGGESTED SOLUTION into ONE comment
- Group multiple small formatting fixes for the same section together
- Group related line references if they're about the same issue
- Keep conceptually distinct concerns as separate comments
- NEVER create duplicate comments - if a point appears twice, extract it only once

## EXPECTED OUTPUT:
A thorough reviewer typically has 10-25 actionable comments.
- Referee #1 (detailed): expect 15-25 comments
- Referee #3 (moderate): expect 8-15 comments
- Referee #4 (moderate): expect 10-20 comments

## OUTPUT FORMAT (JSON):
Return ONLY valid JSON:
{
  "reviewers": [
    {
      "id": "R1",
      "name": "Referee #1",
      "expertise": "Inferred expertise from comments",
      "overall_assessment": "Critical/Supportive/Mixed - brief summary",
      "comments": [
        {
          "id": "R1-1",
          "type": "major",
          "category": "Authentication",
          "location": "General/Lines 50-60",
          "priority": "high",
          "original_text": "The full actionable comment text. If the reviewer states a problem AND suggests a solution, include both here as one comment.",
          "requires_new_analysis": true,
          "analysis_type": ["phylogenetics"]
        },
        {
          "id": "R1-2",
          "type": "minor",
          "category": "Formatting",
          "location": "Lines 37, 45, 52",
          "priority": "low",
          "original_text": "Several typos/formatting issues: Line 37 remove extra period; Line 45 fix capitalization; Line 52 missing reference.",
          "requires_new_analysis": false,
          "analysis_type": []
        }
      ]
    }
  ]
}

## CATEGORIES:
Authentication, Methods, Analysis, Interpretation, Terminology, Clarity, Figure, Formatting, Citation, Data, Discussion, Reproducibility

## TYPE:
- major: Requires significant revision, new analysis, or substantial rewriting
- minor: Quick fixes, clarifications, small edits

## PRIORITY:
- high: Fundamental concern that could block publication
- medium: Important issue requiring attention
- low: Minor improvement, nice to have

## CRITICAL RULES:
1. Only extract comments that REQUIRE AUTHOR ACTION
2. Merge problem + solution into single comment
3. NO DUPLICATES - each point extracted only once
4. Group nearby minor fixes together
5. Skip praise and non-actionable observations
6. Number comments sequentially: R1-1, R1-2... R3-1, R3-2...
7. Return ONLY valid JSON, no other text`;

            showOpenCodeLoading('extract-reviewers', 'Extracting reviewer comments...', { position: 'bottom-right' });

            const response = await fetch(`${API_BASE}/ask`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: extractionPrompt,
                    comment_id: 'extract-all-reviewers',
                    model: aiSettings.model,
                    agent: aiSettings.agent,
                    variant: aiSettings.variant
                })
            });

            if (!response.ok) {
                hideOpenCodeLoading('extract-reviewers', { success: false, message: 'API request failed' });
                throw new Error('API request failed: ' + response.statusText);
            }

            const result = await response.json();

            if (!result.success || !result.response) {
                hideOpenCodeLoading('extract-reviewers', { success: false, message: 'Invalid API response' });
                throw new Error('Invalid API response');
            }

            // Extract JSON from response
            const jsonMatch = result.response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error('No JSON found in response:', result.response.substring(0, 500));
                hideOpenCodeLoading('extract-reviewers', { success: false, message: 'No JSON in response' });
                throw new Error('No JSON found in AI response');
            }

            const extracted = JSON.parse(jsonMatch[0]);

            if (!extracted.reviewers || !Array.isArray(extracted.reviewers)) {
                hideOpenCodeLoading('extract-reviewers', { success: false, message: 'Invalid response format' });
                throw new Error('Invalid response format - missing reviewers array');
            }

            hideOpenCodeLoading('extract-reviewers', { success: true, message: `Extracted ${extracted.reviewers.length} reviewer(s)` });
            return extracted.reviewers;
        }

        async function reExtractFromFiles(selectedFiles) {
            if (!selectedFiles || selectedFiles.length === 0) {
                throw new Error('No files selected');
            }

            const totalFiles = selectedFiles.length;
            let processedFiles = 0;

            addProgressLog(`Found ${totalFiles} review file(s) to process`, 'info');

            // Clear existing data first
            updateProgress({ step: 'Clearing existing data...', detail: 'Preparing for fresh extraction' });
            addProgressLog('Clearing existing data...', 'info');
            await clearAllData();
            addProgressLog('Data cleared', 'success');

            // Read each file and extract
            for (const filePath of selectedFiles) {
                if (isProgressCancelled()) {
                    addProgressLog('Cancelled by user', 'warning');
                    break;
                }

                const filename = filePath.split('/').pop();
                const fileExt = filename.split('.').pop().toLowerCase();
                processedFiles++;

                addProgressLog('', 'info'); // Empty line for readability
                addProgressLog(`═══ File ${processedFiles}/${totalFiles}: ${filename} ═══`, 'info');

                updateProgress({
                    step: `Reading file ${processedFiles}/${totalFiles}`,
                    detail: filename,
                    current: processedFiles - 0.7,
                    total: totalFiles
                });

                try {
                    // Read file content via server
                    addProgressLog(`Reading ${fileExt.toUpperCase()} file...`, 'info');
                    const response = await fetch(`${API_BASE}/read-file`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: filePath })
                    });

                    if (!response.ok) {
                        addProgressLog(`Failed to read file: ${response.statusText}`, 'error');
                        continue;
                    }

                    const { content } = await response.json();
                    const fileSizeKB = (content.length / 1024).toFixed(1);
                    addProgressLog(`File loaded: ${fileSizeKB} KB of text content`, 'success');

                    // Send entire document to AI for extraction
                    updateProgress({
                        step: `AI Extraction: ${filename}`,
                        detail: 'Sending to AI for comprehensive extraction...',
                        current: processedFiles - 0.5,
                        total: totalFiles
                    });

                    addProgressLog('Sending document to AI for extraction...', 'info');
                    addProgressLog('AI will extract ACTIONABLE comments only (skipping praise/summaries)', 'info');
                    addProgressLog('(This may take 1-2 minutes for large documents)', 'info');

                    try {
                        const extractedReviewers = await extractAllReviewersFromDocument(content);

                        addProgressLog(`✓ AI identified ${extractedReviewers.length} reviewer(s)`, 'success');

                        // Add each reviewer to reviewData
                        for (const reviewer of extractedReviewers) {
                            const commentCount = reviewer.comments?.length || 0;
                            const majorCount = reviewer.comments?.filter(c => c.type === 'major').length || 0;

                            addProgressLog(`  • ${reviewer.name}: ${commentCount} comments (${majorCount} major)`, 'info');

                            // Add default fields to comments
                            reviewer.comments = (reviewer.comments || []).map(c => ({
                                ...c,
                                status: 'pending',
                                draft_response: '',
                                actions_taken: []
                            }));

                            // Check if reviewer already exists
                            const existingIndex = reviewData.reviewers.findIndex(r => r.id === reviewer.id);
                            if (existingIndex >= 0) {
                                reviewData.reviewers[existingIndex] = reviewer;
                            } else {
                                reviewData.reviewers.push(reviewer);
                            }
                        }

                    } catch (extractErr) {
                        addProgressLog(`✗ Extraction error: ${extractErr.message}`, 'error');
                        console.error('Extraction error:', extractErr);
                    }

                    updateProgress({
                        step: `Completed: ${filename}`,
                        current: processedFiles,
                        total: totalFiles
                    });

                } catch (e) {
                    console.error('Error processing file:', filePath, e);
                    addProgressLog(`Error: ${e.message}`, 'error');
                }
            }

            // Save final data
            updateProgress({ step: 'Finalizing...', detail: 'Writing to database', percent: 95 });
            addProgressLog('Saving extracted data to database...', 'info');
            await saveProgress();
            addProgressLog('Data saved successfully', 'success');
            updateProgress({ percent: 100 });

            // Detailed Summary
            const totalComments = reviewData.reviewers.reduce((sum, r) => sum + (r.comments?.length || 0), 0);
            const totalMajor = reviewData.reviewers.reduce((sum, r) => sum + (r.comments?.filter(c => c.type === 'major').length || 0), 0);
            const totalMinor = totalComments - totalMajor;
            const highPriority = reviewData.reviewers.reduce((sum, r) => sum + (r.comments?.filter(c => c.priority === 'high').length || 0), 0);

            addProgressLog('─'.repeat(40), 'info');
            addProgressLog('EXTRACTION COMPLETE', 'success');
            addProgressLog(`Total reviewers: ${reviewData.reviewers.length}`, 'info');
            addProgressLog(`Total comments: ${totalComments}`, 'info');
            addProgressLog(`  • Major: ${totalMajor}`, 'info');
            addProgressLog(`  • Minor: ${totalMinor}`, 'info');
            addProgressLog(`  • High priority: ${highPriority}`, 'info');
            addProgressLog('─'.repeat(40), 'info');

            // Per-reviewer summary
            reviewData.reviewers.forEach(r => {
                const major = r.comments?.filter(c => c.type === 'major').length || 0;
                const minor = (r.comments?.length || 0) - major;
                addProgressLog(`${r.name}: ${r.comments?.length || 0} comments (${major} major, ${minor} minor)`, 'info');
            });
        }

        async function extractReviewsWithScientistSkill(content, reviewerId, reviewerName) {
            const scientistPrompt = `You are an expert scientific reviewer analyst tasked with extracting ALL individual comments from peer review text with MAXIMUM GRANULARITY.

## CRITICAL EXTRACTION RULES - READ CAREFULLY

1. **ONE POINT = ONE COMMENT**: If a reviewer mentions multiple issues in one paragraph or sentence, SPLIT them into separate comments.

2. **LINE REFERENCES ARE SEPARATORS**: Every specific line number, line range, or figure reference becomes its OWN comment.
   - "Line 100: X. Line 105: Y" → TWO separate comments
   - "Lines 100-110 need work and Figure 3 is unclear" → TWO separate comments
   - A paragraph mentioning Lines 54-57, Lines 140-154, and Figure 3 → THREE separate comments minimum

3. **NUMBERED REVIEWER ITEMS OFTEN CONTAIN MULTIPLES**: A single numbered point (like "1." or "a)") from the reviewer may contain 3-5+ distinct actionable items. Extract EACH as its own comment.

4. **MINOR POINTS ARE STILL SEPARATE**: Typos, citation fixes, clarification requests - each is its own comment.

5. **QUESTIONS ARE COMMENTS**: Each question the reviewer asks is a separate actionable comment.

## EXPECTED OUTPUT VOLUME
A thorough reviewer typically raises 15-40+ individual points. If you extract fewer than 10 comments from a detailed review, you are almost certainly merging things that should be separate. When in doubt, SPLIT.

## REVIEWER: ${reviewerName} (ID: ${reviewerId})

## REVIEW TEXT:
"""
${content}
"""

## OUTPUT FORMAT
Return a JSON object:
{
  "reviewer": {
    "id": "${reviewerId}",
    "name": "${reviewerName}",
    "expertise": "Infer from their comments",
    "overall_assessment": "Supportive/Critical/Mixed",
    "key_concerns": ["Top concern 1", "Top concern 2"]
  },
  "comments": [
    {
      "id": "${reviewerId}-1",
      "type": "major|minor",
      "category": "Category from list below",
      "location": "Line X | Lines X-Y | Figure X | Table X | General | Methods | Discussion",
      "priority": "high|medium|low",
      "original_text": "The EXACT text for THIS SPECIFIC point only - not the whole paragraph",
      "full_context": "Surrounding context if helpful",
      "requires_new_analysis": true|false,
      "analysis_type": ["phylogenetics", "statistics", etc.]
    }
  ]
}

## CATEGORIES
- Authentication (DNA damage, age verification, contamination concerns)
- Methods (protocols, parameters, pipelines, software)
- Analysis (statistics, data analysis approaches)
- Interpretation (conclusions, claims, how results are interpreted)
- Terminology (word choices, definitions, jargon)
- Clarity (unclear writing, confusing explanations)
- Figure (figures, tables, visualizations, legends)
- Formatting (typos, formatting, minor edits)
- Novelty (significance, what's new)
- Citation (references, missing citations, incorrect citations)
- Validation (additional validation requests)
- Results (specific findings questions)
- Discussion (discussion section concerns)
- Focus (scope, manuscript direction)
- Database (database choices, reference selection)
- Accuracy (factual corrections, dates, names)

## PRIORITY
- high: Core claims challenged, could block publication
- medium: Important, significantly improves paper
- low: Nice to have, minor improvements

## TYPE
- major: Requires significant revision, new analysis, major rewriting
- minor: Quick fixes, clarifications, small additions

## EXAMPLE OF CORRECT GRANULAR EXTRACTION

If reviewer writes: "The methods need work. Line 100 citation is wrong. Lines 102-103 threshold unclear. Figure 3 needs scale bar."

CORRECT extraction (4 comments):
- ${reviewerId}-1: "Line 100 citation is wrong" (Citation, low, Line 100)
- ${reviewerId}-2: "Lines 102-103 threshold unclear" (Clarity, medium, Lines 102-103)
- ${reviewerId}-3: "Figure 3 needs scale bar" (Figure, low, Figure 3)
- ${reviewerId}-4: "The methods need work" (Methods, medium, General) - only if this is a separate overarching concern

WRONG extraction (1 comment):
- ${reviewerId}-1: "The methods need work including citation issues, unclear thresholds, and figure problems"

## FINAL CHECK
Before responding, verify you have:
✓ Split every line reference into its own comment
✓ Split every figure/table mention into its own comment
✓ Split multi-part paragraphs appropriately
✓ Captured all questions as separate comments
✓ Included all minor points (typos, formatting)
✓ Numbered sequentially: ${reviewerId}-1, ${reviewerId}-2, etc.`;

            showOpenCodeLoading(`extract-${reviewerId}`, `Extracting comments from ${reviewerName}...`);
            const response = await fetch(`${API_BASE}/ask`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: scientistPrompt,
                    comment_id: `extract-${reviewerId}`,
                    model: aiSettings.model,
                    agent: aiSettings.agent,
                    variant: aiSettings.variant
                })
            });

            if (!response.ok) {
                hideOpenCodeLoading(`extract-${reviewerId}`, { success: false, message: 'API request failed' });
                throw new Error('API request failed');
            }

            const result = await response.json();
            const jsonMatch = result.response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                hideOpenCodeLoading(`extract-${reviewerId}`, { success: false, message: 'No JSON in response' });
                throw new Error('No JSON in response');
            }

            const extracted = JSON.parse(jsonMatch[0]);
            hideOpenCodeLoading(`extract-${reviewerId}`, { success: true, message: `Extracted ${extracted.comments?.length || 0} comments` });

            // Add to reviewData
            const reviewer = {
                id: extracted.reviewer?.id || reviewerId,
                name: extracted.reviewer?.name || reviewerName,
                expertise: extracted.reviewer?.expertise || 'Unknown',
                overall_assessment: extracted.reviewer?.overall_assessment || '',
                comments: (extracted.comments || []).map(c => ({
                    ...c,
                    status: 'pending',
                    draft_response: '',
                    actions_taken: []
                }))
            };

            // Check if reviewer already exists
            const existingIndex = reviewData.reviewers.findIndex(r => r.id === reviewer.id);
            if (existingIndex >= 0) {
                reviewData.reviewers[existingIndex] = reviewer;
            } else {
                reviewData.reviewers.push(reviewer);
            }
        }

        async function clearExpertAnalysis() {
            expertDiscussions = { expert_discussions: {} };
            localStorage.removeItem('expertDiscussions');
            await saveExpertDiscussions();
        }

        async function clearDraftResponses() {
            for (const reviewer of reviewData.reviewers) {
                for (const comment of reviewer.comments) {
                    comment.draft_response = '';
                    comment.status = 'pending';
                    comment.actions_taken = [];
                }
            }
            await saveProgress();
        }

        function renderExtractedComments(data) {
            const container = document.getElementById('extracted-comments-list');
            const comments = data.comments || [];

            document.getElementById('extracted-count').textContent = `${comments.length} comments found`;

            if (comments.length === 0) {
                container.innerHTML = '<div class="text-center text-gray-500 py-4">No comments extracted</div>';
                return;
            }

            container.innerHTML = comments.map(c => `
                <div class="bg-white border rounded p-3 text-sm">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">${c.id}</span>
                        <span class="px-2 py-0.5 rounded text-xs ${c.type === 'major' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}">${c.type}</span>
                        <span class="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700">${c.category}</span>
                        <span class="px-2 py-0.5 rounded text-xs ${c.priority === 'high' ? 'bg-red-50 text-red-600' : c.priority === 'medium' ? 'bg-yellow-50 text-yellow-600' : 'bg-green-50 text-green-600'}">${c.priority}</span>
                        ${c.location && c.location !== 'General' ? `<span class="text-xs text-gray-400">${c.location}</span>` : ''}
                    </div>
                    <p class="text-gray-700 text-xs line-clamp-3">${c.original_text}</p>
                </div>
            `).join('');
        }

        async function generateExpertAnalysisForImported() {
            if (!extractedCommentsData || !extractedCommentsData.comments?.length) {
                showNotification('No comments to analyze', 'error');
                return;
            }

            const comments = extractedCommentsData.comments;
            const progressEl = document.getElementById('expert-generation-progress');
            const progressBar = document.getElementById('expert-progress-bar');
            const progressText = document.getElementById('expert-progress-text');

            importCurrentStep = 3;
            updateImportStepUI();

            progressEl.classList.remove('hidden');
            document.getElementById('import-processing').classList.remove('hidden');

            // Initialize expert discussions if needed
            if (!expertDiscussions) {
                expertDiscussions = { expert_discussions: {} };
            }

            let completed = 0;
            const total = comments.length;

            for (const comment of comments) {
                progressBar.style.width = `${(completed / total) * 100}%`;
                progressText.textContent = `Processing ${comment.id} (${completed + 1}/${total})...`;
                document.getElementById('import-processing-status').textContent = `Analyzing ${comment.id} with expert panel...`;

                try {
                    await regenerateExpertForCommentSilent(comment);
                    completed++;
                } catch (e) {
                    console.error(`Failed to generate expert analysis for ${comment.id}:`, e);
                }

                // Small delay between requests
                await new Promise(r => setTimeout(r, 500));
            }

            progressBar.style.width = '100%';
            progressText.textContent = `Complete! ${completed}/${total} analyzed`;
            document.getElementById('import-processing').classList.add('hidden');

            showNotification(`Generated expert analysis for ${completed} comments`, 'success');
        }

        async function finalizeImport() {
            if (!extractedCommentsData || !extractedCommentsData.comments?.length) {
                showNotification('No data to import', 'error');
                return;
            }

            // Add reviewer to reviewData
            const reviewer = {
                id: extractedCommentsData.reviewer?.id || 'R1',
                name: extractedCommentsData.reviewer?.name || 'Referee #1',
                expertise: extractedCommentsData.reviewer?.expertise || 'Unknown',
                overall_assessment: extractedCommentsData.reviewer?.overall_assessment || '',
                comments: extractedCommentsData.comments.map(c => ({
                    ...c,
                    status: 'pending',
                    draft_response: '',
                    actions_taken: []
                }))
            };

            // Check if reviewer already exists
            const existingIndex = reviewData.reviewers.findIndex(r => r.id === reviewer.id);
            if (existingIndex >= 0) {
                if (confirm(`Reviewer ${reviewer.id} already exists. Replace?`)) {
                    reviewData.reviewers[existingIndex] = reviewer;
                } else {
                    // Append with new ID
                    const newId = `R${reviewData.reviewers.length + 1}`;
                    reviewer.id = newId;
                    reviewer.comments.forEach((c, i) => c.id = `${newId}-${i + 1}`);
                    reviewData.reviewers.push(reviewer);
                }
            } else {
                reviewData.reviewers.push(reviewer);
            }

            // Save to database
            await saveProgress();
            await saveExpertDiscussions();

            // Update UI
            updateSidebar();
            setView('overview');

            closeImportReviewsModal();
            showNotification(`Imported ${reviewer.comments.length} comments from ${reviewer.name}`, 'success');
        }

        // Refresh context files from server
        async function refreshContextFiles() {
            const container = document.getElementById('context-files-checkboxes');
            container.innerHTML = `
                <div class="text-sm text-gray-500 p-4 text-center">
                    <i class="fas fa-spinner fa-spin mr-2"></i>Loading available files...
                </div>
            `;

            try {
                // Use paper-specific endpoint if we have a current paper
                const endpoint = currentPaperId
                    ? `${API_BASE}/papers/${currentPaperId}/context-files`
                    : `${API_BASE}/context-files`;
                const response = await fetch(endpoint);
                if (!response.ok) throw new Error('Failed to fetch files');

                const data = await response.json();
                contextFilesCache = data.files;
                renderContextFiles(data.files);
            } catch (e) {
                console.error('Error fetching context files:', e);
                container.innerHTML = `
                    <div class="text-sm text-red-500 p-4 text-center">
                        <i class="fas fa-exclamation-triangle mr-2"></i>
                        Could not load file list. Server may be offline.
                        <button onclick="refreshContextFiles()" class="block mx-auto mt-2 text-blue-600 hover:underline">
                            Try Again
                        </button>
                    </div>
                `;
            }
        }

        // Render context files checkboxes - compact collapsible design
        function renderContextFiles(files) {
            const container = document.getElementById('context-files-checkboxes');
            let html = '';

            for (const [fileType, meta] of Object.entries(FILE_TYPE_META)) {
                const fileInfo = files[fileType];
                const available = fileInfo && fileInfo.available;
                const fileList = fileInfo?.files || [];
                const isExpanded = fileType === 'manuscript' || fileType === 'reviews' || fileType === 'supplementary'; // Auto-expand these

                // Category header - collapsible
                html += `
                    <div class="border rounded-lg overflow-hidden mb-2 ${available ? '' : 'opacity-50'}">
                        <div class="flex items-center justify-between p-2 bg-gray-50 cursor-pointer hover:bg-gray-100"
                             onclick="toggleCategoryExpand('${fileType}')">
                            <div class="flex items-center gap-2">
                                <i class="fas fa-chevron-right text-gray-400 text-xs transition-transform category-chevron-${fileType} ${isExpanded ? 'rotate-90' : ''}"></i>
                                <i class="fas ${meta.icon} ${meta.color} text-sm"></i>
                                <span class="text-sm font-medium text-gray-700">${meta.label}</span>
                                <span class="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">${fileList.length}</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <span class="text-xs text-gray-400 category-selected-${fileType}">0 selected</span>
                                ${available && fileList.length > 0 ? `
                                    <button type="button" onclick="event.stopPropagation(); toggleCategoryFiles('${fileType}')"
                                            class="text-xs text-blue-600 hover:text-blue-800 px-2 py-0.5 rounded hover:bg-blue-50">
                                        Toggle
                                    </button>
                                ` : ''}
                            </div>
                        </div>
                `;

                if (available && fileList.length > 0) {
                    html += `<div class="category-content-${fileType} ${isExpanded ? '' : 'hidden'} border-t">`;
                    html += `<div class="grid grid-cols-1 sm:grid-cols-2 gap-1 p-2 max-h-48 overflow-y-auto bg-white">`;
                    for (const file of fileList) {
                        // Default: check important files
                        const shouldCheck = meta.checked ||
                            file.name.includes('reviewer_comments') ||
                            file.name.includes('revised-tracked') ||
                            file.name.includes('expert_discussions');
                        const checkedAttr = shouldCheck ? 'checked' : '';

                        // File icon based on extension
                        const ext = file.name.split('.').pop().toLowerCase();
                        let fileIcon = 'fa-file';
                        let iconColor = 'text-gray-400';
                        if (ext === 'docx' || ext === 'doc') { fileIcon = 'fa-file-word'; iconColor = 'text-blue-400'; }
                        else if (ext === 'pdf') { fileIcon = 'fa-file-pdf'; iconColor = 'text-red-400'; }
                        else if (ext === 'json') { fileIcon = 'fa-file-code'; iconColor = 'text-green-400'; }
                        else if (ext === 'xlsx' || ext === 'xls') { fileIcon = 'fa-file-excel'; iconColor = 'text-green-500'; }
                        else if (ext === 'tsv' || ext === 'csv') { fileIcon = 'fa-file-csv'; iconColor = 'text-green-400'; }
                        else if (ext === 'md') { fileIcon = 'fa-file-alt'; iconColor = 'text-gray-500'; }
                        else if (ext === 'png' || ext === 'jpg') { fileIcon = 'fa-file-image'; iconColor = 'text-purple-400'; }

                        // Truncate long filenames
                        const shortName = file.name.length > 28 ? file.name.substring(0, 25) + '...' : file.name;

                        html += `
                            <label class="flex items-center gap-1.5 p-1.5 rounded border hover:bg-blue-50 cursor-pointer text-xs">
                                <input type="checkbox" class="context-file-checkbox flex-shrink-0"
                                    data-category="${fileType}"
                                    data-size="${file.size}"
                                    value="${file.path}"
                                    ${checkedAttr}>
                                <i class="fas ${fileIcon} ${iconColor} flex-shrink-0"></i>
                                <span class="truncate flex-1" title="${file.name}">${shortName}</span>
                                <span class="text-gray-400 flex-shrink-0">${file.sizeHuman}</span>
                            </label>
                        `;
                    }
                    html += `</div></div>`;
                }

                html += `</div>`;
            }

            container.innerHTML = html;

            // Add event listeners to update selected info
            container.querySelectorAll('.context-file-checkbox').forEach(cb => {
                cb.addEventListener('change', updateSelectedFilesInfo);
            });
            updateSelectedFilesInfo();
        }

        // Toggle all files in a category
        function toggleCategoryFiles(category) {
            const checkboxes = document.querySelectorAll(`.context-file-checkbox[data-category="${category}"]`);
            const allChecked = Array.from(checkboxes).every(cb => cb.checked);
            checkboxes.forEach(cb => cb.checked = !allChecked);
            updateSelectedFilesInfo();
        }

        // Update selected files count and size
        function updateSelectedFilesInfo() {
            const allCheckboxes = document.querySelectorAll('.context-file-checkbox');
            const checkedCheckboxes = document.querySelectorAll('.context-file-checkbox:checked');
            let totalSize = 0;
            let fileCount = checkedCheckboxes.length;

            // Count per category
            const categoryCounts = {};

            checkedCheckboxes.forEach(cb => {
                const category = cb.dataset.category;
                const size = parseInt(cb.dataset.size) || 0;
                totalSize += size;

                categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            });

            // Update main info display
            const infoEl = document.getElementById('selected-files-info');
            if (infoEl) {
                const sizeStr = formatBytesJS(totalSize);
                infoEl.textContent = `${fileCount} file${fileCount !== 1 ? 's' : ''} (${sizeStr})`;

                // Warn if size is very large
                if (totalSize > 50 * 1024 * 1024) {
                    infoEl.className = 'text-sm text-orange-600 font-medium';
                } else {
                    infoEl.className = 'text-sm text-gray-700 font-medium';
                }
            }

            // Update per-category counts
            for (const category of Object.keys(FILE_TYPE_META)) {
                const countEl = document.querySelector(`.category-selected-${category}`);
                if (countEl) {
                    const count = categoryCounts[category] || 0;
                    countEl.textContent = `${count} selected`;
                    countEl.className = count > 0
                        ? `text-xs text-blue-600 category-selected-${category}`
                        : `text-xs text-gray-400 category-selected-${category}`;
                }
            }
        }

        // Format bytes in JS
        function formatBytesJS(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        }

        // Toggle category expand/collapse
        function toggleCategoryExpand(category) {
            const content = document.querySelector(`.category-content-${category}`);
            const chevron = document.querySelector(`.category-chevron-${category}`);
            if (content) {
                content.classList.toggle('hidden');
                if (chevron) {
                    chevron.classList.toggle('rotate-90');
                }
            }
        }

        // Select all files
        function selectAllFiles() {
            document.querySelectorAll('.context-file-checkbox').forEach(cb => cb.checked = true);
            updateSelectedFilesInfo();
        }

        // Select no files
        function selectNoneFiles() {
            document.querySelectorAll('.context-file-checkbox').forEach(cb => cb.checked = false);
            updateSelectedFilesInfo();
        }

        // Select a specific category
        function selectCategory(category) {
            // First uncheck all
            document.querySelectorAll('.context-file-checkbox').forEach(cb => cb.checked = false);
            // Then check only the specified category
            document.querySelectorAll(`.context-file-checkbox[data-category="${category}"]`).forEach(cb => cb.checked = true);
            // Expand that category
            const content = document.querySelector(`.category-content-${category}`);
            const chevron = document.querySelector(`.category-chevron-${category}`);
            if (content && content.classList.contains('hidden')) {
                content.classList.remove('hidden');
                if (chevron) chevron.classList.add('rotate-90');
            }
            updateSelectedFilesInfo();
        }

        // Update context status displays
        function updateContextStatusDisplay() {
            const badge = document.getElementById('context-status-badge');
            const text = document.getElementById('context-status-text');
            const detailStatus = document.getElementById('context-detail-status');
            const indicator = document.getElementById('context-status-indicator');
            const container = document.getElementById('ai-knowledge-container');
            const icon = document.getElementById('ai-knowledge-icon');
            const btnText = document.getElementById('context-btn-text');

            if (contextLoaded) {
                const fileCountText = contextLoadedFiles.length > 0
                    ? `${contextLoadedFiles.length} files`
                    : '';
                if (badge) {
                    badge.textContent = fileCountText || 'Loaded';
                    badge.className = 'text-xs bg-white bg-opacity-30 px-2 py-0.5 rounded font-semibold';
                }
                if (text) text.textContent = `Loaded at ${contextLoadedAt}`;
                if (detailStatus) {
                    const fileList = contextLoadedFiles.slice(0, 3).join(', ');
                    const more = contextLoadedFiles.length > 3 ? ` +${contextLoadedFiles.length - 3} more` : '';
                    detailStatus.textContent = `${fileList}${more}`;
                    detailStatus.title = contextLoadedFiles.join('\n');
                }
                if (indicator) indicator.className = 'w-2 h-2 rounded-full bg-green-500';
                // Update container to loaded state (green, no pulse)
                if (container) container.className = 'ai-knowledge-loaded rounded-lg p-3 text-white';
                if (icon) icon.className = 'fas fa-check-circle';
                if (btnText) btnText.textContent = 'Update Context';
            } else {
                if (badge) {
                    badge.textContent = 'Not Loaded';
                    badge.className = 'text-xs bg-white bg-opacity-30 px-2 py-0.5 rounded font-semibold';
                }
                if (text) text.textContent = 'Load manuscript & reviews for better AI responses';
                if (detailStatus) detailStatus.textContent = 'No context loaded';
                if (indicator) indicator.className = 'w-2 h-2 rounded-full bg-gray-400';
                // Update container to not-loaded state (amber, pulsing)
                if (container) container.className = 'ai-knowledge-not-loaded rounded-lg p-3 text-white';
                if (icon) icon.className = 'fas fa-exclamation-triangle ai-knowledge-warning-icon';
                if (btnText) btnText.textContent = 'Load Context';
            }

            // Also update chat window context badge
            updateChatContextBadge();
        }

        // Build context-aware prompt for each file type
        function buildFileContextPrompt(fileName, filePath) {
            const lowerName = fileName.toLowerCase();
            const lowerPath = filePath.toLowerCase();

            // Base context about the project (generic)
            const projectContext = `This is a manuscript review project. We are responding to reviewer comments.`;

            let fileContext = '';
            let instructions = '';

            // Manuscript files
            if (lowerName.includes('manuscript') || lowerName.includes('paper') || lowerName.includes('submission')) {
                if (lowerName.includes('tracked')) {
                    fileContext = `This is the REVISED MANUSCRIPT with tracked changes showing our edits in response to reviewer comments.`;
                    instructions = `Understand the structure, main findings, and specifically note WHERE changes have been made.`;
                } else if (lowerName.includes('revised')) {
                    fileContext = `This is the CLEAN REVISED MANUSCRIPT (without track changes).`;
                    instructions = `Understand the overall argument, methodology, and conclusions. Note the paper's structure for referencing specific sections when drafting responses.`;
                } else {
                    fileContext = `This is the ORIGINAL SUBMISSION manuscript before revisions.`;
                    instructions = `Note the original text so you can understand what reviewers were commenting on and what has been changed.`;
                }
            }
            // Review files
            else if (lowerName.includes('review') || lowerName.includes('comment') || lowerPath.includes('reviewer')) {
                fileContext = `This contains REVIEWER COMMENTS that we need to respond to.`;
                instructions = `Understand each reviewer's concerns, their expertise area, and the tone of their comments. Identify key themes and recurring issues.`;
            }
            // Data files
            else if (lowerName.includes('data') || lowerName.includes('results')) {
                fileContext = `This is DATA or RESULTS supporting the manuscript.`;
                instructions = `Understand the key statistics and findings that can be referenced when responding to reviewer concerns.`;
            }
            // Expert discussions
            else if (lowerName.includes('expert') || lowerName.includes('discussion')) {
                fileContext = `This contains EXPERT DISCUSSIONS providing specialized knowledge for responding to technical reviewer concerns.`;
                instructions = `Use this information when drafting responses that require deep domain expertise.`;
            }
            // Supplementary files
            else if (lowerPath.includes('supplement') || lowerPath.includes('si_') || lowerPath.includes('figure') || lowerPath.includes('table')) {
                if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.csv')) {
                    fileContext = `This is a SUPPLEMENTARY DATA TABLE containing detailed analytical results.`;
                    instructions = `Note column headers and data types. This may be referenced when reviewers ask for specific numbers or statistics.`;
                } else if (lowerName.endsWith('.pdf') || lowerName.endsWith('.png') || lowerName.endsWith('.jpg')) {
                    fileContext = `This is a SUPPLEMENTARY FIGURE showing visual data supporting the manuscript.`;
                    instructions = `Understand what this figure illustrates so you can reference it when responding to relevant reviewer comments.`;
                } else {
                    fileContext = `This is SUPPLEMENTARY MATERIAL supporting the main manuscript findings.`;
                    instructions = `Note the key information that could help address reviewer concerns.`;
                }
            }
            // JSON data files
            else if (lowerName.endsWith('.json')) {
                fileContext = `This is a JSON DATA FILE containing structured information for the review platform.`;
                instructions = `Understand the data structure and key fields for use in generating reviewer responses.`;
            }
            // Default for other files
            else {
                fileContext = `This is a supporting file for the manuscript review project.`;
                instructions = `Note any relevant information that could help address reviewer concerns.`;
            }

            return `${projectContext}

FILE: @${filePath}
CONTEXT: ${fileContext}

INSTRUCTIONS: ${instructions}

After reading this file, confirm you understood it by stating:
1. What type of content this file contains (1 sentence)
2. Key information relevant to responding to reviewer comments (1-2 bullet points)`;
        }

        // Load webapp schema into OpenCode's context
        async function loadWebappSchemaContext() {
            try {
                // Fetch the webapp schema
                const schemaResponse = await fetch(`${API_BASE}/webapp-schema`);
                if (!schemaResponse.ok) {
                    console.warn('Could not load webapp schema');
                    return;
                }

                const { schema } = await schemaResponse.json();

                // Build a context prompt for the webapp
                const webappContextPrompt = `You are now connected to the Manuscript Review Platform webapp. Here is the current system state:

PROJECT: ${schema.name}
PURPOSE: ${schema.purpose}

MANUSCRIPT CONTEXT:
- ${schema.project_context.manuscript}
- Key topics: ${schema.project_context.key_topics.join(', ')}
- Dating method: ${schema.project_context.dating_method}

KEY STATISTICS (loaded from manuscript):
${schema.project_context?.key_stats ? Object.entries(schema.project_context.key_stats).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- No statistics loaded yet'}

CURRENT REVIEW STATUS:
- Total comments: ${schema.current_state.total}
- Pending: ${schema.current_state.byStatus?.pending || 0}
- In progress: ${schema.current_state.byStatus?.in_progress || 0}
- Completed: ${schema.current_state.byStatus?.completed || 0}
- Major comments: ${schema.current_state.byType?.major || 0}
- High priority: ${schema.current_state.highPriority || 0}

THEMATIC GROUPS (use to find related comments):
${Object.entries(schema.thematic_groups).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n')}

INSTRUCTIONS:
${schema.instructions}

Confirm you understand the webapp context and are ready to help respond to reviewer comments.`;

                // Send to OpenCode
                showOpenCodeLoading('webapp-context', 'Loading AI context...');
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: webappContextPrompt,
                        comment_id: 'webapp-context',
                        model: aiSettings.model,
                        agent: aiSettings.agent,
                        variant: aiSettings.variant
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    console.log('✓ Webapp schema loaded:', result.response?.substring(0, 100));
                    hideOpenCodeLoading('webapp-context', { success: true, message: 'AI context loaded' });
                } else {
                    hideOpenCodeLoading('webapp-context', { success: false, message: 'Failed to load context' });
                }
            } catch (e) {
                console.warn('Error loading webapp schema:', e.message);
                hideOpenCodeLoading('webapp-context', { success: false, message: 'Error loading context' });
            }
        }

        // Load context - one file at a time with confirmation
        async function loadContext() {
            const progressEl = document.getElementById('context-loading-progress');
            const statusEl = document.getElementById('context-loading-status');
            const loadBtn = document.getElementById('load-context-main-btn');

            // Get selected file paths
            const selectedFiles = Array.from(document.querySelectorAll('.context-file-checkbox:checked'))
                .map(cb => cb.value);

            if (selectedFiles.length === 0) {
                showNotification('Please select at least one file to load', 'error');
                return;
            }

            const fileCount = selectedFiles.length;
            const loadedFiles = [];
            const failedFiles = [];

            // Show loading
            if (progressEl) progressEl.classList.remove('hidden');
            if (loadBtn) loadBtn.disabled = true;

            try {
                // Step 1: Reset session
                if (statusEl) statusEl.textContent = 'Resetting AI session...';
                await fetch(`${API_BASE}/session/reset`, { method: 'POST' });

                // Step 2: Load webapp schema first
                if (statusEl) statusEl.textContent = 'Loading webapp context...';
                await loadWebappSchemaContext();

                // Step 3: Load files one by one
                for (let i = 0; i < selectedFiles.length; i++) {
                    const filePath = selectedFiles[i];
                    const fileName = filePath.split('/').pop();

                    if (statusEl) {
                        statusEl.innerHTML = `
                            <div class="flex items-center gap-2">
                                <span>Loading file ${i + 1}/${fileCount}:</span>
                                <span class="font-medium">${fileName}</span>
                            </div>
                            <div class="w-full bg-gray-200 rounded-full h-1.5 mt-2">
                                <div class="bg-blue-600 h-1.5 rounded-full transition-all" style="width: ${((i + 1) / fileCount * 100).toFixed(0)}%"></div>
                            </div>
                        `;
                    }

                    try {
                        // Build a context-aware prompt for this file
                        const contextPrompt = buildFileContextPrompt(fileName, filePath);

                        const response = await fetch(`${API_BASE}/ask`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                prompt: contextPrompt,
                                comment_id: `context-load-${i}`,
                                model: aiSettings.model,
                                agent: aiSettings.agent,
                                variant: aiSettings.variant,
                                file_paths: [filePath]
                            })
                        });

                        if (response.ok) {
                            const result = await response.json();
                            // Check if OpenCode actually read the file
                            const aiResponse = result.response || '';
                            if (aiResponse && aiResponse.length > 10) {
                                loadedFiles.push({ name: fileName, summary: aiResponse.substring(0, 100) });
                                console.log(`✓ Loaded: ${fileName} - ${aiResponse.substring(0, 50)}...`);
                            } else {
                                failedFiles.push({ name: fileName, error: 'Empty response' });
                            }
                        } else {
                            failedFiles.push({ name: fileName, error: 'Request failed' });
                        }
                    } catch (e) {
                        failedFiles.push({ name: fileName, error: e.message });
                    }
                }

                // Update state
                if (loadedFiles.length > 0) {
                    contextLoaded = true;
                    contextLoadedAt = new Date().toLocaleTimeString();
                    contextLoadedFiles = loadedFiles.map(f => f.name);
                    updateContextStatusDisplay();

                    // Show summary
                    let message = `Loaded ${loadedFiles.length}/${fileCount} files successfully!`;
                    if (failedFiles.length > 0) {
                        message += ` (${failedFiles.length} failed)`;
                        showNotification(message, 'warning');
                    } else {
                        showNotification(message, 'success');
                    }

                    // Log loaded files to console
                    console.log('=== Context Files Loaded ===');
                    loadedFiles.forEach(f => console.log(`✓ ${f.name}: ${f.summary}`));
                    if (failedFiles.length > 0) {
                        console.log('=== Failed Files ===');
                        failedFiles.forEach(f => console.log(`✗ ${f.name}: ${f.error}`));
                    }

                    closeContextModal();
                } else {
                    throw new Error('No files could be loaded');
                }

            } catch (e) {
                console.error('Context loading error:', e);
                showNotification('Error loading context: ' + e.message, 'error');
            } finally {
                if (progressEl) progressEl.classList.add('hidden');
                if (loadBtn) loadBtn.disabled = false;
            }
        }

        // Clear context
        async function clearContext() {
            if (!confirm('This will clear the AI\'s memory. You\'ll need to reload context for best responses. Continue?')) {
                return;
            }

            try {
                await fetch(`${API_BASE}/session/reset`, { method: 'POST' });
                contextLoaded = false;
                contextLoadedAt = null;
                updateContextStatusDisplay();
                showNotification('Context cleared. AI memory reset.', 'success');
            } catch (e) {
                showNotification('Error clearing context', 'error');
            }
        }

        // Build context prompt based on selected files
        function buildContextPrompt(selectedFiles) {
            let prompt = `Please read and remember the following to understand the full context of this manuscript review:\n\n`;

            if (selectedFiles.includes('manuscript')) {
                prompt += `MANUSCRIPT:\nRead and understand the main manuscript file.\n\n`;
            }

            if (selectedFiles.includes('reviews')) {
                prompt += `REVIEWER COMMENTS:\nUnderstand all reviewer comments and their key concerns.\n\n`;
            }

            if (selectedFiles.includes('data')) {
                prompt += `DATA:\nReview the supporting data and statistics.\n\n`;
            }

            if (selectedFiles.includes('supplementary')) {
                prompt += `SUPPLEMENTARY DATA:\nAdditional figures, tables, and analyses supporting the main findings.\n\n`;
            }

            prompt += `Confirm you understand the manuscript and are ready to help respond to reviewer comments.`;

            return prompt;
        }

        // =====================================================
        // FLOATING CHAT FUNCTIONS
        // =====================================================

        // Toggle chat window open/closed
        function toggleChat() {
            const chatEl = document.getElementById('chat-window');
            const fabEl = document.getElementById('chat-fab');
            chatIsOpen = !chatIsOpen;

            if (chatIsOpen) {
                chatEl.classList.remove('hidden');
                fabEl.style.display = 'none';
                // Small delay to let animation start before focusing
                setTimeout(() => {
                    document.getElementById('chat-input')?.focus();
                }, 100);
                updateChatContextBadge();
                updateChatModelIndicator();
                updateChatContextLink();
                // Show welcome message or restore history
                initializeChatMessages();
            } else {
                chatEl.classList.add('hidden');
                fabEl.style.display = 'flex';
                // Hide clear confirm if open
                cancelClearChat();
            }
        }

        // Initialize chat with welcome message or restore previous messages
        let chatInitialized = false;
        function initializeChatMessages() {
            const messagesEl = document.getElementById('chat-messages');
            if (!messagesEl) return;

            // If already initialized and has messages, just scroll to bottom
            if (chatInitialized && messagesEl.children.length > 0) {
                messagesEl.scrollTop = messagesEl.scrollHeight;
                return;
            }

            // Clear and show welcome or restore history
            messagesEl.innerHTML = '';

            if (chatHistory.length > 0) {
                // Restore previous messages
                chatHistory.forEach(msg => {
                    addChatMessage(msg.role, msg.content);
                });
            } else {
                // Show welcome message
                showChatWelcome();
            }

            chatInitialized = true;
        }

        // Show welcome message in chat
        function showChatWelcome() {
            const messagesEl = document.getElementById('chat-messages');
            if (!messagesEl) return;

            const paperTitle = reviewData?.manuscript?.title || 'your paper';
            const commentCount = getAllComments().length;

            messagesEl.innerHTML = `
                <div class="chat-welcome">
                    <div class="chat-welcome-icon">
                        <i class="fas fa-robot"></i>
                    </div>
                    <h4>Welcome to AI Assistant</h4>
                    <p>I'm here to help you respond to reviewer comments on <strong>${paperTitle}</strong>.</p>
                    ${commentCount > 0 ? `<p class="chat-welcome-stats">${commentCount} comments loaded</p>` : ''}
                    <div class="chat-welcome-tips">
                        <div class="chat-tip"><i class="fas fa-lightbulb"></i> Ask me to help draft responses</div>
                        <div class="chat-tip"><i class="fas fa-search"></i> Discuss specific comments by ID</div>
                        <div class="chat-tip"><i class="fas fa-keyboard"></i> Press <kbd>Cmd+K</kbd> to open chat</div>
                    </div>
                </div>
            `;
        }

        // Update model indicator in chat header
        function updateChatModelIndicator() {
            const el = document.getElementById('chat-model-indicator');
            if (el && aiSettings.model) {
                // Keep the status dot and update text
                el.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-green-300"></span>${aiSettings.model}`;
            }
        }

        // Update context link text based on context status
        function updateChatContextLink() {
            const linkText = document.getElementById('context-link-text');
            if (linkText) {
                linkText.textContent = contextLoaded ? 'Update Context' : 'Load Context';
            }
        }

        // Update context badge visibility
        function updateChatContextBadge() {
            const badge = document.getElementById('chat-context-badge');
            if (badge) {
                if (contextLoaded) {
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        }

        // Handle keyboard input in chat
        function handleChatKeydown(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendChatMessage();
            }
            // Escape to close chat
            if (event.key === 'Escape') {
                toggleChat();
            }
        }

        // Global keyboard shortcuts
        document.addEventListener('keydown', (event) => {
            // Don't trigger shortcuts when typing in input fields
            const activeElement = document.activeElement;
            const isTyping = activeElement.tagName === 'INPUT' ||
                            activeElement.tagName === 'TEXTAREA' ||
                            activeElement.isContentEditable;

            // Escape - close modals/chat
            if (event.key === 'Escape') {
                // Close chat if open
                if (chatIsOpen) {
                    toggleChat();
                    return;
                }
                // Close comment modal if open
                const commentModal = document.getElementById('comment-modal');
                if (commentModal && !commentModal.classList.contains('hidden')) {
                    closeModal();
                    return;
                }
                // Close agent modal if open
                const agentModal = document.getElementById('agent-modal');
                if (agentModal && !agentModal.classList.contains('hidden')) {
                    closeAgentModal();
                    return;
                }
                // Close context modal if open
                const contextModal = document.getElementById('context-modal');
                if (contextModal && !contextModal.classList.contains('hidden')) {
                    closeContextModal();
                    return;
                }
                // Close settings modal if open
                const settingsModal = document.getElementById('settings-modal');
                if (settingsModal && !settingsModal.classList.contains('hidden')) {
                    closeSettingsModal();
                    return;
                }
            }

            // Skip other shortcuts if typing
            if (isTyping) return;

            // Cmd/Ctrl + K - Open chat
            if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
                event.preventDefault();
                if (!chatIsOpen) toggleChat();
                return;
            }

            // Cmd/Ctrl + S - Save progress
            if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                saveProgress();
                return;
            }

            // Cmd/Ctrl + L - Load context
            if ((event.metaKey || event.ctrlKey) && event.key === 'l') {
                event.preventDefault();
                openContextModal();
                return;
            }

            // Number keys 1-6 for navigation (when not in input)
            if (event.key === '1') { setView('overview'); return; }
            if (event.key === '2') { setView('comments'); return; }
            if (event.key === '3') { setView('byreviewer'); return; }
            if (event.key === '4') { setView('agents'); return; }
            if (event.key === '5') { setView('experts'); return; }
            if (event.key === '6') { setView('export'); return; }

            // ? - Show keyboard shortcuts help
            if (event.key === '?') {
                showKeyboardShortcutsHelp();
                return;
            }
        });

        // Show keyboard shortcuts help modal
        function showKeyboardShortcutsHelp() {
            const shortcuts = [
                { key: '1-6', desc: 'Navigate between views' },
                { key: 'Esc', desc: 'Close modals/chat' },
                { key: '⌘/Ctrl + K', desc: 'Open AI chat' },
                { key: '⌘/Ctrl + S', desc: 'Save progress' },
                { key: '⌘/Ctrl + L', desc: 'Load AI context' },
                { key: '?', desc: 'Show this help' }
            ];

            const html = `
                <div class="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4" id="shortcuts-modal" onclick="if(event.target.id==='shortcuts-modal')this.remove()">
                    <div class="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden">
                        <div class="px-6 py-4 bg-gradient-to-r from-gray-700 to-gray-900 text-white">
                            <h3 class="text-lg font-semibold flex items-center gap-2">
                                <i class="fas fa-keyboard"></i>
                                Keyboard Shortcuts
                            </h3>
                        </div>
                        <div class="p-6">
                            <div class="space-y-3">
                                ${shortcuts.map(s => `
                                    <div class="flex items-center justify-between">
                                        <span class="text-gray-600">${s.desc}</span>
                                        <kbd class="px-2 py-1 bg-gray-100 rounded text-gray-700 font-mono text-sm">${s.key}</kbd>
                                    </div>
                                `).join('')}
                            </div>
                            <div class="mt-6 pt-4 border-t border-gray-200 text-center">
                                <button onclick="this.closest('#shortcuts-modal').remove()" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium">
                                    Close
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', html);
        }

        // Load chat history from database for current paper
        async function loadChatHistoryFromDB() {
            if (!currentPaperId) return;

            try {
                const response = await fetch(`${API_BASE}/db/chat/${currentPaperId}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.success && data.messages) {
                        // Group messages by comment_id
                        chatConversations = {};
                        data.messages.forEach(msg => {
                            const ctx = msg.comment_id || 'chat';
                            if (!chatConversations[ctx]) {
                                chatConversations[ctx] = [];
                            }
                            chatConversations[ctx].push({
                                role: msg.role,
                                content: msg.content,
                                timestamp: msg.timestamp
                            });
                        });

                        // Set current chat history to the active context
                        chatHistory = chatConversations[currentChatContext] || [];

                        console.log('Loaded chat history:', {
                            contexts: Object.keys(chatConversations),
                            totalMessages: data.messages.length
                        });

                        // Update conversation tabs UI if it exists
                        updateConversationTabs();
                    }
                }
            } catch (e) {
                console.error('Error loading chat history:', e);
            }
        }

        // Switch chat context (conversation)
        function switchChatContext(contextId) {
            currentChatContext = contextId;
            chatHistory = chatConversations[contextId] || [];

            // Re-initialize chat display
            chatInitialized = false;
            initializeChatMessages();

            // Update tabs UI
            updateConversationTabs();
        }

        // Update conversation tabs UI
        function updateConversationTabs() {
            const tabsEl = document.getElementById('chat-conversation-tabs');
            if (!tabsEl) return;

            const contexts = Object.keys(chatConversations);
            if (contexts.length <= 1) {
                tabsEl.innerHTML = '';
                tabsEl.classList.add('hidden');
                return;
            }

            tabsEl.classList.remove('hidden');

            // Map context IDs to friendly names
            const contextNames = {
                'chat': 'General',
                'knowledge': 'Knowledge'
            };

            tabsEl.innerHTML = contexts.map(ctx => {
                const name = contextNames[ctx] || ctx;
                const count = chatConversations[ctx].length;
                const isActive = ctx === currentChatContext;
                return `
                    <button onclick="switchChatContext('${ctx}')"
                        class="chat-tab ${isActive ? 'active' : ''}"
                        title="${count} messages">
                        ${name}
                        <span class="chat-tab-count">${count}</span>
                    </button>
                `;
            }).join('');
        }

        // Auto-resize textarea as user types
        function autoResizeChatInput(textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
        }

        // Send message to OpenCode
        async function sendChatMessage() {
            const input = document.getElementById('chat-input');
            const message = input.value.trim();

            if (!message || chatIsTyping) return;

            // Clear input
            input.value = '';
            input.style.height = 'auto';

            // Add user message to UI
            addChatMessage('user', message);

            // Add to history
            chatHistory.push({ role: 'user', content: message });

            // Show typing indicator
            showTypingIndicator();

            try {
                // All messages go through OpenCode which has MCP tools available
                // The AI can use list_data_sources, query_data, search_all_data tools
                // to access supplementary data from worker sessions

                // Build prompt with comment context if available
                let fullPrompt = message;
                let commentId = 'chat';

                if (commentChatContext) {
                    commentId = commentChatContext.id;
                    fullPrompt = `[CONTEXT: You are discussing reviewer comment ${commentChatContext.id}]
[Reviewer: ${commentChatContext.reviewer}]
[Category: ${commentChatContext.category}]
[Status: ${commentChatContext.status}]
[Comment: "${commentChatContext.text}"]
${commentChatContext.currentResponse ? `[Current draft response: "${commentChatContext.currentResponse.substring(0, 300)}..."]` : '[No response drafted yet]'}
${commentChatContext.relatedIds.length > 0 ? `[Related comments: ${commentChatContext.relatedIds.join(', ')}]` : ''}

User question: ${message}`;
                }

                // Send to OpenCode API
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: fullPrompt,
                        comment_id: commentId,
                        paper_id: currentPaperId,
                        model: aiSettings.model,
                        agent: aiSettings.agent,
                        variant: aiSettings.variant
                    })
                });

                hideTypingIndicator();

                if (response.ok) {
                    const result = await response.json();
                    const assistantMessage = result.response || 'No response received';

                    // Add assistant message to UI
                    addChatMessage('assistant', assistantMessage);

                    // Add to history
                    chatHistory.push({ role: 'assistant', content: assistantMessage });

                    // Update local conversations store
                    const ctx = commentId || 'chat';
                    if (!chatConversations[ctx]) chatConversations[ctx] = [];
                    chatConversations[ctx].push({ role: 'user', content: message });
                    chatConversations[ctx].push({ role: 'assistant', content: assistantMessage });
                    updateConversationTabs();
                } else {
                    const errorData = await response.json().catch(() => ({}));
                    addChatMessage('assistant', `Error: ${errorData.error || 'Failed to get response'}`);
                }
            } catch (e) {
                hideTypingIndicator();
                addChatMessage('assistant', `Error: Could not connect to OpenCode. Make sure the server is running on port 3001.`);
            }
        }

        // Add message to chat UI
        function addChatMessage(role, content) {
            const messagesEl = document.getElementById('chat-messages');

            const messageDiv = document.createElement('div');
            messageDiv.className = `chat-message ${role}`;

            const bubbleDiv = document.createElement('div');
            bubbleDiv.className = 'message-bubble';

            // Render markdown for assistant messages
            if (role === 'assistant') {
                let parsedHtml = marked.parse(content);
                // Make comment IDs clickable (e.g., R1-1, R2-3)
                parsedHtml = makeCommentIdsClickable(parsedHtml);
                bubbleDiv.innerHTML = `<div class="text-sm prose prose-sm max-w-none">${parsedHtml}</div>`;
            } else {
                bubbleDiv.innerHTML = `<p class="text-sm">${escapeHtml(content)}</p>`;
            }

            messageDiv.appendChild(bubbleDiv);
            messagesEl.appendChild(messageDiv);

            // Scroll to bottom
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        // Escape HTML to prevent XSS
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Show typing indicator
        function showTypingIndicator() {
            chatIsTyping = true;
            const messagesEl = document.getElementById('chat-messages');
            if (!messagesEl) return;

            const typingDiv = document.createElement('div');
            typingDiv.id = 'chat-typing-indicator';
            typingDiv.className = 'chat-message assistant';
            typingDiv.innerHTML = `
                <div class="message-bubble">
                    <div class="chat-typing">
                        <span></span>
                        <span></span>
                        <span></span>
                    </div>
                </div>
            `;
            messagesEl.appendChild(typingDiv);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        // Hide typing indicator
        function hideTypingIndicator() {
            chatIsTyping = false;
            const typingEl = document.getElementById('chat-typing-indicator');
            if (typingEl) typingEl.remove();
        }

        // Show clear confirmation toast
        function showClearConfirm() {
            const toast = document.getElementById('chat-clear-confirm');
            if (toast) toast.classList.add('show');
        }

        // Cancel clear and hide toast
        function cancelClearChat() {
            const toast = document.getElementById('chat-clear-confirm');
            if (toast) toast.classList.remove('show');
        }

        // Confirm clear chat history
        function confirmClearChat() {
            cancelClearChat();
            chatHistory = [];
            chatInitialized = false;
            showChatWelcome();
        }

        // Legacy function for backwards compatibility
        function clearChatHistory() {
            showClearConfirm();
        }

        // =====================================================
        // END FLOATING CHAT FUNCTIONS
        // =====================================================


        // Get selected skills from checkboxes
        function getSelectedSkills() {
            const checkboxes = document.querySelectorAll('.skill-checkbox:checked');
            return Array.from(checkboxes).map(cb => cb.value);
        }

        // Auto-select skills based on comment content (called when opening modal)
        function autoSelectSkills(comment) {
            // Reset all to unchecked except manuscript-reviewer
            document.querySelectorAll('.skill-checkbox').forEach(cb => {
                cb.checked = cb.value === 'manuscript-reviewer';
            });

            const category = comment.category?.toLowerCase() || '';
            const text = comment.original_text?.toLowerCase() || '';

            // Auto-check based on content
            if (category.includes('authentication') || category.includes('validation') ||
                text.includes('damage') || text.includes('contamination') || text.includes('authentic')) {
                const el = document.getElementById('skill-dna');
                if (el) el.checked = true;
            }

            if (category.includes('interpretation') || category.includes('ecology') ||
                text.includes('methano') || text.includes('community') || text.includes('wetland')) {
                const el = document.getElementById('skill-ecology');
                if (el) el.checked = true;
            }

            if (text.includes('evolution') || text.includes('phylogen') ||
                text.includes('similar') || text.includes('divergen')) {
                const el = document.getElementById('skill-phylo');
                if (el) el.checked = true;
            }

            if (text.includes('virus') || text.includes('viral') || text.includes('phage')) {
                const el = document.getElementById('skill-virome');
                if (el) el.checked = true;
            }

            if (category.includes('methods') || text.includes('pipeline') ||
                text.includes('parameter') || text.includes('bioinformatic')) {
                const el = document.getElementById('skill-methods');
                if (el) el.checked = true;
            }
        }

        function buildPrompt(comment, reviewer) {
            // Get skills from UI checkboxes
            const selectedSkills = getSelectedSkills();
            const skillsText = selectedSkills.length > 0
                ? `Use the skills: ${selectedSkills.join(', ')}`
                : '';

            return `${skillsText}

TASK: Write a response to reviewer comment ${comment.id}

REVIEWER: ${reviewer.name}
COMMENT: "${comment.original_text}"

ACTIONS TAKEN:
${comment.actions_taken.map(a => '- ' + a).join('\n')}

Write a professional response in PAST TENSE. Be concise, use specific data from the skills, and thank the reviewer.`;
        }

        // Expert insights are now loaded dynamically from the database
        // This function fetches insights generated by OpenCode during setup
        async function getExpertInsightsForComment(commentId) {
            try {
                const response = await fetch(`${API_BASE}/db/expert/${commentId}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.insights) {
                        return data.insights;
                    }
                }
            } catch (e) {
                console.log('Could not load expert insights for', commentId);
            }

            // Default: no pre-generated insights
            return `
No expert insights pre-generated for this comment.
Use the "Generate Expert Analysis" button to create insights using OpenCode.
`;
        }

        // NOTE: API_BASE is defined earlier in the file (near context state)

        // =====================================================
        // DATABASE PERSISTENCE LAYER (defined early for init)
        // =====================================================

        // Database status indicator
        let dbStatus = { sqlite_available: false, storage: 'localStorage' };

        // Check database status
        async function checkDbStatus() {
            try {
                const response = await fetch(`${API_BASE}/db/status`);
                if (response.ok) {
                    dbStatus = await response.json();
                    console.log('Database status:', dbStatus);
                    updateDbStatusIndicator();
                    return dbStatus;
                }
            } catch (e) {
                console.log('Database API not available, using localStorage');
            }
            return { sqlite_available: false, storage: 'localStorage' };
        }

        // Update the UI to show storage type
        function updateDbStatusIndicator() {
            // Add a small indicator to the header showing storage type
            let indicator = document.getElementById('db-status-indicator');
            if (!indicator) {
                const header = document.querySelector('header .flex.items-center');
                if (header) {
                    indicator = document.createElement('span');
                    indicator.id = 'db-status-indicator';
                    indicator.className = 'text-xs px-2 py-1 rounded ml-2';
                    header.appendChild(indicator);
                }
            }
            if (indicator) {
                if (dbStatus.sqlite_available) {
                    indicator.className = 'text-xs px-2 py-1 rounded ml-2 bg-green-100 text-green-700';
                    indicator.innerHTML = '<i class="fas fa-database mr-1"></i>SQLite';
                    indicator.title = 'Data persisted in SQLite database';
                } else if (dbStatus.storage === 'json') {
                    indicator.className = 'text-xs px-2 py-1 rounded ml-2 bg-blue-100 text-blue-700';
                    indicator.innerHTML = '<i class="fas fa-file-code mr-1"></i>JSON';
                    indicator.title = 'Data persisted in JSON files';
                } else {
                    indicator.className = 'text-xs px-2 py-1 rounded ml-2 bg-yellow-100 text-yellow-700';
                    indicator.innerHTML = '<i class="fas fa-browser mr-1"></i>Browser';
                    indicator.title = 'Data stored in browser (may be lost - start server for persistence)';
                }
            }
        }

        // Save comments to database (paper-specific if paper ID is set)
        async function saveCommentsToDb() {
            try {
                // Use paper-specific endpoint if we have a paper ID
                const endpoint = currentPaperId
                    ? `${API_BASE}/papers/${currentPaperId}/comments`
                    : `${API_BASE}/db/comments`;

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reviewData)
                });
                if (response.ok) {
                    const result = await response.json();
                    dbStatus.storage = result.storage;
                    updateDbStatusIndicator();
                    console.log(`Comments saved to ${result.storage}${result.paper_id ? ` for paper ${result.paper_id}` : ''}`);
                    return true;
                }
            } catch (e) {
                console.log('Database API not available, using localStorage');
            }
            // Fallback to localStorage
            localStorage.setItem('reviewData', JSON.stringify(reviewData));
            dbStatus.storage = 'localStorage';
            updateDbStatusIndicator();
            return false;
        }

        // Load comments from database (paper-specific if paper ID is set)
        async function loadCommentsFromDb() {
            try {
                // Use paper-specific endpoint if we have a paper ID
                const endpoint = currentPaperId
                    ? `${API_BASE}/papers/${currentPaperId}/comments`
                    : `${API_BASE}/db/comments`;

                const response = await fetch(endpoint);
                if (response.ok) {
                    const result = await response.json();
                    if (result.data && result.data.reviewers && result.data.reviewers.length > 0) {
                        dbStatus.storage = result.storage;
                        updateDbStatusIndicator();
                        console.log(`Comments loaded from ${result.storage}${result.paper_id ? ` for paper ${result.paper_id}` : ''}`);
                        return result.data;
                    }
                }
            } catch (e) {
                console.log('Database API not available');
            }
            return null;
        }

        // Auto-save on significant changes
        let autoSaveTimer = null;
        function scheduleAutoSave() {
            if (autoSaveTimer) clearTimeout(autoSaveTimer);
            // Show "Saving..." indicator
            const indicator = document.getElementById('autosave-indicator');
            if (indicator) {
                indicator.classList.remove('hidden');
                indicator.innerHTML = '<i class="fas fa-spinner fa-spin text-blue-500"></i><span>Saving...</span>';
            }

            autoSaveTimer = setTimeout(async () => {
                await saveCommentsToDb();
                console.log('Auto-saved to database');

                // Show "Saved" indicator
                if (indicator) {
                    indicator.innerHTML = '<i class="fas fa-check-circle text-green-500"></i><span>Saved</span>';
                    // Hide after 3 seconds
                    setTimeout(() => {
                        indicator.classList.add('hidden');
                    }, 3000);
                }
            }, 2000); // Auto-save 2 seconds after last change (faster feedback)
        }

        // =====================================================
        // END DATABASE PERSISTENCE LAYER
        // =====================================================

        // =====================================================
        // GO TO TOP BUTTON
        // =====================================================

        function scrollToTop() {
            const contentArea = document.getElementById('content-area');
            const mainContent = document.querySelector('.main-content');
            const scrollTarget = contentArea || mainContent;

            if (scrollTarget) {
                scrollTarget.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }

        // Show/hide go-to-top button based on scroll position
        function initScrollToTop() {
            const goToTopBtn = document.getElementById('go-to-top');
            if (!goToTopBtn) return;

            // Find all potential scroll containers
            const scrollContainers = [
                document.getElementById('content-area'),
                document.getElementById('app'),
                document.querySelector('.main-content'),
                document.querySelector('.app-container'),
                document.documentElement,
                document.body
            ].filter(Boolean);

            const handleScroll = () => {
                // Check all scroll sources and take the max
                let scrollTop = window.scrollY || 0;
                for (const el of scrollContainers) {
                    if (el.scrollTop > scrollTop) {
                        scrollTop = el.scrollTop;
                    }
                }

                if (scrollTop > 300) {
                    goToTopBtn.classList.add('visible');
                } else {
                    goToTopBtn.classList.remove('visible');
                }
            };

            // Listen to all scroll containers
            for (const el of scrollContainers) {
                el.addEventListener('scroll', handleScroll, { passive: true });
            }
            window.addEventListener('scroll', handleScroll, { passive: true });

            // Initial check
            handleScroll();
        }

        // Initialize
        document.addEventListener('DOMContentLoaded', async () => {
            // Initialize go-to-top button
            initScrollToTop();

            await checkDbStatus();  // Check database status first
            await loadPapers();     // Load available papers
            await loadAISettings();
            checkApiConnection();

            // Check for any active processing jobs to recover
            await recoverProgressOnLoad();

            // PRIORITY 1: Check URL query parameter for paper ID
            const urlParams = new URLSearchParams(window.location.search);
            const urlPaperId = urlParams.get('paper');

            if (urlPaperId && papers.find(p => p.id === urlPaperId)) {
                // Load paper from URL
                await switchPaper(urlPaperId);
            } else {
                // PRIORITY 2: Check localStorage for last opened paper
                const lastPaperId = localStorage.getItem('rebuttr_last_paper');

                if (lastPaperId && papers.find(p => p.id === lastPaperId)) {
                    // Resume last paper
                    await switchPaper(lastPaperId);
                } else if (papers.length > 0) {
                    // Load the first paper
                    await switchPaper(papers[0].id);
                } else {
                    // No papers - show empty state message
                    document.getElementById('manuscript-title').textContent = 'No papers yet';
                    setView('overview');
                    showNotification('Add a paper from the homepage to get started', 'info');
                }
            }
        });

        // Update context status based on loaded reviewData
        function updateContextFromLoadedData() {
            const hasData = reviewData?.manuscript?.title || reviewData?.reviewers?.length > 0;
            if (hasData && !contextLoaded) {
                contextLoaded = true;
                contextLoadedAt = 'From manuscript data';

                // Build a list of what we have loaded
                const loadedItems = [];
                if (reviewData?.manuscript?.title) {
                    loadedItems.push('Manuscript');
                }
                if (reviewData?.reviewers?.length > 0) {
                    loadedItems.push(`${reviewData.reviewers.length} Reviewers`);
                }
                const commentCount = reviewData?.reviewers?.reduce((sum, r) => sum + (r.comments?.length || 0), 0) || 0;
                if (commentCount > 0) {
                    loadedItems.push(`${commentCount} Comments`);
                }
                if (reviewData?.manuscript_data?.categories?.length > 0) {
                    loadedItems.push('Categories');
                }

                contextLoadedFiles = loadedItems;
                updateContextStatusDisplay();
                console.log('Context marked as loaded from reviewData:', loadedItems);
            }
        }

        // Load review data - embedded directly to avoid CORS issues with local files
        const DATA_VERSION = '2026-01-15-v2-60comments'; // Version for cache invalidation

        async function loadReviewData() {
            // Check if cached data is from older version - if so, clear it
            const cachedVersion = localStorage.getItem('reviewDataVersion');
            if (cachedVersion !== DATA_VERSION) {
                localStorage.removeItem('reviewData');
                localStorage.setItem('reviewDataVersion', DATA_VERSION);
            }

            // PRIORITY 1: Try to load from database (SQLite or JSON files)
            const dbData = await loadCommentsFromDb();
            if (dbData && dbData.reviewers && dbData.reviewers.length > 0) {
                reviewData = dbData;
                updateSidebar();
                console.log('Loaded review data from database');
                return;
            }

            // PRIORITY 2: Try to load from localStorage (browser storage)
            const savedData = localStorage.getItem('reviewData');
            if (savedData) {
                reviewData = JSON.parse(savedData);
                updateSidebar();
                // Try to sync to database for persistence
                saveCommentsToDb();
                return;
            }

            // PRIORITY 3: Try to fetch from file (works when served via HTTP)
            try {
                const response = await fetch('data/reviewer_comments.json');
                if (response.ok) {
                    reviewData = await response.json();
                    updateSidebar();
                    // Try to sync to database for persistence
                    saveCommentsToDb();
                    return;
                }
            } catch (error) {
                console.log('Fetch failed, using embedded data');
            }

            // PRIORITY 4: Fall back to embedded data for file:// protocol
            reviewData = getEmbeddedReviewData();
            updateSidebar();
            // Try to sync to database for persistence
            saveCommentsToDb();
        }

        // Embedded review data (auto-generated - works with file:// protocol)
        function getEmbeddedReviewData() {
            // Empty placeholder - will be populated dynamically after setup
            return {
                "manuscript": {
                    "title": "Your Manuscript Title",
                    "authors": "Author(s)",
                    "submission_date": "",
                    "review_date": ""
                },
                "reviewers": [],
                "note": "Run setup.js to parse your review file and populate this data"
            };
        }

        function createEmptyData() {
            return {
                manuscript: { title: "New Manuscript", authors: "", submission_date: "", review_date: "" },
                reviewers: []
            };
        }

        // Update sidebar
        function updateSidebar() {
            if (!reviewData) return;

            // Build comment relationships when data is available
            buildCommentRelationships();

            document.getElementById('manuscript-title').textContent = reviewData.manuscript.title;

            const allComments = getAllComments();
            const completed = allComments.filter(c => c.status === 'completed').length;
            const inProgress = allComments.filter(c => c.status === 'in_progress').length;
            const pending = allComments.filter(c => c.status === 'pending').length;
            const total = allComments.length;

            document.getElementById('completed-count').textContent = completed;
            document.getElementById('inprogress-count').textContent = inProgress;
            document.getElementById('pending-count').textContent = pending;

            const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
            document.getElementById('progress-bar').style.width = `${progress}%`;
            document.getElementById('progress-text').textContent = `${progress}% Complete (${completed}/${total})`;
        }

        function getAllComments() {
            if (!reviewData || !reviewData.reviewers) return [];
            return reviewData.reviewers.flatMap(r => r.comments.map(c => ({...c, reviewer: r.name, reviewerId: r.id})));
        }

        // Find a comment by its ID across all reviewers
        function findCommentById(commentId) {
            if (!reviewData || !reviewData.reviewers) return null;
            for (const reviewer of reviewData.reviewers) {
                const comment = reviewer.comments.find(c => c.id === commentId);
                if (comment) return comment;
            }
            return null;
        }

        // =====================================================
        // SKELETON LOADERS AND LOADING STATES
        // =====================================================

        // Show skeleton loading state for overview
        function showOverviewSkeleton() {
            const content = document.getElementById('content-area');
            content.innerHTML = `
                <div class="mb-6 skeleton-card">
                    <div class="skeleton skeleton-text" style="height: 24px; width: 200px; margin-bottom: 16px;"></div>
                    <div class="grid grid-cols-6 gap-3">
                        ${Array(6).fill('<div class="skeleton" style="height: 60px; border-radius: 8px;"></div>').join('')}
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-4 mb-6">
                    ${Array(4).fill(`
                        <div class="skeleton-card flex items-center gap-3">
                            <div class="skeleton skeleton-circle" style="width: 40px; height: 40px;"></div>
                            <div class="flex-1">
                                <div class="skeleton skeleton-text" style="width: 50px; height: 24px;"></div>
                                <div class="skeleton skeleton-text" style="width: 80px; height: 12px;"></div>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div class="skeleton-card mb-6">
                    <div class="skeleton skeleton-text" style="height: 20px; width: 180px; margin-bottom: 16px;"></div>
                    <div class="grid grid-cols-3 gap-4">
                        ${Array(3).fill(`
                            <div class="skeleton" style="height: 100px; border-radius: 8px;"></div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // Show skeleton loading state for comments list
        function showCommentsSkeleton() {
            const content = document.getElementById('content-area');
            content.innerHTML = `
                <div class="space-y-4">
                    ${Array(5).fill(`
                        <div class="skeleton-card">
                            <div class="flex items-start gap-4">
                                <div class="skeleton skeleton-circle" style="width: 36px; height: 36px;"></div>
                                <div class="flex-1">
                                    <div class="flex items-center gap-2 mb-2">
                                        <div class="skeleton skeleton-badge"></div>
                                        <div class="skeleton skeleton-badge" style="width: 80px;"></div>
                                        <div class="skeleton skeleton-badge" style="width: 50px;"></div>
                                    </div>
                                    <div class="skeleton skeleton-text" style="width: 100%;"></div>
                                    <div class="skeleton skeleton-text" style="width: 90%;"></div>
                                    <div class="skeleton skeleton-text" style="width: 70%;"></div>
                                    <div class="flex gap-2 mt-3">
                                        <div class="skeleton" style="height: 32px; width: 100px; border-radius: 6px;"></div>
                                        <div class="skeleton" style="height: 32px; width: 80px; border-radius: 6px;"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Show skeleton for sidebar progress
        function showSidebarSkeleton() {
            const progressContainer = document.querySelector('.sidebar .p-4.border-b');
            if (progressContainer) {
                progressContainer.innerHTML = `
                    <div class="skeleton skeleton-text" style="height: 16px; width: 120px; margin-bottom: 12px;"></div>
                    <div class="space-y-3">
                        <div class="flex items-center justify-between">
                            <div class="skeleton skeleton-text" style="width: 60px; height: 14px;"></div>
                            <div class="skeleton skeleton-text" style="width: 20px; height: 14px;"></div>
                        </div>
                        <div class="flex items-center justify-between">
                            <div class="skeleton skeleton-text" style="width: 70px; height: 14px;"></div>
                            <div class="skeleton skeleton-text" style="width: 20px; height: 14px;"></div>
                        </div>
                        <div class="skeleton" style="height: 8px; width: 100%; border-radius: 4px; margin-top: 8px;"></div>
                    </div>
                `;
            }
        }

        // Show loading overlay on a specific element
        function showLoadingOverlay(elementId, message = 'Loading...') {
            const element = document.getElementById(elementId);
            if (!element) return;
            element.style.position = 'relative';
            const overlay = document.createElement('div');
            overlay.id = `${elementId}-loading-overlay`;
            overlay.className = 'loading-overlay';
            overlay.innerHTML = `
                <div class="loading-spinner">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>${message}</span>
                </div>
            `;
            element.appendChild(overlay);
        }

        // Hide loading overlay
        function hideLoadingOverlay(elementId) {
            const overlay = document.getElementById(`${elementId}-loading-overlay`);
            if (overlay) overlay.remove();
        }

        // =====================================================
        // VIEW MANAGEMENT
        // =====================================================

        // View management
        function setView(view, preserveFilter = false) {
            currentView = view;
            if (!preserveFilter) {
                currentFilter = null;
            }
            document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

            const views = {
                'overview': { title: 'Overview', subtitle: 'Manuscript review summary and statistics', render: renderOverview },
                'taskqueue': { title: 'Task Queue', subtitle: 'AI-optimized task order - drag to reorder', render: renderTaskQueue },
                'comments': { title: 'All Comments', subtitle: 'Browse and manage all reviewer comments', render: renderAllComments },
                'byreviewer': { title: 'By Reviewer', subtitle: 'View comments organized by reviewer', render: renderByReviewer },
                'agents': { title: 'AI Agents', subtitle: 'Specialized agents for response assistance', render: renderAgents },
                'experts': { title: 'Expert Insights', subtitle: 'Multi-expert analysis of supplementary data', render: renderExperts },
                'export': { title: 'Export', subtitle: 'Export responses and generate documents', render: renderExport }
            };

            const viewConfig = views[view] || views['overview'];
            document.getElementById('view-title').textContent = viewConfig.title;
            document.getElementById('view-subtitle').textContent = viewConfig.subtitle;
            viewConfig.render();

            // Update URL to preserve view state on refresh
            const url = new URL(window.location);
            url.searchParams.set('view', view);
            window.history.replaceState({}, '', url);

            // Highlight active nav button
            const activeBtn = document.querySelector(`.nav-btn[onclick*="'${view}'"]`);
            if (activeBtn) {
                activeBtn.classList.add('active');
            }
        }

        // Get initial view from URL or default to overview
        function getInitialView() {
            const urlParams = new URLSearchParams(window.location.search);
            const viewParam = urlParams.get('view');
            const validViews = ['overview', 'taskqueue', 'comments', 'byreviewer', 'agents', 'experts', 'export'];
            return validViews.includes(viewParam) ? viewParam : 'overview';
        }

        // Render Overview - Comprehensive dashboard with key data and quick navigation
        function renderOverview() {
            const allComments = getAllComments();
            const byPriority = { high: 0, medium: 0, low: 0 };
            const byType = { major: 0, minor: 0 };
            const byCategory = {};
            const needsAnalysis = allComments.filter(c => c.requires_new_analysis).length;
            const completed = allComments.filter(c => c.status === 'completed').length;

            allComments.forEach(c => {
                byPriority[c.priority] = (byPriority[c.priority] || 0) + 1;
                byType[c.type] = (byType[c.type] || 0) + 1;
                byCategory[c.category] = (byCategory[c.category] || 0) + 1;
            });

            // Get expert discussions data
            const dataStats = expertDiscussions?.data_sources || {};

            // Check if we have actual manuscript data loaded
            const hasManuscript = reviewData?.manuscript?.title || reviewData?.reviewers?.length > 0;
            const manuscriptTitle = reviewData?.manuscript?.title || 'Untitled Manuscript';
            const manuscriptField = reviewData?.manuscript?.field || '';
            const categories = reviewData?.manuscript_data?.categories || [];

            const html = `
                <!-- Manuscript Info Banner -->
                ${hasManuscript ? `
                <div class="manuscript-banner">
                    <div class="manuscript-banner-content">
                        <div class="manuscript-banner-main">
                            <h3 class="manuscript-banner-title">
                                <i class="fas fa-file-alt"></i> ${manuscriptTitle}
                            </h3>
                            ${manuscriptField ? `<p class="manuscript-banner-field">${manuscriptField}</p>` : ''}
                        </div>
                        <div class="manuscript-banner-stats">
                            <div class="manuscript-banner-stat-value">${reviewData?.reviewers?.length || 0}</div>
                            <div class="manuscript-banner-stat-label">Reviewers</div>
                        </div>
                    </div>
                    ${categories.length > 0 ? `
                    <div class="manuscript-banner-categories">
                        <div class="manuscript-banner-cat-label">Review Categories:</div>
                        <div class="manuscript-banner-cat-tags">
                            ${categories.slice(0, 6).map(cat => `<span class="manuscript-banner-tag">${cat}</span>`).join('')}
                            ${categories.length > 6 ? `<span class="manuscript-banner-tag">+${categories.length - 6} more</span>` : ''}
                        </div>
                    </div>
                    ` : ''}
                </div>
                ` : `
                <div class="manuscript-banner manuscript-banner-empty">
                    <h3 class="manuscript-banner-title">
                        <i class="fas fa-info-circle"></i> No Paper Selected
                    </h3>
                    <p class="manuscript-banner-field">Select a paper from the dropdown above or use the CLI to add papers.</p>
                </div>
                `}

                <!-- Quick Stats Row -->
                <div class="overview-stats-grid">
                    <div class="overview-stat-card" onclick="setView('comments')">
                        <div class="overview-stat-inner">
                            <div class="overview-stat-icon comments">
                                <i class="fas fa-comments"></i>
                            </div>
                            <div>
                                <p class="overview-stat-value">${allComments.length}</p>
                                <p class="overview-stat-label">Total Comments</p>
                            </div>
                        </div>
                    </div>
                    <div class="overview-stat-card" onclick="filterByType('major')">
                        <div class="overview-stat-inner">
                            <div class="overview-stat-icon major">
                                <i class="fas fa-exclamation-circle"></i>
                            </div>
                            <div>
                                <p class="overview-stat-value major">${byType.major || 0}</p>
                                <p class="overview-stat-label">Major Issues</p>
                            </div>
                        </div>
                    </div>
                    <div class="overview-stat-card" onclick="filterByPriority('high')">
                        <div class="overview-stat-inner">
                            <div class="overview-stat-icon high">
                                <i class="fas fa-fire"></i>
                            </div>
                            <div>
                                <p class="overview-stat-value high">${byPriority.high || 0}</p>
                                <p class="overview-stat-label">High Priority</p>
                            </div>
                        </div>
                    </div>
                    <div class="overview-stat-card">
                        <div class="overview-stat-inner">
                            <div class="overview-stat-icon completed">
                                <i class="fas fa-check-circle"></i>
                            </div>
                            <div>
                                <p class="overview-stat-value completed">${completed}</p>
                                <p class="overview-stat-label">Completed</p>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Reviewers Quick Access -->
                <div class="overview-panel">
                    <h3 class="overview-panel-title">
                        <i class="fas fa-users"></i> Reviewers - Click to Jump
                    </h3>
                    <div class="reviewers-grid">
                        ${reviewData.reviewers.map(r => {
                            const majorCount = r.comments.filter(c => c.type === 'major').length;
                            const highCount = r.comments.filter(c => c.priority === 'high').length;
                            const completedCount = r.comments.filter(c => c.status === 'completed').length;
                            return `
                                <div class="reviewer-card" onclick="jumpToReviewer('${r.id}')">
                                    <div class="reviewer-card-header">
                                        <span class="reviewer-card-name">${r.name}</span>
                                        <span class="reviewer-card-count">${r.comments.length} comments</span>
                                    </div>
                                    <p class="reviewer-card-expertise">${r.expertise}</p>
                                    <div class="reviewer-card-badges">
                                        <span class="reviewer-badge major">${majorCount} major</span>
                                        <span class="reviewer-badge high">${highCount} high</span>
                                        <span class="reviewer-badge done">${completedCount} done</span>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>

                <!-- All Comments Quick Index - Separated by Major/Minor -->
                <div class="overview-panel">
                    <h3 class="overview-panel-title">
                        <i class="fas fa-list"></i> All Comments - Click Any to Open
                    </h3>

                    <!-- Major Comments -->
                    <div class="comments-index-section">
                        <div class="comments-index-header">
                            <span class="comments-index-dot major"></span>
                            <span class="comments-index-label major">Major (${byType.major || 0})</span>
                            <span class="comments-index-desc">- Substantive issues</span>
                        </div>
                        <div class="comments-index-grid">
                            ${allComments.filter(c => c.type === 'major').map(c => {
                                const statusDot = c.status === 'completed' ? ' ✓' : c.status === 'in_progress' ? ' ◐' : '';
                                const priorityClass = c.priority === 'high' ? 'high-priority' : '';
                                return `
                                    <button onclick="openCommentModal('${c.reviewerId}', '${c.id}')"
                                            class="comment-index-btn major ${priorityClass}">
                                        ${c.id}${statusDot}
                                    </button>
                                `;
                            }).join('')}
                        </div>
                    </div>

                    <!-- Minor Comments -->
                    <div class="comments-index-section">
                        <div class="comments-index-header">
                            <span class="comments-index-dot minor"></span>
                            <span class="comments-index-label minor">Minor (${byType.minor || 0})</span>
                            <span class="comments-index-desc">- Quick fixes</span>
                        </div>
                        <div class="comments-index-grid">
                            ${allComments.filter(c => c.type === 'minor').map(c => {
                                const statusDot = c.status === 'completed' ? ' ✓' : c.status === 'in_progress' ? ' ◐' : '';
                                return `
                                    <button onclick="openCommentModal('${c.reviewerId}', '${c.id}')"
                                            class="comment-index-btn minor">
                                        ${c.id}${statusDot}
                                    </button>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>

                <!-- Priority Distribution & Categories -->
                <div class="overview-two-col">
                    <div class="overview-panel">
                        <h3 class="overview-panel-title">Priority Distribution</h3>
                        <div class="priority-distribution">
                            <div class="priority-row" onclick="filterByPriority('high')">
                                <div class="priority-row-header">
                                    <span class="priority-row-label"><span class="priority-dot high"></span>High</span>
                                    <span class="priority-row-value high">${byPriority.high || 0}</span>
                                </div>
                                <div class="priority-bar">
                                    <div class="priority-bar-fill high" style="width: ${allComments.length > 0 ? (byPriority.high / allComments.length) * 100 : 0}%"></div>
                                </div>
                            </div>
                            <div class="priority-row" onclick="filterByPriority('medium')">
                                <div class="priority-row-header">
                                    <span class="priority-row-label"><span class="priority-dot medium"></span>Medium</span>
                                    <span class="priority-row-value medium">${byPriority.medium || 0}</span>
                                </div>
                                <div class="priority-bar">
                                    <div class="priority-bar-fill medium" style="width: ${allComments.length > 0 ? (byPriority.medium / allComments.length) * 100 : 0}%"></div>
                                </div>
                            </div>
                            <div class="priority-row" onclick="filterByPriority('low')">
                                <div class="priority-row-header">
                                    <span class="priority-row-label"><span class="priority-dot low"></span>Low</span>
                                    <span class="priority-row-value low">${byPriority.low || 0}</span>
                                </div>
                                <div class="priority-bar">
                                    <div class="priority-bar-fill low" style="width: ${allComments.length > 0 ? (byPriority.low / allComments.length) * 100 : 0}%"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="overview-panel">
                        <h3 class="overview-panel-title">Categories - Click to Filter</h3>
                        <div class="categories-grid">
                            ${Object.entries(byCategory).sort((a,b) => b[1] - a[1]).map(([cat, count]) => `
                                <button onclick="filterByCategory('${cat}')" class="category-btn">
                                    ${cat} <span class="category-btn-count">(${count})</span>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                </div>

                <!-- High Priority Items - Using same card format as All Comments -->
                <div class="overview-panel high-priority">
                    <h3 class="overview-panel-title high-priority">
                        <i class="fas fa-fire"></i> High Priority Items Requiring Attention
                        <span class="high-priority-count">(${allComments.filter(c => c.priority === 'high' && c.status !== 'completed').length} remaining)</span>
                    </h3>
                    <div class="overview-comments-list">
                        ${allComments.filter(c => c.priority === 'high' && c.status !== 'completed').slice(0, 8).map(c => renderCommentCard(c)).join('') || '<p class="high-priority-done">All high priority items completed!</p>'}
                    </div>
                </div>
            `;
            document.getElementById('content-area').innerHTML = html;
        }

        // Jump to specific reviewer
        function jumpToReviewer(reviewerId) {
            expandedReviewers[reviewerId] = true;
            setView('byreviewer');
            setTimeout(() => {
                const el = document.querySelector(`[data-reviewer="${reviewerId}"]`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }

        // Render All Comments - Shows both major and minor with clear sections
        function renderAllComments() {
            let allComments = getAllComments();
            let comments = [...allComments];

            if (currentFilter) {
                if (currentFilter.type === 'priority') {
                    comments = comments.filter(c => c.priority === currentFilter.value);
                } else if (currentFilter.type === 'type') {
                    comments = comments.filter(c => c.type === currentFilter.value);
                } else if (currentFilter.type === 'category') {
                    comments = comments.filter(c => c.category === currentFilter.value);
                } else if (currentFilter.type === 'analysis') {
                    comments = comments.filter(c => c.requires_new_analysis === currentFilter.value);
                } else if (currentFilter.type === 'search') {
                    const query = currentFilter.value;
                    comments = comments.filter(c => {
                        // Search in multiple fields
                        const searchFields = [
                            c.id,
                            c.original_text,
                            c.summary,
                            c.draft_response,
                            c.category,
                            c.reviewer,
                            c.location
                        ].filter(Boolean).map(f => f.toLowerCase());
                        return searchFields.some(field => field.includes(query));
                    });
                }
            }

            // Separate major and minor
            const majorComments = comments.filter(c => c.type === 'major');
            const minorComments = comments.filter(c => c.type === 'minor');

            // Count totals
            const totalMajor = allComments.filter(c => c.type === 'major').length;
            const totalMinor = allComments.filter(c => c.type === 'minor').length;

            const html = `
                <!-- Summary Banner -->
                <div class="comments-summary-banner">
                    <div class="comments-summary-stats">
                        <div class="comments-summary-stat">
                            <span class="comments-summary-dot major"></span>
                            <span class="comments-summary-label major">${totalMajor} Major</span>
                        </div>
                        <div class="comments-summary-stat">
                            <span class="comments-summary-dot minor"></span>
                            <span class="comments-summary-label minor">${totalMinor} Minor</span>
                        </div>
                        <span class="comments-summary-divider">|</span>
                        <span class="comments-summary-total">${allComments.length} Total Comments</span>
                    </div>
                    <div class="comments-filter-btns">
                        <button onclick="filterByType('major')"
                                class="filter-btn major ${currentFilter?.value === 'major' ? 'active' : ''}">
                            Show Major Only
                        </button>
                        <button onclick="filterByType('minor')"
                                class="filter-btn minor ${currentFilter?.value === 'minor' ? 'active' : ''}">
                            Show Minor Only
                        </button>
                        <button onclick="clearFilter()"
                                class="filter-btn all ${!currentFilter ? 'active' : ''}">
                            Show All
                        </button>
                    </div>
                </div>

                <!-- Filter & Sort Controls -->
                <div class="comments-controls">
                    <div class="comments-controls-left">
                        <select onchange="sortComments(this.value)" class="comments-sort-select">
                            <option value="id">Sort by ID</option>
                            <option value="priority">Sort by Priority</option>
                            <option value="status">Sort by Status</option>
                            <option value="reviewer">Sort by Reviewer</option>
                            <option value="type">Sort by Type</option>
                        </select>
                        ${currentFilter ? `
                            <span class="comments-filter-badge">
                                ${currentFilter.type === 'search'
                                    ? `<i class="fas fa-search"></i> "${currentFilter.value}"`
                                    : `Filter: ${currentFilter.type} = ${currentFilter.value}`}
                                <button onclick="clearFilter(); document.getElementById('search-input').value = '';" class="comments-filter-badge-clear">&times;</button>
                            </span>
                        ` : ''}
                    </div>
                    <span class="comments-count">Showing ${comments.length} of ${allComments.length}</span>
                </div>

                <!-- Comments grouped by type if showing all -->
                ${!currentFilter || currentFilter.type !== 'type' ? `
                    <!-- Major Comments Section -->
                    ${majorComments.length > 0 ? `
                        <div class="comments-section">
                            <h3 class="comments-section-header major">
                                <span class="section-dot"></span>
                                Major Comments (${majorComments.length})
                                <span class="comments-section-subtitle">- Require substantive response</span>
                            </h3>
                            <div class="comments-list">
                                ${majorComments.map(c => renderCommentCard(c)).join('')}
                            </div>
                        </div>
                    ` : ''}

                    <!-- Minor Comments Section -->
                    ${minorComments.length > 0 ? `
                        <div class="comments-section">
                            <h3 class="comments-section-header minor">
                                <span class="section-dot"></span>
                                Minor Comments (${minorComments.length})
                                <span class="comments-section-subtitle">- Quick fixes and clarifications</span>
                            </h3>
                            <div class="comments-list">
                                ${minorComments.map(c => renderCommentCard(c)).join('')}
                            </div>
                        </div>
                    ` : ''}
                ` : `
                    <!-- Filtered view - single list -->
                    <div class="comments-list">
                        ${comments.map(c => renderCommentCard(c)).join('')}
                    </div>
                `}
            `;
            document.getElementById('content-area').innerHTML = html;
        }

        // Icon and color maps for unified display
        const iconMap = {
            'dna': 'fa-dna', 'shield-virus': 'fa-shield-virus', 'leaf': 'fa-leaf',
            'cogs': 'fa-cogs', 'tree': 'fa-tree', 'mountain': 'fa-mountain',
            'code-branch': 'fa-code-branch', 'pen': 'fa-pen', 'database': 'fa-database',
            'code': 'fa-code', 'globe': 'fa-globe', 'flask': 'fa-flask', 'atom': 'fa-atom',
            'microscope': 'fa-microscope', 'chart-line': 'fa-chart-line', 'dna-helix': 'fa-dna'
        };
        // Color map uses custom CSS classes from app.css (expert-{color} classes)
        const colorMap = {
            'blue': { cssClass: 'expert-blue' },
            'red': { cssClass: 'expert-red' },
            'green': { cssClass: 'expert-green' },
            'purple': { cssClass: 'expert-purple' },
            'orange': { cssClass: 'expert-orange' },
            'cyan': { cssClass: 'expert-cyan' },
            'brown': { cssClass: 'expert-brown' },
            'gray': { cssClass: 'expert-gray' }
        };

        function renderCommentCard(comment) {
            const priorityClass = `priority-${comment.priority}`;

            // Get expert data from embedded discussions
            const expertData = expertDiscussions?.expert_discussions?.[comment.id];
            const experts = expertData?.experts || comment.experts || [];
            const recommendedResponse = expertData?.recommended_response || comment.recommended_response || '';
            const adviceToAuthor = expertData?.advice_to_author || comment.advice_to_author || '';
            const fullContext = expertData?.full_context || comment.full_context || '';

            // Build compact expert summary (just names and key points)
            let expertSummary = '';
            if (experts.length > 0) {
                expertSummary = `
                    <div class="comment-expert-summary">
                        <span class="comment-expert-label"><i class="fas fa-users"></i> ${experts.length} expert${experts.length > 1 ? 's' : ''}:</span>
                        ${experts.map(e => {
                            const icon = iconMap[e.icon] || 'fa-user';
                            return `<span class="comment-expert-name"><i class="fas ${icon}"></i> ${e.name.split(' ')[0]}</span>`;
                        }).join('')}
                    </div>
                `;
            }

            // Build detailed expert panels HTML (in collapsible)
            let expertsDetailHtml = '';
            if (experts.length > 0) {
                expertsDetailHtml = `
                    <div class="experts-grid mt-3">
                        ${experts.map(expert => {
                            const colorClass = colorMap[expert.color]?.cssClass || 'expert-blue';
                            const icon = iconMap[expert.icon] || 'fa-user';
                            return `
                                <div class="expert-card ${colorClass}">
                                    <div class="expert-card-header">
                                        <i class="fas ${icon}"></i>
                                        <span class="expert-name">${expert.name}</span>
                                    </div>
                                    <div class="expert-card-body">
                                        <div class="expert-verdict">
                                            <strong>Verdict:</strong> ${expert.verdict}
                                        </div>
                                        ${expert.data_analysis && expert.data_analysis.length > 0 ? `
                                            <details class="expert-data-analysis">
                                                <summary class="cursor-pointer font-medium">Data Analysis (${expert.data_analysis.length} points)</summary>
                                                <ul>
                                                    ${expert.data_analysis.map(d => `<li>${d}</li>`).join('')}
                                                </ul>
                                            </details>
                                        ` : ''}
                                        <div class="expert-recommendation">
                                            <strong>Rec:</strong> ${expert.recommendation}
                                        </div>
                                        ${expert.key_data_points && expert.key_data_points.length > 0 ? `
                                            <div class="expert-data-points">
                                                ${expert.key_data_points.map(p => `<span class="expert-data-point">${p}</span>`).join('')}
                                            </div>
                                        ` : ''}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }

            // Build recommended response HTML
            let responseHtml = '';
            if (recommendedResponse) {
                responseHtml = `
                    <div class="recommended-response mt-3">
                        <div class="flex items-center justify-between mb-2">
                            <span class="recommended-response-title"><i class="fas fa-check-circle"></i> Recommended Response</span>
                            <button onclick="useExpertResponse('${comment.id}')" class="btn btn-sm btn-success">
                                <i class="fas fa-copy"></i> Use
                            </button>
                        </div>
                        <p class="recommended-response-text">${recommendedResponse}</p>
                    </div>
                `;
            }

            // Build advice HTML
            let adviceHtml = '';
            if (adviceToAuthor) {
                adviceHtml = `
                    <div class="advice-box mt-2">
                        <span class="advice-box-title"><i class="fas fa-lightbulb"></i> Tip:</span>
                        <span class="advice-box-text">${adviceToAuthor}</span>
                    </div>
                `;
            }

            return `
                <div class="comment-card ${priorityClass}">
                    <!-- Compact Header -->
                    <div class="comment-card-header">
                        <div class="comment-badges">
                            <a href="javascript:void(0)" class="comment-id comment-link-pill" onclick="openCommentModal('${comment.reviewerId}', '${comment.id}')" title="Open ${comment.id} in Response Builder">${comment.id}</a>
                            <span class="badge ${comment.type === 'major' ? 'badge-major' : 'badge-minor'}">${comment.type}</span>
                            <span class="badge badge-secondary">${comment.category}</span>
                        </div>
                        <div class="comment-actions-inline">
                            <span class="badge ${getStatusBadgeClass(comment.status)}">${comment.status}</span>
                            <button onclick="openCommentModal('${comment.reviewerId}', '${comment.id}')" class="btn btn-sm btn-ghost">
                                <i class="fas fa-expand-alt"></i>
                            </button>
                        </div>
                    </div>

                    <!-- Reviewer Comment -->
                    <div class="comment-card-body">
                        <p class="comment-text">"${comment.original_text.substring(0, 250)}${comment.original_text.length > 250 ? '...' : ''}"</p>
                        ${expertSummary}
                    </div>

                    <!-- Collapsible Details -->
                    <details class="comment-details">
                        <summary class="comment-details-summary">
                            <i class="fas fa-chevron-down"></i> Show Full Comment & Expert Analysis
                        </summary>
                        <div class="comment-details-content">
                            <!-- Full Reviewer Comment -->
                            <div class="full-comment-box">
                                <p class="full-comment-label"><i class="fas fa-quote-left"></i> Full Reviewer Comment:</p>
                                <p class="full-comment-text">${comment.original_text}</p>
                            </div>
                            ${fullContext ? `
                                <div class="context-box">
                                    <p class="context-label"><i class="fas fa-info-circle"></i> Additional Context:</p>
                                    <p class="context-text">${fullContext}</p>
                                </div>
                            ` : ''}

                            ${comment.draft_response ? `
                                <div class="draft-response-box">
                                    <p class="draft-response-label"><i class="fas fa-pen"></i> Your Current Draft Response:</p>
                                    <p class="draft-response-text">${comment.draft_response}</p>
                                </div>
                            ` : ''}

                            ${expertsDetailHtml}
                            ${responseHtml}
                            ${adviceHtml}
                        </div>
                    </details>

                    <!-- Quick Actions -->
                    <div class="comment-card-footer">
                        <div class="comment-quick-actions">
                            <button onclick="setCommentStatus('${comment.reviewerId}', '${comment.id}', 'completed')"
                                    class="btn btn-sm ${comment.status === 'completed' ? 'btn-success' : 'btn-ghost'}"
                                    title="Mark completed">
                                <i class="fas fa-check"></i>
                            </button>
                            <button onclick="setCommentStatus('${comment.reviewerId}', '${comment.id}', 'in_progress')"
                                    class="btn btn-sm ${comment.status === 'in_progress' ? 'btn-primary' : 'btn-ghost'}"
                                    title="Mark in progress">
                                <i class="fas fa-spinner"></i>
                            </button>
                            <button onclick="showRelatedComments('${comment.id}')" class="btn btn-sm btn-ghost" title="Show related">
                                <i class="fas fa-project-diagram"></i>
                            </button>
                            <button onclick="discussCommentInChat('${comment.id}')" class="btn btn-sm btn-ghost" title="Discuss in chat">
                                <i class="fas fa-comments"></i>
                            </button>
                            <button onclick="regenerateExpertForComment('${comment.id}')" class="btn btn-sm btn-ghost" title="Regenerate">
                                <i class="fas fa-wand-magic-sparkles"></i>
                            </button>
                        </div>
                        <div class="comment-main-actions">
                            ${recommendedResponse ? `
                                <button onclick="useExpertResponse('${comment.id}')" class="btn btn-sm btn-success">
                                    <i class="fas fa-magic"></i> Use
                                </button>
                            ` : ''}
                            <button onclick="openCommentModal('${comment.reviewerId}', '${comment.id}')" class="btn btn-sm btn-secondary">
                                <i class="fas fa-edit"></i> Edit
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }

        // Helper function for status badge class
        function getStatusBadgeClass(status) {
            switch(status) {
                case 'completed': return 'badge-completed';
                case 'in_progress': return 'badge-inprogress';
                case 'pending': return 'badge-pending';
                default: return 'badge-secondary';
            }
        }

        // Track expanded reviewers
        let expandedReviewers = {};

        // Render By Reviewer - Unified format with expert panels
        // Track collapsed reviewers (collapsed by default = false, meaning expanded)
        let collapsedReviewers = {};

        function renderByReviewer() {
            const html = `
                <div class="reviewer-panels">
                    ${reviewData.reviewers.map(reviewer => {
                        const isCollapsed = collapsedReviewers[reviewer.id];
                        const isExpanded = expandedReviewers[reviewer.id];
                        const commentsToShow = isExpanded ? reviewer.comments : reviewer.comments.slice(0, 3);
                        const majorCount = reviewer.comments.filter(c => c.type === 'major').length;
                        const highPriorityCount = reviewer.comments.filter(c => c.priority === 'high').length;
                        const completedCount = reviewer.comments.filter(c => c.status === 'completed').length;
                        const progressPct = reviewer.comments.length > 0 ? Math.round((completedCount / reviewer.comments.length) * 100) : 0;

                        return `
                        <div class="reviewer-panel ${isCollapsed ? 'collapsed' : ''}" data-reviewer="${reviewer.id}">
                            <div class="reviewer-panel-header" onclick="toggleReviewerCollapse('${reviewer.id}')">
                                <div class="reviewer-collapse-icon">
                                    <i class="fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>
                                </div>
                                <div class="reviewer-panel-header-inner">
                                    <div class="reviewer-panel-info">
                                        <h3>${reviewer.name}</h3>
                                        <p class="reviewer-panel-expertise">${reviewer.expertise}</p>
                                        ${!isCollapsed ? `<p class="reviewer-panel-assessment">${reviewer.overall_assessment}</p>` : ''}
                                    </div>
                                    <div class="reviewer-panel-badges">
                                        <span class="reviewer-badge total">${reviewer.comments.length} comments</span>
                                        <span class="reviewer-badge major">${majorCount} major</span>
                                        <span class="reviewer-badge high">${highPriorityCount} high priority</span>
                                        <span class="reviewer-badge done">${completedCount} done</span>
                                        <div class="reviewer-progress-mini">
                                            <div class="reviewer-progress-mini-bar" style="width: ${progressPct}%"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="reviewer-panel-body ${isCollapsed ? 'hidden' : ''}">
                                <div class="reviewer-panel-comments">
                                    ${commentsToShow.map(c => renderCommentCard({...c, reviewer: reviewer.name, reviewerId: reviewer.id})).join('')}
                                </div>
                                ${reviewer.comments.length > 3 ? `
                                    <button onclick="event.stopPropagation(); toggleReviewerExpand('${reviewer.id}')" class="reviewer-expand-btn">
                                        <i class="fas ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>
                                        ${isExpanded ? 'Show less' : `Show all ${reviewer.comments.length} comments`}
                                    </button>
                                ` : ''}
                            </div>
                        </div>
                    `;}).join('')}
                </div>
                <div class="reviewer-controls">
                    <button onclick="expandAllReviewers()" class="btn btn-ghost btn-sm"><i class="fas fa-expand-alt"></i> Expand All</button>
                    <button onclick="collapseAllReviewers()" class="btn btn-ghost btn-sm"><i class="fas fa-compress-alt"></i> Collapse All</button>
                </div>
            `;
            document.getElementById('content-area').innerHTML = html;
        }

        function toggleReviewerCollapse(reviewerId) {
            collapsedReviewers[reviewerId] = !collapsedReviewers[reviewerId];
            renderByReviewer();
        }

        function toggleReviewerExpand(reviewerId) {
            expandedReviewers[reviewerId] = !expandedReviewers[reviewerId];
            renderByReviewer();
        }

        function expandAllReviewers() {
            reviewData.reviewers.forEach(r => {
                collapsedReviewers[r.id] = false;
            });
            renderByReviewer();
        }

        function collapseAllReviewers() {
            reviewData.reviewers.forEach(r => {
                collapsedReviewers[r.id] = true;
            });
            renderByReviewer();
        }

        // Get the paper-level experts (the 3-4 consistent experts generated during paper processing)
        function extractDynamicExperts() {
            // Priority 1: Use paper-level experts if available (these are the 3-4 consistent experts)
            if (expertDiscussions?.experts && Array.isArray(expertDiscussions.experts) && expertDiscussions.experts.length > 0) {
                // Count how many comments each expert has analyzed
                const commentCounts = {};
                if (expertDiscussions?.expert_discussions) {
                    for (const [commentId, discussion] of Object.entries(expertDiscussions.expert_discussions)) {
                        if (discussion.experts && Array.isArray(discussion.experts)) {
                            for (const expert of discussion.experts) {
                                const key = expert.name?.toLowerCase().trim();
                                if (key) {
                                    commentCounts[key] = (commentCounts[key] || 0) + 1;
                                }
                            }
                        }
                    }
                }

                return expertDiscussions.experts.map(expert => ({
                    name: expert.name,
                    icon: expert.icon || 'user-graduate',
                    color: expert.color || 'blue',
                    expertise: Array.isArray(expert.expertise) ? expert.expertise : [],
                    comment_types: expert.comment_types || [],
                    // How many comments this expert analyzed
                    commentsAnalyzed: commentCounts[expert.name?.toLowerCase().trim()] || 0,
                    description: Array.isArray(expert.expertise) && expert.expertise.length > 0
                        ? expert.expertise.slice(0, 3).join(', ')
                        : 'Domain Expert'
                }));
            }

            // Fallback: Extract unique experts from individual comment discussions
            if (!expertDiscussions?.expert_discussions) return [];

            const expertMap = new Map();

            for (const [commentId, discussion] of Object.entries(expertDiscussions.expert_discussions)) {
                if (discussion.experts && Array.isArray(discussion.experts)) {
                    for (const expert of discussion.experts) {
                        const key = expert.name?.toLowerCase().trim();

                        // Skip invalid/placeholder expert names
                        if (!key || key === '(unused)' || key === 'unused' || key === '' || key === 'null') {
                            continue;
                        }

                        if (!expertMap.has(key)) {
                            const expertise = expert.expertise || [];
                            expertMap.set(key, {
                                name: expert.name,
                                icon: expert.icon || 'user-graduate',
                                color: expert.color || 'blue',
                                expertise: Array.isArray(expertise) ? expertise : [expertise],
                                comments: [commentId],
                                commentsAnalyzed: 1,
                                description: Array.isArray(expertise) && expertise.length > 0
                                    ? expertise.slice(0, 3).join(', ')
                                    : (expert.verdict || 'Domain Expert')
                            });
                        } else {
                            expertMap.get(key).comments.push(commentId);
                            expertMap.get(key).commentsAnalyzed++;
                        }
                    }
                }
            }

            return Array.from(expertMap.values());
        }

        // Render Agents - generic experts loaded from config or defaults
        function renderAgents() {
            // Get dynamic experts from expertDiscussions (generated during paper processing)
            const dynamicExperts = extractDynamicExperts();

            // Generic/static agents (always available) - using semantic class names
            const genericAgents = [
                {
                    id: 'methodology',
                    name: 'Methodology Expert',
                    description: 'Specializes in experimental design, controls, sample size, and reproducibility concerns.',
                    icon: 'fa-flask',
                    colorClass: 'agent-methodology',
                    skills: ['Experimental design', 'Controls validation', 'Sample size justification', 'Reproducibility']
                },
                {
                    id: 'statistics',
                    name: 'Statistical Analysis Expert',
                    description: 'Handles statistical test selection, assumptions, effect sizes, and multiple comparisons.',
                    icon: 'fa-chart-bar',
                    colorClass: 'agent-statistics',
                    skills: ['Test selection', 'Assumption checking', 'Effect sizes', 'Multiple comparisons']
                },
                {
                    id: 'writing',
                    name: 'Writing & Presentation Expert',
                    description: 'Expert in scientific writing clarity, structure, figures, and journal-specific formatting.',
                    icon: 'fa-pen',
                    colorClass: 'agent-writing',
                    skills: ['Clarity improvement', 'Figure presentation', 'Structure', 'Accessibility']
                },
                {
                    id: 'literature',
                    name: 'Literature & Citations Expert',
                    description: 'Specializes in literature coverage, citation accuracy, and contextualizing findings.',
                    icon: 'fa-book',
                    colorClass: 'agent-literature',
                    skills: ['Citation review', 'Literature gaps', 'Context', 'Comparison with prior work']
                },
                {
                    id: 'domain',
                    name: 'Domain Expert',
                    description: 'Field-specific expertise loaded from your manuscript context and skills.',
                    icon: 'fa-graduation-cap',
                    colorClass: 'agent-domain',
                    skills: ['Domain knowledge', 'Technical accuracy', 'Field standards', 'Terminology']
                }
            ];

            // Build dynamic experts panel if available
            let dynamicExpertsHtml = '';
            if (dynamicExperts.length > 0) {
                dynamicExpertsHtml = `
                    <div class="agents-section">
                        <div class="agents-section-header">
                            <h3 class="agents-section-title">
                                <i class="fas fa-brain"></i>
                                AI-Generated Experts for This Paper
                            </h3>
                            <span class="agents-section-badge">${dynamicExperts.length} experts</span>
                        </div>
                        <p class="agents-section-desc">These experts were dynamically created based on your manuscript content and reviewer concerns.</p>
                        <div class="agents-grid">
                            ${dynamicExperts.map((expert, idx) => {
                                const icon = iconMap[expert.icon] || 'fa-user-graduate';
                                const colorClass = colorMap[expert.color]?.cssClass || 'expert-blue';
                                const commentCount = expert.comments?.length || 0;
                                // Truncate long names
                                const shortName = expert.name.length > 50 ? expert.name.substring(0, 47) + '...' : expert.name;
                                return `
                                    <div class="agent-card agent-dynamic ${colorClass}" onclick="askExpertInChat('${expert.name.replace(/'/g, "\\'")}')">
                                        <div class="agent-card-header">
                                            <div class="agent-icon">
                                                <i class="fas ${icon}"></i>
                                            </div>
                                            <h3 class="agent-name">${shortName}</h3>
                                        </div>
                                        <p class="agent-desc">${expert.description || 'Specialized expert for your manuscript.'}</p>
                                        <div class="agent-meta">
                                            <span class="agent-comment-count">
                                                <i class="fas fa-comments"></i> Analyzed ${commentCount} comment${commentCount !== 1 ? 's' : ''}
                                            </span>
                                        </div>
                                        ${expert.comments && expert.comments.length > 0 ? `
                                            <div class="agent-comments-list">
                                                ${expert.comments.slice(0, 5).map(cid => `
                                                    <a href="javascript:void(0)" class="agent-comment-link" onclick="event.stopPropagation(); navigateToComment('${cid}')">${cid}</a>
                                                `).join('')}
                                                ${expert.comments.length > 5 ? `<span class="agent-more">+${expert.comments.length - 5} more</span>` : ''}
                                            </div>
                                        ` : ''}
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }

            const html = `
                <!-- How to Use Banner -->
                <div class="agents-tip-banner">
                    <div class="agents-tip-icon">
                        <i class="fas fa-robot"></i>
                    </div>
                    <div class="agents-tip-content">
                        <h3>Just Ask Me Directly!</h3>
                        <p>I have all your review data and these domain skills built-in. Simply ask me in the chat:</p>
                        <div class="agents-tip-examples">
                            <code>"Help me respond to <a href="javascript:void(0)" class="comment-link" onclick="event.stopPropagation(); navigateToComment('R1-4')">R1-4</a> using the phylogenetics skill"</code>
                            <code>"What does the DNA damage expert say about authentication?"</code>
                        </div>
                    </div>
                </div>

                <!-- Dynamic Experts (generated for this paper) -->
                ${dynamicExpertsHtml}

                <!-- Generic Experts (always available) -->
                <div class="agents-section">
                    <h3 class="agents-section-title">
                        <i class="fas fa-users"></i>
                        Standard Domain Experts
                    </h3>
                    <p class="agents-section-desc">These experts are available for all papers and provide general academic assistance.</p>
                    <div class="agents-grid">
                        ${genericAgents.map(agent => `
                            <div class="agent-card ${agent.colorClass}" onclick="startAgentConsultation('${agent.id}')">
                                <div class="agent-card-header">
                                    <div class="agent-icon">
                                        <i class="fas ${agent.icon}"></i>
                                    </div>
                                    <h3 class="agent-name">${agent.name}</h3>
                                </div>
                                <p class="agent-desc">${agent.description}</p>
                                <div class="agent-skills">
                                    ${agent.skills.map(skill => `
                                        <span class="agent-skill">${skill}</span>
                                    `).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <!-- Quick Prompts -->
                <div class="agents-prompts">
                    <h3 class="agents-prompts-title">Quick Prompts</h3>
                    <p class="agents-prompts-desc">Click to copy, then paste in the chat:</p>
                    <div class="agents-prompts-grid">
                        <button onclick="copyPrompt('Show me all high priority comments that need the phylogenetics skill')" class="prompt-btn">
                            <i class="fas fa-copy"></i> Show high priority + phylogenetics
                        </button>
                        <button onclick="copyPrompt('Help me draft responses for all authentication concerns from R1')" class="prompt-btn">
                            <i class="fas fa-copy"></i> Draft authentication responses
                        </button>
                        <button onclick="copyPrompt('Use the microbial ecology skill to improve my response to R3-2')" class="prompt-btn">
                            <i class="fas fa-copy"></i> Improve ecology response
                        </button>
                        <button onclick="copyPrompt('What new analyses are needed and which skills should I use for each?')" class="prompt-btn">
                            <i class="fas fa-copy"></i> List analyses needed
                        </button>
                    </div>
                </div>
            `;
            document.getElementById('content-area').innerHTML = html;
        }

        // Expert discussions data - loaded dynamically from database or file
        // No hardcoded data - generated by OpenCode after setup
        // This empty structure will be populated by setup.js when parsing reviews
        const EXPERT_DISCUSSIONS_DATA = {
            "generated": "dynamic",
            "note": "Run setup.js to parse reviews and populate this data",
            "data_sources": {},
            "reviewers_summary": {},
            "expert_discussions": {}
        };
        // NOTE: Remaining expert discussions data removed - will be populated dynamically by setup.js
        let expertDiscussions = EXPERT_DISCUSSIONS_DATA;


        async function loadExpertDiscussions() {
            // Priority 1: Always try server first (source of truth)
            try {
                const response = await fetch(`${API_BASE}/db/experts`);
                if (response.ok) {
                    const result = await response.json();
                    if (result.success && result.data && result.data.expert_discussions) {
                        const count = Object.keys(result.data.expert_discussions).length;
                        if (count > 0) {
                            expertDiscussions = result.data;
                            console.log('Expert discussions loaded from server:', count, 'discussions');
                            return;
                        }
                    }
                }
            } catch (e) {
                console.log('Could not load from server:', e.message);
            }

            // Priority 2: Try fetching from JSON file
            try {
                const response = await fetch('expert_discussions.json');
                if (response.ok) {
                    expertDiscussions = await response.json();
                    console.log('Expert discussions loaded from JSON file');
                    return;
                }
            } catch (e) {
                console.log('Could not load from JSON file');
            }

            // Priority 3: Use embedded data (empty by default)
            expertDiscussions = EXPERT_DISCUSSIONS_DATA;
            console.log('Using default empty expert discussions');
        }

        // Sync expert data with comments for consistent display across all views
        function syncExpertDataWithComments() {
            if (!reviewData || !reviewData.reviewers || !expertDiscussions?.expert_discussions) return;

            // Merge expert discussions data into the comment objects
            for (const reviewer of reviewData.reviewers) {
                for (const comment of reviewer.comments) {
                    const expertData = expertDiscussions.expert_discussions[comment.id];
                    if (expertData) {
                        // Sync expert data to the comment object
                        comment.experts = expertData.experts || comment.experts;
                        comment.recommended_response = expertData.recommended_response || comment.recommended_response;
                        comment.advice_to_author = expertData.advice_to_author || comment.advice_to_author;
                        comment.full_context = expertData.full_context || comment.full_context;
                    }
                }
            }
            console.log('Synced expert data with comments');
        }

        // Refresh all views with synchronized data
        function refreshAllViews() {
            syncExpertDataWithComments();
            setView(currentView);
            updateSidebar();
        }

        // Current filter state for expert view
        let expertFilter = 'all'; // 'all', 'major', 'minor', 'R1', 'R3', 'R4'

        // Render Expert Insights - Uses custom CSS classes from app.css
        async function renderExperts() {
            if (!expertDiscussions) {
                await loadExpertDiscussions();
            }

            // Filter and organize comments - show ALL comments, not just those with expert analysis
            const allComments = getAllComments();
            let allCommentIds = allComments.map(c => c.id);

            // Get dynamic experts by extracting from all discussions
            const dynamicExperts = extractDynamicExperts();

            // Apply filter based on actual comment data (not expert discussion data)
            let filteredIds = allCommentIds;
            if (expertFilter === 'major') {
                filteredIds = allCommentIds.filter(id => {
                    const comment = allComments.find(c => c.id === id);
                    return comment?.type === 'major';
                });
            } else if (expertFilter === 'minor') {
                filteredIds = allCommentIds.filter(id => {
                    const comment = allComments.find(c => c.id === id);
                    return comment?.type === 'minor';
                });
            } else if (expertFilter.startsWith('R')) {
                filteredIds = allCommentIds.filter(k => k.startsWith(expertFilter));
            }

            // Sort by comment ID
            filteredIds.sort((a, b) => {
                const ra = a.match(/R(\d+)-(\d+)/);
                const rb = b.match(/R(\d+)-(\d+)/);
                if (ra && rb) {
                    if (ra[1] !== rb[1]) return parseInt(ra[1]) - parseInt(rb[1]);
                    return parseInt(ra[2]) - parseInt(rb[2]);
                }
                return a.localeCompare(b);
            });

            // Count stats from actual comments
            const majorCount = allComments.filter(c => c.type === 'major').length;
            const minorCount = allComments.filter(c => c.type === 'minor').length;
            const withExpertCount = allCommentIds.filter(id => expertDiscussions?.expert_discussions?.[id]?.experts?.length > 0).length;

            // Count reviewers dynamically
            const reviewerIds = [...new Set(allCommentIds.map(id => id.split('-')[0]))].sort();
            const reviewerCounts = {};
            reviewerIds.forEach(rid => {
                reviewerCounts[rid] = allCommentIds.filter(k => k.startsWith(rid)).length;
            });

            // Build dynamic experts panel HTML
            let dynamicExpertsHtml = '';
            if (dynamicExperts.length > 0) {
                const expertColors = ['purple', 'blue', 'green', 'orange', 'cyan', 'red'];
                dynamicExpertsHtml = `
                    <div class="dynamic-experts-panel">
                        <div class="dynamic-experts-header">
                            <div class="dynamic-experts-title">
                                <i class="fas fa-brain"></i>
                                AI-Generated Expert Panel
                            </div>
                            <span class="dynamic-experts-badge">${dynamicExperts.length} experts</span>
                        </div>
                        <div class="dynamic-experts-body">
                            ${dynamicExperts.map((expert, idx) => {
                                const color = expertColors[idx % expertColors.length];
                                const icon = iconMap[expert.icon] || 'fa-user-graduate';
                                const bgStyle = colorMap[color] ? '' : 'background: linear-gradient(135deg, #9333ea, #7c3aed);';
                                return `
                                    <div class="dynamic-expert-item">
                                        <div class="dynamic-expert-icon" style="${bgStyle || `background: linear-gradient(135deg, ${getColorGradient(color)});`}">
                                            <i class="fas ${icon}"></i>
                                        </div>
                                        <div class="dynamic-expert-info">
                                            <div class="dynamic-expert-name">${expert.name}</div>
                                            <div class="dynamic-expert-expertise">${expert.description || (Array.isArray(expert.expertise) && expert.expertise.length > 0 ? expert.expertise.join(', ') : `Analyzed ${expert.comments?.length || 0} comments`)}</div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }

            // Build discussion cards
            let discussionCards = '';
            for (const commentId of filteredIds) {
                const disc = expertDiscussions?.expert_discussions?.[commentId];
                const comment = allComments.find(c => c.id === commentId);
                if (!comment) continue;

                // Use expert discussion data if available, otherwise fall back to comment data
                const priority = disc?.priority || comment.priority || 'medium';
                const type = disc?.type || comment.type || 'minor';
                const category = disc?.category || comment.category || 'General';
                const reviewerComment = disc?.reviewer_comment || comment.original_text || '';
                const fullContext = disc?.full_context || comment.full_context || '';

                const priorityClass = priority === 'high' ? 'priority-high' :
                                     priority === 'medium' ? 'priority-medium' : 'priority-low';
                const priorityBadge = priority === 'high'
                    ? '<span class="badge badge-danger">HIGH</span>'
                    : priority === 'medium'
                    ? '<span class="badge badge-warning">MEDIUM</span>'
                    : '<span class="badge badge-success">LOW</span>';
                const typeBadge = type === 'major'
                    ? '<span class="badge badge-danger">MAJOR</span>'
                    : '<span class="badge badge-secondary">MINOR</span>';

                let expertsHtml = '';
                if (disc?.experts && disc.experts.length > 0) {
                    expertsHtml = '<div class="experts-grid">';
                    for (const expert of disc.experts) {
                        const colorClass = colorMap[expert.color]?.cssClass || 'expert-blue';
                        const icon = iconMap[expert.icon] || 'fa-user';

                        expertsHtml += `
                            <div class="expert-card ${colorClass}">
                                <div class="expert-card-header">
                                    <i class="fas ${icon}"></i>
                                    <span class="expert-name">${expert.name || 'Expert'}</span>
                                </div>
                                <div class="expert-card-body">
                                    <div class="expert-verdict">
                                        <strong>Verdict:</strong> ${makeCommentIdsClickable(expert.verdict || '')}
                                    </div>
                                    ${expert.assessment ? `
                                        <div class="expert-assessment">
                                            <strong>Assessment:</strong> ${makeCommentIdsClickable(expert.assessment || '')}
                                        </div>
                                    ` : (expert.data_analysis ? `
                                        <div class="expert-data-analysis">
                                            <strong>Data Analysis:</strong>
                                            ${Array.isArray(expert.data_analysis)
                                                ? `<ul>${expert.data_analysis.map(d => `<li>${makeCommentIdsClickable(d || '')}</li>`).join('')}</ul>`
                                                : makeCommentIdsClickable(expert.data_analysis || '')}
                                        </div>
                                    ` : '')}
                                    <div class="expert-recommendation">
                                        <strong>Recommendation:</strong> ${makeCommentIdsClickable(expert.recommendation || '')}
                                    </div>
                                    ${expert.key_data_points && expert.key_data_points.length > 0 ? `
                                        <div class="expert-data-points">
                                            ${expert.key_data_points.map(p => `<span class="expert-data-point">${makeCommentIdsClickable(p || '')}</span>`).join('')}
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                        `;
                    }
                    expertsHtml += '</div>';
                } else {
                    expertsHtml = `
                        <div class="no-expert-message">
                            <p>No expert analysis generated yet for this comment.</p>
                            <button onclick="regenerateExpertForComment('${commentId}')" class="btn btn-sm btn-primary mt-2">
                                <i class="fas fa-wand-magic-sparkles"></i> Generate Expert Analysis
                            </button>
                        </div>
                    `;
                }

                discussionCards += `
                    <div class="discussion-card ${priorityClass}" id="expert-${commentId}">
                        <div class="discussion-header">
                            <div class="discussion-header-top">
                                <div class="discussion-badges">
                                    <a href="javascript:void(0)" class="discussion-id comment-link" onclick="navigateToComment('${commentId}')" title="Open ${commentId} in Response Builder">${commentId}</a>
                                    ${typeBadge}
                                    ${priorityBadge}
                                    <span class="badge badge-purple">${category}</span>
                                </div>
                                <div class="discussion-actions">
                                    <button onclick="regenerateExpertForComment('${commentId}')" class="btn btn-sm btn-ghost" title="${disc?.experts?.length ? 'Regenerate' : 'Generate'} expert analysis">
                                        <i class="fas fa-${disc?.experts?.length ? 'sync-alt' : 'wand-magic-sparkles'}"></i>
                                    </button>
                                    <button onclick="copyResponse('${commentId}')" class="btn btn-sm btn-ghost" ${!disc?.recommended_response ? 'disabled' : ''}>
                                        <i class="fas fa-copy"></i> Copy
                                    </button>
                                    <button onclick="useExpertResponse('${commentId}')" class="btn btn-sm btn-success" ${!disc?.recommended_response ? 'disabled' : ''}>
                                        <i class="fas fa-check"></i> Use
                                    </button>
                                </div>
                            </div>
                            <p class="discussion-comment">"${reviewerComment}"</p>
                            ${fullContext ? `<p class="discussion-context">${fullContext}</p>` : ''}
                        </div>
                        <div class="discussion-body">
                            ${disc?.experts && disc.experts.length > 0 ? `
                                <h4 class="discussion-experts-title">
                                    <i class="fas fa-users"></i>
                                    Expert Panel Discussion (${disc.experts.length} expert${disc.experts.length > 1 ? 's' : ''})
                                </h4>
                            ` : ''}
                            ${expertsHtml}
                            ${disc?.potential_solutions && disc.potential_solutions.length > 0 ? `
                            <div class="potential-solutions">
                                <h5 class="potential-solutions-title">
                                    <i class="fas fa-lightbulb"></i>
                                    Potential Solutions
                                </h5>
                                <div class="solutions-grid">
                                    ${disc.potential_solutions.map((sol, idx) => `
                                        <div class="solution-card ${idx === 0 ? 'recommended' : ''}" data-comment="${commentId}" data-idx="${idx}">
                                            <div class="solution-header">
                                                <span class="solution-title">${sol.title}</span>
                                                <span class="solution-effort effort-${sol.effort}">${sol.effort}</span>
                                            </div>
                                            <p class="solution-text">${makeCommentIdsClickable(sol.response)}</p>
                                            <button onclick="useSolution('${commentId}', ${idx})" class="btn btn-sm ${idx === 0 ? 'btn-success' : 'btn-secondary'}">
                                                <i class="fas fa-check"></i> Use This
                                            </button>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                            ` : disc?.recommended_response ? `
                            <div class="recommended-response">
                                <h5 class="recommended-response-title">
                                    <i class="fas fa-check-circle"></i>
                                    Recommended Response
                                </h5>
                                <p class="recommended-response-text" id="response-${commentId}">${makeCommentIdsClickable(disc.recommended_response)}</p>
                            </div>
                            ` : ''}
                            ${disc?.advice_to_author ? `
                                <div class="advice-box">
                                    <h5 class="advice-box-title">
                                        <i class="fas fa-user-edit"></i>
                                        Advice to Author
                                    </h5>
                                    <p class="advice-box-text">${makeCommentIdsClickable(disc.advice_to_author || '')}</p>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
            }

            const html = `
                <!-- Expert Insights Banner (matching Overview style) -->
                <div class="manuscript-banner">
                    <div class="manuscript-banner-content">
                        <div class="manuscript-banner-main">
                            <h3 class="manuscript-banner-title">
                                <i class="fas fa-microscope"></i> Expert Analysis
                            </h3>
                            <p class="manuscript-banner-field">AI-generated expert insights for ${allCommentIds.length} comments</p>
                        </div>
                        <div class="manuscript-banner-stats">
                            <div class="manuscript-banner-stat-value">${dynamicExperts.length}</div>
                            <div class="manuscript-banner-stat-label">Experts</div>
                        </div>
                    </div>
                    <div class="manuscript-banner-categories">
                        <div class="manuscript-banner-cat-tags">
                            <button onclick="regenerateAllExpertAnalysis()" class="btn btn-sm">
                                <i class="fas fa-sync-alt"></i> Regenerate All
                            </button>
                            <button onclick="regenerateExpertForComment()" class="btn btn-sm">
                                <i class="fas fa-wand-magic-sparkles"></i> Regenerate Single
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Dynamic Experts Panel -->
                ${dynamicExpertsHtml}

                <!-- Stats Grid -->
                <div class="expert-stats-grid">
                    <div class="expert-stat-card">
                        <div class="expert-stat-value">${allCommentIds.length}</div>
                        <div class="expert-stat-label">Total Comments</div>
                    </div>
                    <div class="expert-stat-card">
                        <div class="expert-stat-value" style="color: var(--sage);">${withExpertCount}</div>
                        <div class="expert-stat-label">With Analysis</div>
                    </div>
                    <div class="expert-stat-card">
                        <div class="expert-stat-value" style="color: var(--rust);">${majorCount}</div>
                        <div class="expert-stat-label">Major</div>
                    </div>
                    <div class="expert-stat-card">
                        <div class="expert-stat-value" style="color: var(--ink-muted);">${minorCount}</div>
                        <div class="expert-stat-label">Minor</div>
                    </div>
                    <div class="expert-stat-card">
                        <div class="expert-stat-value" style="color: var(--purple);">${dynamicExperts.length}</div>
                        <div class="expert-stat-label">Experts</div>
                    </div>
                </div>

                <!-- Reviewer Summary -->
                <div class="reviewer-summary">
                    <h4 class="reviewer-summary-title">
                        <i class="fas fa-users"></i>
                        Reviewer Summary
                    </h4>
                    <div class="reviewer-cards">
                        ${reviewData?.reviewers?.map((r, i) => `
                        <div class="reviewer-card" onclick="setExpertFilter('${r.id}')">
                            <div class="reviewer-card-name">${r.name}</div>
                            <div class="reviewer-card-meta">${r.expertise || 'Reviewer'} - ${r.comments?.length || 0} comments</div>
                        </div>
                        `).join('') || reviewerIds.map(rid => `
                        <div class="reviewer-card" onclick="setExpertFilter('${rid}')">
                            <div class="reviewer-card-name">${rid}</div>
                            <div class="reviewer-card-meta">${reviewerCounts[rid]} comments</div>
                        </div>
                        `).join('') || '<p class="text-muted">No reviewer data loaded</p>'}
                    </div>
                </div>

                <!-- Filter Controls -->
                <div class="expert-filters">
                    <h4 class="expert-filters-title">
                        <i class="fas fa-filter"></i>
                        Filter Expert Discussions
                    </h4>
                    <div class="filter-buttons">
                        <button onclick="setExpertFilter('all')" class="filter-btn ${expertFilter === 'all' ? 'active' : ''}">
                            All (${allCommentIds.length})
                        </button>
                        <button onclick="setExpertFilter('major')" class="filter-btn ${expertFilter === 'major' ? 'active-red' : ''}">
                            Major (${majorCount})
                        </button>
                        <button onclick="setExpertFilter('minor')" class="filter-btn ${expertFilter === 'minor' ? 'active' : ''}">
                            Minor (${minorCount})
                        </button>
                        <span class="filter-divider"></span>
                        ${reviewerIds.map(rid => `
                            <button onclick="setExpertFilter('${rid}')" class="filter-btn ${expertFilter === rid ? 'active-blue' : ''}">
                                ${rid} (${reviewerCounts[rid]})
                            </button>
                        `).join('')}
                    </div>
                </div>

                <!-- Quick Navigation -->
                <div class="expert-quick-nav">
                    <h4 class="expert-quick-nav-title">
                        <i class="fas fa-list"></i>
                        Quick Navigation (${filteredIds.length} comments)
                    </h4>
                    <div class="quick-nav-links">
                        ${filteredIds.map(id => {
                            const d = expertDiscussions.expert_discussions[id];
                            const majorClass = d?.type === 'major' ? 'major' : '';
                            return `<a href="#expert-${id}" class="quick-nav-link ${majorClass}">${id}</a>`;
                        }).join('')}
                    </div>
                </div>

                <!-- Expert Discussions by Comment -->
                <h3 class="section-title mb-4">
                    <i class="fas fa-comments" style="color: #9333ea;"></i>
                    Expert Discussions (${filteredIds.length} comments)
                </h3>
                ${discussionCards || '<p class="text-muted">Loading expert discussions...</p>'}

                <!-- Bulk Actions -->
                <div class="bulk-actions">
                    <h4 class="bulk-actions-title">Bulk Actions</h4>
                    <div class="bulk-actions-buttons">
                        <button onclick="copyAllResponses()" class="btn btn-primary">
                            <i class="fas fa-copy"></i> Copy All Responses
                        </button>
                        <button onclick="exportExpertReport()" class="btn btn-success">
                            <i class="fas fa-file-alt"></i> Export Report
                        </button>
                        <button onclick="applyAllResponses()" class="btn btn-secondary">
                            <i class="fas fa-check-double"></i> Apply All to Draft
                        </button>
                    </div>
                </div>
            `;
            document.getElementById('content-area').innerHTML = html;
        }

        // Helper function for expert color gradients
        function getColorGradient(color) {
            const gradients = {
                'blue': '#3b82f6, #2563eb',
                'red': '#ef4444, #dc2626',
                'green': '#22c55e, #16a34a',
                'purple': '#a855f7, #9333ea',
                'orange': '#f97316, #ea580c',
                'cyan': '#06b6d4, #0891b2',
                'brown': '#d97706, #b45309',
                'gray': '#6b7280, #4b5563'
            };
            return gradients[color] || gradients.purple;
        }

        function setExpertFilter(filter) {
            expertFilter = filter;
            renderExperts();
        }

        // Regenerate expert analysis for a single comment using OpenCode
        // Build manuscript context for expert analysis prompts
        function buildManuscriptContextForExperts() {
            const manuscript = reviewData?.manuscript || {};
            const manuscriptData = reviewData?.manuscript_data || {};
            const categories = manuscriptData.categories || [];
            const thematicGroups = manuscriptData.thematic_groups || [];

            // Get comment statistics
            const allComments = getAllComments();
            const reviewerCount = reviewData?.reviewers?.length || 0;
            const majorCount = allComments.filter(c => c.type === 'major').length;
            const minorCount = allComments.filter(c => c.type === 'minor').length;

            let context = `MANUSCRIPT: "${manuscript.title || 'Untitled'}"
AUTHORS: ${manuscript.authors || 'Unknown'}
FIELD: ${manuscript.field || 'Not specified'}

REVIEW STATISTICS:
- ${reviewerCount} reviewers
- ${allComments.length} total comments (${majorCount} major, ${minorCount} minor)
${categories.length > 0 ? `- Categories: ${categories.join(', ')}` : ''}
${thematicGroups.length > 0 ? `- Thematic groups: ${thematicGroups.map(g => g.name || g).join(', ')}` : ''}`;

            // Add any key data points from manuscript_data if available
            if (manuscriptData.key_statistics) {
                context += `\n\nKEY DATA POINTS:\n`;
                for (const [key, value] of Object.entries(manuscriptData.key_statistics)) {
                    context += `- ${key}: ${value}\n`;
                }
            }

            return context;
        }

        // Get expert types based on comment category
        function getRelevantExpertTypes(category) {
            const expertsByCategory = {
                'Authentication': ['DNA Damage Expert', 'Contamination Expert', 'Geochronology Expert'],
                'Methods': ['Bioinformatics Expert', 'Statistics Expert', 'Methodology Expert'],
                'Analysis': ['Data Analysis Expert', 'Bioinformatics Expert', 'Visualization Expert'],
                'Interpretation': ['Domain Expert', 'Scientific Communication Expert', 'Ecology Expert'],
                'Terminology': ['Scientific Communication Expert', 'Domain Expert'],
                'Novelty': ['Literature Expert', 'Domain Expert', 'Scientific Communication Expert'],
                'Clarity': ['Scientific Communication Expert', 'Technical Writing Expert'],
                'Figure': ['Visualization Expert', 'Data Presentation Expert'],
                'Citation': ['Literature Expert'],
                'Formatting': ['Technical Writing Expert'],
                'Accuracy': ['Domain Expert', 'Fact-Checking Expert'],
                'Validation': ['Methods Expert', 'Statistics Expert', 'Quality Control Expert'],
                'Database': ['Bioinformatics Expert', 'Data Management Expert'],
                'Results': ['Data Analysis Expert', 'Statistics Expert', 'Domain Expert'],
                'Discussion': ['Domain Expert', 'Scientific Communication Expert'],
                'Focus': ['Scientific Communication Expert', 'Editorial Expert']
            };

            return expertsByCategory[category] || ['Domain Expert', 'Methodology Expert'];
        }

        async function regenerateExpertForComment(commentId = null) {
            // If no ID provided, prompt user
            if (!commentId) {
                const allIds = Object.keys(expertDiscussions?.expert_discussions || {});
                commentId = prompt('Enter comment ID to regenerate (e.g., R1-1):', allIds[0] || 'R1-1');
                if (!commentId) return;
            }

            const comment = getAllComments().find(c => c.id === commentId);
            if (!comment) {
                showNotification(`Comment ${commentId} not found`, 'error');
                return;
            }

            // Show loading indicator using centralized system
            showOpenCodeLoading(`expert-${commentId}`, `Generating expert analysis for ${commentId}...`);

            // Build context-aware prompt
            const manuscriptContext = buildManuscriptContextForExperts();
            const suggestedExperts = getRelevantExpertTypes(comment.category);

            const expertPrompt = `You are a panel of domain experts analyzing this reviewer comment for a scientific manuscript.

${manuscriptContext}

---

COMMENT TO ANALYZE:
ID: ${commentId}
REVIEWER: ${comment.reviewer}
TYPE: ${comment.type.toUpperCase()} (${comment.priority} priority)
CATEGORY: ${comment.category}
${comment.location ? `LOCATION: ${comment.location}` : ''}

REVIEWER'S COMMENT:
"${comment.original_text}"

${comment.full_context ? `ADDITIONAL CONTEXT: ${comment.full_context}` : ''}

---

TASK: Provide multi-expert analysis. Consider using experts like: ${suggestedExperts.join(', ')}

Return your analysis in this exact JSON format:

{
  "experts": [
    {
      "name": "Expert Title (e.g., DNA Damage Authentication Expert)",
      "icon": "dna",
      "color": "blue",
      "verdict": "AGREE/DISAGREE/PARTIALLY AGREE - brief summary of position",
      "assessment": "2-3 sentence detailed assessment of the reviewer's point and its validity",
      "data_analysis": [
        "Specific finding or data point 1",
        "Specific finding or data point 2",
        "Specific finding or data point 3"
      ],
      "recommendation": "Concrete action to take in response",
      "key_data_points": ["stat1", "stat2", "stat3"]
    }
  ],
  "recommended_response": "A complete, professional draft response (2-4 paragraphs) that thanks the reviewer, addresses their concern with specific data, and explains what actions were taken. Use past tense for completed actions.",
  "advice_to_author": "Strategic meta-advice on tone, framing, and what to emphasize when responding to this comment"
}

GUIDELINES:
- Include 1-3 experts based on topic complexity
- Use specific numbers/data when available
- For valid criticisms: agree graciously and explain fixes
- For misunderstandings: respectfully clarify with evidence
- Icons: dna, flask, code, tree, leaf, mountain, shield-virus, cogs, pen, globe, code-branch, chart-bar
- Colors: blue, green, red, orange, purple, cyan, brown, gray`;

            try {
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: expertPrompt,
                        comment_id: `regenerate-expert-${commentId}`,
                        model: aiSettings.model,
                        agent: aiSettings.agent,
                        variant: aiSettings.variant
                    })
                });

                if (response.ok) {
                    const result = await response.json();

                    // Try to parse JSON from response
                    try {
                        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const newExpertData = JSON.parse(jsonMatch[0]);

                            // Update the expert discussions
                            if (!expertDiscussions) expertDiscussions = { expert_discussions: {} };

                            expertDiscussions.expert_discussions[commentId] = {
                                ...expertDiscussions.expert_discussions[commentId],
                                reviewer_comment: comment.original_text,
                                full_context: comment.full_context || '',
                                priority: comment.priority,
                                type: comment.type,
                                category: comment.category,
                                experts: newExpertData.experts || [],
                                recommended_response: newExpertData.recommended_response || '',
                                advice_to_author: newExpertData.advice_to_author || '',
                                potential_solutions: newExpertData.potential_solutions || [],
                                regenerated_at: new Date().toISOString()
                            };

                            // Save and re-render
                            await saveExpertDiscussions();
                            syncExpertDataWithComments(); // Sync to keep all views consistent
                            renderExperts();
                            hideOpenCodeLoading(`expert-${commentId}`, { success: true, message: `Expert analysis regenerated for ${commentId}` });
                        } else {
                            hideOpenCodeLoading(`expert-${commentId}`, { success: false, message: 'Could not parse expert analysis' });
                            console.log('Raw response:', result.response);
                        }
                    } catch (parseError) {
                        hideOpenCodeLoading(`expert-${commentId}`, { success: false, message: 'Error parsing response' });
                        console.log('Parse error, raw response:', result.response);
                    }
                } else {
                    hideOpenCodeLoading(`expert-${commentId}`, { success: false, message: 'Failed to regenerate' });
                }
            } catch (e) {
                hideOpenCodeLoading(`expert-${commentId}`, { success: false, message: e.message });
            }
        }

        // Regenerate expert analysis for ALL comments (batch process)
        async function regenerateAllExpertAnalysis() {
            // Context check removed - OpenCode session may already have context loaded externally

            const allComments = getAllComments();
            const confirm = window.confirm(`This will regenerate expert analysis for all ${allComments.length} comments using OpenCode. This may take several minutes. Continue?`);
            if (!confirm) return;

            // Show progress modal
            const modal = document.createElement('div');
            modal.id = 'regenerate-progress-modal';
            modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
                    <h3 class="font-bold text-lg mb-4">Regenerating Expert Analysis</h3>
                    <div class="mb-4">
                        <div class="w-full bg-gray-200 rounded-full h-3">
                            <div id="regen-progress-bar" class="bg-emerald-600 h-3 rounded-full transition-all" style="width: 0%"></div>
                        </div>
                        <p id="regen-progress-text" class="text-sm text-gray-600 mt-2">Starting...</p>
                    </div>
                    <div id="regen-log" class="max-h-40 overflow-y-auto text-xs text-gray-500 bg-gray-50 rounded p-2 font-mono"></div>
                    <button onclick="document.getElementById('regenerate-progress-modal')?.remove()" class="mt-4 w-full py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
                        Close (regeneration continues in background)
                    </button>
                </div>
            `;
            document.body.appendChild(modal);

            const progressBar = document.getElementById('regen-progress-bar');
            const progressText = document.getElementById('regen-progress-text');
            const logEl = document.getElementById('regen-log');

            const addLog = (msg) => {
                logEl.innerHTML += msg + '<br>';
                logEl.scrollTop = logEl.scrollHeight;
            };

            let completed = 0;
            let failed = 0;

            for (let i = 0; i < allComments.length; i++) {
                const comment = allComments[i];
                const progress = ((i + 1) / allComments.length * 100).toFixed(0);

                progressBar.style.width = progress + '%';
                progressText.textContent = `Processing ${comment.id} (${i + 1}/${allComments.length})`;
                addLog(`→ ${comment.id}...`);

                try {
                    await regenerateExpertForCommentSilent(comment);
                    addLog(`✓ ${comment.id} done`);
                    completed++;
                } catch (e) {
                    addLog(`✗ ${comment.id} failed: ${e.message}`);
                    failed++;
                }

                // Small delay to avoid overwhelming the API
                await new Promise(r => setTimeout(r, 500));
            }

            progressText.textContent = `Complete! ${completed} regenerated, ${failed} failed`;
            addLog(`\n=== DONE ===`);
            showNotification(`Regenerated ${completed}/${allComments.length} expert analyses`, completed === allComments.length ? 'success' : 'warning');
            syncExpertDataWithComments(); // Sync to keep all views consistent
            renderExperts();
        }

        // Silent version for batch processing
        async function regenerateExpertForCommentSilent(comment) {
            const manuscriptContext = buildManuscriptContextForExperts();
            const suggestedExperts = getRelevantExpertTypes(comment.category);

            const batchPrompt = `Expert panel analysis for reviewer comment on scientific manuscript.

${manuscriptContext}

COMMENT: ${comment.id} (${comment.type.toUpperCase()}, ${comment.priority} priority)
CATEGORY: ${comment.category}
${comment.location ? `LOCATION: ${comment.location}` : ''}

"${comment.original_text}"

${comment.full_context ? `CONTEXT: ${comment.full_context}` : ''}

Consider experts like: ${suggestedExperts.join(', ')}

Return JSON:
{
  "experts": [{"name": "Expert Title", "icon": "dna/flask/code/tree/leaf/cogs/pen", "color": "blue/green/red/orange/purple", "verdict": "AGREE/DISAGREE - summary", "assessment": "Detailed assessment", "data_analysis": ["Point 1", "Point 2"], "recommendation": "Action to take", "key_data_points": ["stat1", "stat2"]}],
  "recommended_response": "Professional 2-4 paragraph response thanking reviewer, addressing concern with data, explaining actions taken (past tense)",
  "advice_to_author": "Strategic advice on tone and framing"
}

Use 1-3 experts. Be specific with data. For valid criticisms: agree graciously. For misunderstandings: clarify respectfully.`;

            const response = await fetch(`${API_BASE}/ask`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: batchPrompt,
                    comment_id: `regen-${comment.id}`,
                    model: aiSettings.model,
                    agent: aiSettings.agent,
                    variant: aiSettings.variant
                })
            });

            if (!response.ok) throw new Error('API request failed');

            const result = await response.json();
            const jsonMatch = result.response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON in response');

            const newExpertData = JSON.parse(jsonMatch[0]);

            if (!expertDiscussions) expertDiscussions = { expert_discussions: {} };

            expertDiscussions.expert_discussions[comment.id] = {
                reviewer_comment: comment.original_text,
                full_context: comment.full_context || '',
                priority: comment.priority,
                type: comment.type,
                category: comment.category,
                experts: newExpertData.experts || [],
                recommended_response: newExpertData.recommended_response || '',
                advice_to_author: newExpertData.advice_to_author || '',
                potential_solutions: newExpertData.potential_solutions || [],
                regenerated_at: new Date().toISOString()
            };

            // Auto-save after batch update
            await saveExpertDiscussions();
        }

        // Save expert discussions to localStorage and optionally to server
        async function saveExpertDiscussions() {
            if (!expertDiscussions) return;

            // Save to localStorage
            try {
                localStorage.setItem('expertDiscussions', JSON.stringify(expertDiscussions));
                console.log('Expert discussions saved to localStorage');
            } catch (e) {
                console.error('Failed to save expert discussions to localStorage:', e);
            }

            // Also try to save to server if available
            try {
                const response = await fetch(`${API_BASE}/expert-discussions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(expertDiscussions)
                });
                if (response.ok) {
                    console.log('Expert discussions saved to server');
                }
            } catch (e) {
                // Server save is optional, don't show error
                console.log('Server save not available, using localStorage only');
            }
        }

        // Load expert discussions from localStorage on startup
        function loadExpertDiscussionsFromStorage() {
            try {
                const saved = localStorage.getItem('expertDiscussions');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed && parsed.expert_discussions) {
                        // Return the data instead of setting it (let caller decide)
                        return parsed;
                    }
                }
            } catch (e) {
                console.error('Failed to load expert discussions from localStorage:', e);
            }
            return null;
        }

        function useExpertResponse(commentId) {
            if (!expertDiscussions || !expertDiscussions.expert_discussions[commentId]) {
                showNotification('No expert response available for this comment', 'error');
                return;
            }

            const disc = expertDiscussions.expert_discussions[commentId];
            if (!disc.recommended_response) {
                showNotification('No recommended response generated yet', 'warning');
                return;
            }

            // Find the matching comment in reviewData
            for (const reviewer of reviewData.reviewers) {
                const comment = reviewer.comments.find(c => c.id === commentId);
                if (comment) {
                    comment.draft_response = disc.recommended_response;
                    comment.status = 'in_progress';
                    saveProgress();
                    showNotification(`Response applied to ${commentId}`, 'success');
                    // Refresh the current view to show updated status
                    setView(currentView);
                    return;
                }
            }
            showNotification('Comment not found', 'error');
        }

        // Use a specific solution from the potential_solutions array
        function useSolution(commentId, solutionIndex) {
            if (!expertDiscussions || !expertDiscussions.expert_discussions[commentId]) {
                showNotification('No solutions available for this comment', 'error');
                return;
            }

            const disc = expertDiscussions.expert_discussions[commentId];
            const solutions = disc.potential_solutions || [];

            if (solutionIndex >= solutions.length) {
                showNotification('Solution not found', 'error');
                return;
            }

            const solution = solutions[solutionIndex];

            // Find the matching comment in reviewData
            for (const reviewer of reviewData.reviewers) {
                const comment = reviewer.comments.find(c => c.id === commentId);
                if (comment) {
                    comment.draft_response = solution.response;
                    comment.status = 'in_progress';
                    saveProgress();
                    showNotification(`"${solution.title}" applied to ${commentId}`, 'success');
                    // Refresh the current view to show updated status
                    setView(currentView);
                    return;
                }
            }
            showNotification('Comment not found', 'error');
        }

        // Toggle AI solution checkbox in the Edit modal
        function toggleSolutionAI(commentId, solutionIndex) {
            const aiSolutions = expertDiscussions?.expert_discussions?.[commentId]?.potential_solutions || [];

            // Find the comment to update actions_taken
            for (const reviewer of reviewData.reviewers) {
                const comment = reviewer.comments.find(c => c.id === commentId);
                if (comment) {
                    if (!comment.actions_taken) comment.actions_taken = [];

                    // Get the solution text
                    const sol = aiSolutions[solutionIndex] || comment.potential_solutions?.[solutionIndex];
                    const solText = typeof sol === 'string' ? sol : (sol?.title || sol?.response || '');

                    if (comment.actions_taken.includes(solText)) {
                        comment.actions_taken = comment.actions_taken.filter(a => a !== solText);
                    } else {
                        comment.actions_taken.push(solText);
                    }

                    // Update display
                    updateActionsTakenDisplay(comment);
                    saveProgress();
                    return;
                }
            }
        }

        // Use AI solution in the Edit modal - copies response to draft textarea
        function useAiSolution(commentId, solutionIndex) {
            const aiSolutions = expertDiscussions?.expert_discussions?.[commentId]?.potential_solutions || [];

            if (solutionIndex >= aiSolutions.length) {
                showNotification('Solution not found', 'error');
                return;
            }

            const solution = aiSolutions[solutionIndex];

            // Find the draft textarea in the modal and set the response
            const draftTextarea = document.getElementById('draft-response');
            if (draftTextarea) {
                draftTextarea.value = solution.response;
                showNotification(`"${solution.title}" applied to draft`, 'success');
            } else {
                // Fallback: directly update the comment
                for (const reviewer of reviewData.reviewers) {
                    const comment = reviewer.comments.find(c => c.id === commentId);
                    if (comment) {
                        comment.draft_response = solution.response;
                        comment.status = 'in_progress';
                        saveProgress();
                        showNotification(`"${solution.title}" applied to ${commentId}`, 'success');
                        return;
                    }
                }
            }
        }

        function copyAllResponses() {
            if (!expertDiscussions) return;

            let allResponses = '';
            const ids = Object.keys(expertDiscussions.expert_discussions).sort();

            for (const id of ids) {
                const disc = expertDiscussions.expert_discussions[id];
                allResponses += `=== ${id} ===\n${disc.recommended_response}\n\n`;
            }

            navigator.clipboard.writeText(allResponses).then(() => {
                alert('All responses copied to clipboard!');
            });
        }

        function applyAllResponses() {
            if (!expertDiscussions || !confirm('This will apply all expert responses as drafts. Continue?')) return;

            let applied = 0;
            for (const reviewer of reviewData.reviewers) {
                for (const comment of reviewer.comments) {
                    const disc = expertDiscussions.expert_discussions[comment.id];
                    if (disc && disc.recommended_response) {
                        comment.draft_response = disc.recommended_response;
                        if (comment.status === 'pending') comment.status = 'in_progress';
                        applied++;
                    }
                }
            }

            saveProgress();
            updateSidebar();
            alert(`Applied ${applied} expert responses as drafts!`);
        }

        function exportExpertReport() {
            if (!expertDiscussions) return;

            let report = '# Expert Review Analysis Report\n\n';
            report += `Generated: ${new Date().toISOString()}\n\n`;
            report += '## Data Summary\n';
            report += `- Taxonomic entries: ${expertDiscussions.data_sources.taxonomic_entries}\n`;
            report += `- Mean damage (ancient): ${(expertDiscussions.data_sources.mean_damage_ancient * 100).toFixed(1)}%\n`;
            report += `- Mean damage (controls): ${(expertDiscussions.data_sources.mean_damage_controls * 100).toFixed(1)}%\n`;
            report += `- Differential: ${expertDiscussions.data_sources.damage_differential}x\n\n`;

            const ids = Object.keys(expertDiscussions.expert_discussions).sort();
            for (const id of ids) {
                const disc = expertDiscussions.expert_discussions[id];
                report += `## ${id} (${disc.type}, ${disc.priority} priority)\n\n`;
                report += `**Reviewer Comment:** ${disc.reviewer_comment}\n\n`;
                report += `**Category:** ${disc.category}\n\n`;
                if (disc.experts && disc.experts.length > 0) {
                    report += '**Expert Analysis:**\n';
                    for (const e of disc.experts) {
                        report += `- ${e.name}: ${e.verdict}\n`;
                    }
                    report += '\n';
                }
                report += `**Recommended Response:**\n${disc.recommended_response}\n\n`;
                if (disc.advice_to_author) {
                    report += `**Advice:** ${disc.advice_to_author}\n\n`;
                }
                report += '---\n\n';
            }

            const blob = new Blob([report], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'expert_review_report.md';
            a.click();
            URL.revokeObjectURL(url);
        }

        function copyResponse(commentId) {
            const el = document.getElementById('response-' + commentId);
            if (el) {
                navigator.clipboard.writeText(el.textContent).then(() => {
                    alert('Response copied to clipboard!');
                });
            }
        }

        // =====================================================
        // TASK QUEUE - AI-OPTIMIZED PRODUCTIVITY ORDER
        // =====================================================
        // Uses AI/OpenCode to determine optimal task order based on:
        // - Productivity psychology (momentum, energy management)
        // - Task dependencies and complexity
        // - Quick wins vs deep work balance

        let taskOrderCache = null; // Cache AI-generated order
        let isOptimizingTasks = false;

        async function getAIOptimizedTaskOrder(comments) {
            if (isOptimizingTasks) return comments; // Prevent concurrent calls

            const pendingComments = comments.filter(c => c.status !== 'completed');
            if (pendingComments.length === 0) return comments;

            // Check if we already have AI-generated order in cache
            if (taskOrderCache && taskOrderCache.length === pendingComments.length) {
                return applyAIOrder(pendingComments, taskOrderCache);
            }

            isOptimizingTasks = true;

            try {
                const taskSummaries = pendingComments.map(c => ({
                    id: c.id,
                    type: c.type,
                    priority: c.priority,
                    category: c.category,
                    location: c.location,
                    requires_analysis: c.requires_new_analysis,
                    text_preview: (c.original_text || '').substring(0, 100)
                }));

                const prompt = `You are a productivity expert helping a researcher respond to peer review comments.

ORDER these ${taskSummaries.length} tasks for OPTIMAL PRODUCTIVITY using research-backed strategies:

## PRODUCTIVITY PRINCIPLES TO APPLY:
1. **Quick Wins First (2-3 tasks)**: Start with minor/easy tasks to build momentum and confidence
2. **Peak Energy Tasks Next**: Major/high-priority items when motivation is established
3. **Batch Similar Work**: Group related categories together (e.g., all Figure tasks, all Methods tasks)
4. **Analysis Tasks Together**: Items requiring new analysis should be batched
5. **End with Low Stakes**: Save low-priority minor items for the end when energy wanes

## TASKS TO ORDER:
${JSON.stringify(taskSummaries, null, 2)}

## OUTPUT FORMAT:
Return ONLY a JSON array of task IDs in the recommended order, with a brief reason for each position.
Example: [{"id": "R1-5", "reason": "Quick formatting fix - build momentum"}, {"id": "R2-1", "reason": "Critical methods concern - tackle early"}, ...]

Return the complete ordered list as JSON:`;

                showOpenCodeLoading('task-optimize', 'Optimizing task order with AI...');
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: prompt,
                        model: aiSettings?.model || 'openai/gpt-4o-mini',
                        stream: false
                    })
                });

                if (!response.ok) {
                    hideOpenCodeLoading('task-optimize', { success: false, message: 'AI optimization failed' });
                    throw new Error('AI optimization failed');
                }

                const result = await response.json();
                const aiResponse = result.response || '';

                // Parse the AI response
                const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const orderedTasks = JSON.parse(jsonMatch[0]);
                    taskOrderCache = orderedTasks;
                    hideOpenCodeLoading('task-optimize', { success: true, message: 'Task order optimized' });
                    return applyAIOrder(pendingComments, orderedTasks);
                }
                hideOpenCodeLoading('task-optimize', { success: false, message: 'Could not parse AI response' });
            } catch (e) {
                console.error('AI task optimization failed:', e);
                hideOpenCodeLoading('task-optimize', { success: false, message: 'AI optimization failed' });
                showNotification('AI optimization unavailable, using default order', 'warning');
            } finally {
                isOptimizingTasks = false;
            }

            // Fallback: return original order
            return pendingComments;
        }

        function applyAIOrder(comments, aiOrder) {
            // Map AI order to comments with reasons
            const orderedComments = [];
            const commentMap = new Map(comments.map(c => [c.id, c]));

            for (const item of aiOrder) {
                const id = typeof item === 'string' ? item : item.id;
                const reason = typeof item === 'object' ? item.reason : null;
                const comment = commentMap.get(id);
                if (comment) {
                    orderedComments.push({
                        ...comment,
                        _reason: reason || ''
                    });
                    commentMap.delete(id);
                }
            }

            // Add any remaining comments not in AI order
            for (const comment of commentMap.values()) {
                orderedComments.push(comment);
            }

            return orderedComments;
        }

        // Simple fallback ordering when AI is unavailable
        function getSimpleTaskOrder(comments) {
            return [...comments].sort((a, b) => {
                // Sort by: completed last, then by priority (high first), then by type (major first)
                if (a.status === 'completed' && b.status !== 'completed') return 1;
                if (b.status === 'completed' && a.status !== 'completed') return -1;

                const priorityOrder = { high: 0, medium: 1, low: 2 };
                const typeOrder = { major: 0, minor: 1 };

                const priorityDiff = (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
                if (priorityDiff !== 0) return priorityDiff;

                return (typeOrder[a.type] || 1) - (typeOrder[b.type] || 1);
            });
        }

        let draggedTaskId = null;

        async function renderTaskQueue() {
            const allComments = getAllComments();
            const pendingComments = allComments.filter(c => c.status !== 'completed');
            const completedComments = allComments.filter(c => c.status === 'completed');

            // Check if we have custom ordering (sort_order set)
            const hasCustomOrder = pendingComments.some(c => c.sort_order && c.sort_order > 0);

            // Show loading state first
            document.getElementById('content-area').innerHTML = `
                <div class="task-queue-loading">
                    <div class="task-queue-loading-inner">
                        <i class="fas fa-spinner fa-spin"></i>
                        <p>${hasCustomOrder ? 'Loading tasks...' : 'AI is optimizing task order...'}</p>
                        <p class="small">Analyzing ${pendingComments.length} tasks for optimal productivity</p>
                    </div>
                </div>
            `;

            // Get ordered comments (either custom or AI-optimized)
            let orderedComments;
            if (hasCustomOrder) {
                orderedComments = [...pendingComments].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
            } else if (taskOrderCache) {
                // Use cached AI order
                orderedComments = applyAIOrder(pendingComments, taskOrderCache);
            } else {
                // Fall back to simple order on initial load, AI optimize on button click
                orderedComments = getSimpleTaskOrder(pendingComments);
            }

            const html = `
                <!-- Header with controls -->
                <div class="task-queue-header">
                    <div class="task-queue-count">
                        <span class="task-queue-count-number">${pendingComments.length}</span>
                        <span class="task-queue-count-label">tasks remaining</span>
                        ${completedComments.length > 0 ? `
                            <span class="task-queue-completed-badge">
                                <i class="fas fa-check"></i> ${completedComments.length} completed
                            </span>
                        ` : ''}
                    </div>
                    <div class="task-queue-actions">
                        <button onclick="optimizeTasksWithAI()" id="ai-optimize-btn" class="task-queue-btn optimize">
                            <i class="fas fa-wand-magic-sparkles"></i> AI Optimize
                        </button>
                        <button onclick="saveTaskOrder()" class="task-queue-btn save">
                            <i class="fas fa-save"></i> Save Order
                        </button>
                    </div>
                </div>

                <!-- Productivity tip -->
                <div class="task-queue-tip">
                    <div class="task-queue-tip-inner">
                        <div class="task-queue-tip-icon">
                            <i class="fas fa-lightbulb"></i>
                        </div>
                        <div>
                            <h4>Productivity Strategy</h4>
                            <p>
                                ${taskOrderCache ? 'AI has ordered tasks for optimal productivity.' : 'Click "AI Optimize" to have AI order tasks for optimal productivity.'}
                                Start with quick wins to build momentum, tackle critical items while energy is high. Drag to customize.
                            </p>
                        </div>
                    </div>
                </div>

                <!-- Task list with drag-drop -->
                <div id="task-queue-list" class="task-queue-list">
                    ${orderedComments.map((c, idx) => `
                        <div class="task-queue-item ${c.status === 'in_progress' ? 'working' : c.status === 'completed' ? 'done' : ''}"
                             draggable="true"
                             data-task-id="${c.id}"
                             ondragstart="handleTaskDragStart(event)"
                             ondragover="handleTaskDragOver(event)"
                             ondrop="handleTaskDrop(event)"
                             ondragend="handleTaskDragEnd(event)">
                            <div class="task-queue-item-inner">
                                <!-- Drag handle and position -->
                                <div class="task-queue-drag">
                                    <span class="task-queue-position">#${idx + 1}</span>
                                    <i class="fas fa-grip-vertical task-queue-grip"></i>
                                </div>

                                <!-- Status icon -->
                                <div class="task-queue-status">
                                    <button onclick="toggleTaskStatus('${c.id}')"
                                            class="task-queue-status-btn ${c.status}"
                                            title="${c.status === 'pending' ? 'Click to start working' : c.status === 'in_progress' ? 'Click to mark complete' : 'Click to reopen'}">
                                        ${c.status === 'completed'
                                            ? '<i class="fas fa-check-circle"></i>'
                                            : c.status === 'in_progress'
                                                ? '<i class="fas fa-pen-to-square"></i>'
                                                : '<i class="far fa-circle"></i>'}
                                    </button>
                                </div>

                                <!-- Task content -->
                                <div class="task-queue-content">
                                    <div class="task-queue-meta">
                                        <a href="javascript:void(0)" class="task-queue-id comment-link-pill" onclick="event.stopPropagation(); navigateToComment('${c.id}')" title="Open ${c.id}">${c.id}</a>
                                        ${c.status === 'in_progress' ? '<span class="task-queue-working-badge"><i class="fas fa-pencil"></i> Working</span>' : ''}
                                        <span class="task-queue-type ${c.type}">${c.type}</span>
                                        <span class="task-queue-category">${c.category || 'General'}</span>
                                        <span class="task-queue-priority ${c.priority}">${c.priority}</span>
                                        ${c._reason ? `<span class="task-queue-reason">${c._reason}</span>` : ''}
                                    </div>
                                    <p class="task-queue-text ${c.status === 'completed' ? 'completed' : ''}">
                                        ${(c.original_text || '').substring(0, 150)}${(c.original_text || '').length > 150 ? '...' : ''}
                                    </p>
                                </div>

                                <!-- Actions -->
                                <div>
                                    <button onclick="openCommentForEdit('${c.id}')" class="btn btn-sm ${c.status === 'in_progress' ? 'btn-primary' : 'btn-secondary'}">
                                        <i class="fas fa-edit"></i> ${c.status === 'in_progress' ? 'Continue' : 'Respond'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>

                ${completedComments.length > 0 ? `
                    <!-- Completed section -->
                    <div style="margin-top: var(--sp-8);">
                        <button onclick="toggleCompletedTasks()" class="reviewer-expand-btn" style="text-align: left; margin-bottom: var(--sp-4);">
                            <i class="fas fa-chevron-down" id="completed-toggle-icon"></i>
                            Completed tasks (${completedComments.length})
                        </button>
                        <div id="completed-tasks-list" class="task-queue-list hidden">
                            ${completedComments.map(c => `
                                <div class="task-queue-item" style="opacity: 0.6;">
                                    <div class="task-queue-item-inner">
                                        <div class="task-queue-checkbox">
                                            <button onclick="toggleTaskStatus('${c.id}')" class="task-queue-check-btn completed">
                                                <i class="fas fa-check"></i>
                                            </button>
                                        </div>
                                        <div class="task-queue-content">
                                            <p class="task-queue-text" style="text-decoration: line-through; color: var(--ink-light);">
                                                ${(c.original_text || '').substring(0, 100)}...
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            `;

            document.getElementById('content-area').innerHTML = html;
        }

        function handleTaskDragStart(e) {
            draggedTaskId = e.target.dataset.taskId;
            e.target.classList.add('opacity-50', 'border-blue-400');
            e.dataTransfer.effectAllowed = 'move';
        }

        function handleTaskDragOver(e) {
            e.preventDefault();
            const item = e.target.closest('.task-queue-item');
            if (item && item.dataset.taskId !== draggedTaskId) {
                item.classList.add('border-blue-400', 'bg-blue-50');
            }
        }

        function handleTaskDrop(e) {
            e.preventDefault();
            const targetItem = e.target.closest('.task-queue-item');
            if (!targetItem || targetItem.dataset.taskId === draggedTaskId) return;

            const targetId = targetItem.dataset.taskId;

            // Reorder in reviewData
            const allComments = getAllComments();
            const draggedIdx = allComments.findIndex(c => c.id === draggedTaskId);
            const targetIdx = allComments.findIndex(c => c.id === targetId);

            if (draggedIdx === -1 || targetIdx === -1) return;

            // Update sort_order for all pending tasks
            const pendingComments = allComments.filter(c => c.status !== 'completed');
            const draggedComment = pendingComments.find(c => c.id === draggedTaskId);
            const targetComment = pendingComments.find(c => c.id === targetId);

            if (!draggedComment || !targetComment) return;

            // Get current order
            const currentOrder = pendingComments
                .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
                .map(c => c.id);

            // Remove dragged and insert at target position
            const draggedOrderIdx = currentOrder.indexOf(draggedTaskId);
            const targetOrderIdx = currentOrder.indexOf(targetId);

            currentOrder.splice(draggedOrderIdx, 1);
            currentOrder.splice(targetOrderIdx, 0, draggedTaskId);

            // Update sort_order for all
            currentOrder.forEach((id, idx) => {
                const comment = findCommentById(id);
                if (comment) {
                    comment.sort_order = idx + 1;
                }
            });

            // Re-render
            renderTaskQueue();
            scheduleAutoSave();
        }

        function handleTaskDragEnd(e) {
            document.querySelectorAll('.task-queue-item').forEach(item => {
                item.classList.remove('opacity-50', 'border-blue-400', 'bg-blue-50');
            });
            draggedTaskId = null;
        }

        function toggleTaskStatus(commentId) {
            const comment = findCommentById(commentId);
            if (!comment) return;

            // Cycle: pending -> in_progress -> completed -> pending
            if (comment.status === 'pending') {
                comment.status = 'in_progress';
            } else if (comment.status === 'in_progress') {
                comment.status = 'completed';
            } else {
                comment.status = 'pending';
            }

            // Update the comment in the global data structure (reviewData)
            updateCommentStatus(commentId, comment.status);

            // Re-render the task queue
            renderTaskQueue();

            // Update sidebar (progress bar, counts) - this is the main UI update
            updateSidebar();

            // Also update other views if they exist (overview stats, etc.)
            updateGlobalStats();

            // Save changes to database
            scheduleAutoSave();
        }

        // Update comment status in global data
        function updateCommentStatus(commentId, newStatus) {
            if (!reviewData?.reviewers) return;

            for (const reviewer of reviewData.reviewers) {
                if (!reviewer.comments) continue;
                const comment = reviewer.comments.find(c => c.id === commentId);
                if (comment) {
                    comment.status = newStatus;
                    break;
                }
            }
        }

        // Update global stats displays (overview, sidebar counts, etc.)
        function updateGlobalStats() {
            const allComments = getAllComments();
            const completed = allComments.filter(c => c.status === 'completed').length;
            const inProgress = allComments.filter(c => c.status === 'in_progress').length;
            const pending = allComments.filter(c => c.status === 'pending').length;
            const total = allComments.length;

            // Update sidebar status counts
            const completedCountEl = document.getElementById('completed-count');
            const inprogressCountEl = document.getElementById('inprogress-count');
            const pendingCountEl = document.getElementById('pending-count');

            if (completedCountEl) completedCountEl.textContent = completed;
            if (inprogressCountEl) inprogressCountEl.textContent = inProgress;
            if (pendingCountEl) pendingCountEl.textContent = pending;

            // Update any stat displays on the page with data attributes
            const statElements = document.querySelectorAll('[data-stat="completed"]');
            statElements.forEach(el => {
                el.textContent = completed;
            });

            const progressElements = document.querySelectorAll('[data-stat="progress"]');
            progressElements.forEach(el => {
                el.textContent = `${completed}/${total}`;
            });

            // Update progress bars if any
            const progressBars = document.querySelectorAll('[data-progress-bar]');
            const percentage = total > 0 ? (completed / total) * 100 : 0;
            progressBars.forEach(bar => {
                bar.style.width = `${percentage}%`;
            });

            // Update task queue header count if visible
            const taskQueueCount = document.querySelector('.task-queue-count-number');
            if (taskQueueCount) {
                taskQueueCount.textContent = pending + inProgress;
            }

            const completedBadge = document.querySelector('.task-queue-completed-badge');
            if (completedBadge) {
                completedBadge.innerHTML = `<i class="fas fa-check"></i> ${completed} completed`;
            }
        }

        function toggleCompletedTasks() {
            const list = document.getElementById('completed-tasks-list');
            const icon = document.getElementById('completed-toggle-icon');
            if (list.classList.contains('hidden')) {
                list.classList.remove('hidden');
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-up');
            } else {
                list.classList.add('hidden');
                icon.classList.remove('fa-chevron-up');
                icon.classList.add('fa-chevron-down');
            }
        }

        // Terminal modal for AI optimization logging
        function showTerminalModal(title = 'AI Task Optimization') {
            // Remove existing modal if any
            document.getElementById('terminal-modal')?.remove();

            const modal = document.createElement('div');
            modal.id = 'terminal-modal';
            modal.className = 'modal-overlay';
            modal.innerHTML = `
                <div class="terminal-modal">
                    <div class="terminal-header">
                        <div class="terminal-dots">
                            <span class="terminal-dot red"></span>
                            <span class="terminal-dot yellow"></span>
                            <span class="terminal-dot green"></span>
                        </div>
                        <span class="terminal-title">${title}</span>
                        <button onclick="closeTerminalModal()" class="terminal-close" title="Close">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="terminal-body" id="terminal-output">
                        <div class="terminal-line">
                            <span class="terminal-prompt">$</span>
                            <span class="terminal-command">opencode optimize-tasks --model ${aiSettings?.model || 'gpt-4o-mini'}</span>
                        </div>
                    </div>
                    <div class="terminal-footer">
                        <div class="terminal-status" id="terminal-status">
                            <i class="fas fa-circle-notch fa-spin"></i>
                            <span>Initializing...</span>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            return modal;
        }

        function closeTerminalModal() {
            const modal = document.getElementById('terminal-modal');
            if (modal) {
                modal.classList.add('closing');
                setTimeout(() => modal.remove(), 200);
            }
        }

        function terminalLog(message, type = 'info') {
            const output = document.getElementById('terminal-output');
            if (!output) return;

            const line = document.createElement('div');
            line.className = `terminal-line ${type}`;

            // Format based on type
            if (type === 'command') {
                line.innerHTML = `<span class="terminal-prompt">$</span><span class="terminal-command">${message}</span>`;
            } else if (type === 'success') {
                line.innerHTML = `<span class="terminal-success">✓</span> ${message}`;
            } else if (type === 'error') {
                line.innerHTML = `<span class="terminal-error">✗</span> ${message}`;
            } else if (type === 'reasoning') {
                line.innerHTML = `<span class="terminal-reasoning">💭</span> <span class="reasoning-text">${message}</span>`;
            } else if (type === 'task') {
                line.innerHTML = `<span class="terminal-task">→</span> ${message}`;
            } else if (type === 'header') {
                line.innerHTML = `<span class="terminal-header-text">=== ${message} ===</span>`;
            } else {
                line.innerHTML = `<span class="terminal-info">ℹ</span> ${message}`;
            }

            output.appendChild(line);
            output.scrollTop = output.scrollHeight;
        }

        function updateTerminalStatus(message, icon = 'fa-circle-notch fa-spin') {
            const status = document.getElementById('terminal-status');
            if (status) {
                status.innerHTML = `<i class="fas ${icon}"></i><span>${message}</span>`;
            }
        }

        async function optimizeTasksWithAI() {
            const btn = document.getElementById('ai-optimize-btn');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Optimizing...';
            }

            // Show terminal modal
            showTerminalModal('AI Task Optimization');

            try {
                terminalLog('Starting AI task optimization...', 'info');
                terminalLog('Analyzing task queue', 'header');

                // Clear custom order and cache
                const allComments = getAllComments();
                allComments.forEach(c => {
                    c.sort_order = 0;
                });
                taskOrderCache = null;

                const pendingComments = allComments.filter(c => c.status !== 'completed');
                const completedCount = allComments.length - pendingComments.length;

                terminalLog(`Found ${allComments.length} total tasks`, 'info');
                terminalLog(`${completedCount} completed, ${pendingComments.length} pending`, 'info');

                if (pendingComments.length === 0) {
                    terminalLog('No pending tasks to optimize!', 'success');
                    updateTerminalStatus('Complete - no tasks to optimize', 'fa-check-circle');
                    return;
                }

                // Analyze task composition
                const majorCount = pendingComments.filter(c => c.type === 'major').length;
                const highPriority = pendingComments.filter(c => c.priority === 'high').length;
                const categories = [...new Set(pendingComments.map(c => c.category))];

                terminalLog('Task composition:', 'header');
                terminalLog(`Major issues: ${majorCount}, Minor: ${pendingComments.length - majorCount}`, 'task');
                terminalLog(`High priority: ${highPriority}`, 'task');
                terminalLog(`Categories: ${categories.join(', ')}`, 'task');

                terminalLog('Sending to OpenCode', 'header');
                updateTerminalStatus('Waiting for AI response...', 'fa-brain');

                // Build task summaries
                const taskSummaries = pendingComments.map(c => ({
                    id: c.id,
                    type: c.type,
                    priority: c.priority,
                    category: c.category,
                    location: c.location,
                    requires_analysis: c.requires_new_analysis,
                    text_preview: (c.original_text || '').substring(0, 100)
                }));

                const prompt = `You are a productivity expert helping a researcher respond to peer review comments.

ORDER these ${taskSummaries.length} tasks for OPTIMAL PRODUCTIVITY using research-backed strategies:

## PRODUCTIVITY PRINCIPLES TO APPLY:
1. **Quick Wins First (2-3 tasks)**: Start with minor/easy tasks to build momentum and confidence
2. **Peak Energy Tasks Next**: Major/high-priority items when motivation is established
3. **Batch Similar Work**: Group related categories together (e.g., all Figure tasks, all Methods tasks)
4. **Analysis Tasks Together**: Items requiring new analysis should be batched
5. **End with Low Stakes**: Save low-priority minor items for the end when energy wanes

## TASKS TO ORDER:
${JSON.stringify(taskSummaries, null, 2)}

## OUTPUT FORMAT:
First, briefly explain your reasoning (2-3 sentences about your strategy).
Then return a JSON array of task IDs in the recommended order, with a brief reason for each position.
Format: [{"id": "R1-5", "reason": "Quick formatting fix - build momentum"}, ...]

Your response:`;

                terminalLog(`Model: ${aiSettings?.model || 'gpt-4o-mini'}`, 'info');
                terminalLog('Prompt sent, awaiting response...', 'info');

                showOpenCodeLoading('terminal-optimize', 'Optimizing task queue with AI...');
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: prompt,
                        model: aiSettings?.model || 'openai/gpt-4o-mini',
                        stream: false
                    })
                });

                if (!response.ok) {
                    hideOpenCodeLoading('terminal-optimize', { success: false, message: 'API error' });
                    throw new Error(`API error: ${response.status}`);
                }
                hideOpenCodeLoading('terminal-optimize', { success: true, message: 'Response received' });

                const result = await response.json();
                const aiResponse = result.response || '';

                terminalLog('AI Response received', 'header');
                updateTerminalStatus('Processing response...', 'fa-cogs');

                // Extract reasoning (text before JSON)
                const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const reasoningText = aiResponse.substring(0, jsonMatch.index).trim();
                    if (reasoningText) {
                        // Split reasoning into sentences and log each
                        const sentences = reasoningText.split(/(?<=[.!?])\s+/).filter(s => s.trim());
                        sentences.forEach(sentence => {
                            if (sentence.trim()) {
                                terminalLog(sentence.trim(), 'reasoning');
                            }
                        });
                    }

                    const orderedTasks = JSON.parse(jsonMatch[0]);
                    taskOrderCache = orderedTasks;

                    terminalLog('Optimized task order', 'header');

                    // Log each task in order
                    orderedTasks.forEach((item, idx) => {
                        const id = typeof item === 'string' ? item : item.id;
                        const reason = typeof item === 'object' ? item.reason : '';
                        const comment = pendingComments.find(c => c.id === id);
                        const typeIcon = comment?.type === 'major' ? '🔴' : '🟢';
                        terminalLog(`#${idx + 1} ${typeIcon} <strong>${id}</strong>: ${reason}`, 'task');
                    });

                    // Apply the order
                    terminalLog('Applying new order', 'header');
                    const optimizedComments = applyAIOrder(pendingComments, orderedTasks);

                    optimizedComments.forEach((c, idx) => {
                        const originalComment = findCommentById(c.id);
                        if (originalComment) {
                            originalComment.sort_order = idx + 1;
                        }
                    });

                    terminalLog('Task order updated successfully!', 'success');
                    terminalLog('', 'info');
                    terminalLog('Click X to close this window and view your optimized task queue.', 'info');
                    updateTerminalStatus('Optimization complete! Review the results above.', 'fa-check-circle');

                    await renderTaskQueue();
                    scheduleAutoSave();

                } else {
                    throw new Error('Could not parse AI response');
                }

            } catch (e) {
                console.error('AI optimization failed:', e);
                terminalLog(`Error: ${e.message}`, 'error');
                updateTerminalStatus('Optimization failed', 'fa-exclamation-circle');

                // Don't auto-close on error so user can see what happened
                setTimeout(async () => {
                    await renderTaskQueue();
                }, 1000);

            } finally {
                const btn = document.getElementById('ai-optimize-btn');
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> AI Optimize';
                }
            }
        }

        function resetTaskOrder() {
            // Clear all sort_order values to reset to default
            const allComments = getAllComments();
            allComments.forEach(c => {
                c.sort_order = 0;
            });
            taskOrderCache = null;
            renderTaskQueue();
            scheduleAutoSave();
            showNotification('Task order reset', 'success');
        }

        async function saveTaskOrder() {
            await saveCommentsToDb();
            showNotification('Task order saved', 'success');
        }

        function openCommentForEdit(commentId) {
            navigateToComment(commentId);
        }

        // Render Export
        function renderExport() {
            const allComments = getAllComments();
            const completed = allComments.filter(c => c.status === 'completed');

            const html = `
                <!-- Manuscript Editing Feature - Main Action -->
                <div class="export-banner">
                    <div class="export-banner-inner">
                        <div class="export-banner-icon">
                            <i class="fas fa-magic"></i>
                        </div>
                        <div class="export-banner-content">
                            <h3>Auto-Edit Manuscript</h3>
                            <p>
                                Automatically apply reviewer-requested changes to your manuscript with track changes.
                                OpenCode will edit terminology, fix framing issues, and improve scientific accuracy while preserving your data and conclusions.
                            </p>
                            <div class="export-banner-stats">
                                <div class="export-stat">
                                    <div class="export-stat-value">8</div>
                                    <div class="export-stat-label">Changes Applied</div>
                                </div>
                                <div class="export-stat">
                                    <div class="export-stat-value">5</div>
                                    <div class="export-stat-label">Terminology Fixes</div>
                                </div>
                                <div class="export-stat">
                                    <div class="export-stat-value">2</div>
                                    <div class="export-stat-label">Period Corrections</div>
                                </div>
                                <div class="export-stat">
                                    <div class="export-stat-value">1</div>
                                    <div class="export-stat-label">Method Fix</div>
                                </div>
                            </div>
                            <div class="export-banner-actions">
                                <a href="#" id="download-revised-link" download class="export-banner-btn primary">
                                    <i class="fas fa-download"></i> Download Revised Manuscript
                                </a>
                                <button onclick="showEditDetails()" class="export-banner-btn secondary">
                                    <i class="fas fa-list"></i> View Changes
                                </button>
                                <button onclick="requestNewEdit()" class="export-banner-btn secondary">
                                    <i class="fas fa-redo"></i> Request New Edit
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="export-grid">
                    <div class="export-card">
                        <h3><i class="fas fa-file-word word"></i> Export Response Document</h3>
                        <p>Generate a formatted response letter with all your reviewer responses.</p>
                        <div class="export-options">
                            <label class="export-option">
                                <input type="checkbox" checked id="export-completed">
                                <span>Include completed responses (${completed.length})</span>
                            </label>
                            <label class="export-option">
                                <input type="checkbox" id="export-draft">
                                <span>Include draft responses</span>
                            </label>
                            <label class="export-option">
                                <input type="checkbox" checked id="export-original">
                                <span>Include original reviewer comments</span>
                            </label>
                        </div>
                        <button onclick="exportToWord()" class="export-card-btn word">
                            <i class="fas fa-download"></i> Generate Response Document
                        </button>
                    </div>

                    <div class="export-card">
                        <h3><i class="fas fa-file-code json"></i> Export JSON Data</h3>
                        <p>Export all review data as JSON for backup or import into another platform.</p>
                        <button onclick="exportJSON()" class="export-card-btn json">
                            <i class="fas fa-download"></i> Download JSON
                        </button>
                    </div>

                    <div class="export-card">
                        <h3><i class="fas fa-chart-bar summary"></i> Export Summary Report</h3>
                        <p>Generate a summary report of the review process and responses.</p>
                        <button onclick="exportSummary()" class="export-card-btn summary">
                            <i class="fas fa-file-alt"></i> Generate Summary
                        </button>
                    </div>

                    <div class="export-card">
                        <h3><i class="fas fa-sync sync"></i> Sync Progress</h3>
                        <p>Save your progress to browser storage or load previous work.</p>
                        <div style="display: flex; gap: var(--sp-3);">
                            <button onclick="saveProgress()" class="export-card-btn sync" style="flex: 1;">
                                <i class="fas fa-save"></i> Save
                            </button>
                            <button onclick="loadNewManuscript()" class="btn btn-secondary" style="flex: 1;">
                                <i class="fas fa-upload"></i> Load
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Changes Applied Section -->
                <div id="edit-details" class="export-changes-panel hidden">
                    <h3><i class="fas fa-check-circle"></i> Track Changes Applied</h3>
                    <div class="export-changes-list">
                        <div class="export-change-item terminology">
                            <span class="export-change-badge">R1-3a</span>
                            <div class="export-change-content">
                                <p>Replaced "time-traveling" with "long-dormant"</p>
                                <p class="desc">Present terminology as hypothesis rather than established fact</p>
                            </div>
                        </div>
                        <div class="export-change-item terminology">
                            <span class="export-change-badge">R1-3b</span>
                            <div class="export-change-content">
                                <p>Replaced "time-travelling" with "long-dormant"</p>
                                <p class="desc">British spelling variant also updated</p>
                            </div>
                        </div>
                        <div class="export-change-item terminology">
                            <span class="export-change-badge">R3-1a</span>
                            <div class="export-change-content">
                                <p>Replaced "pioneer microbial communities" with "depositional-era microbial communities"</p>
                                <p class="desc">More neutral, scientifically precise terminology</p>
                            </div>
                        </div>
                        <div class="export-change-item terminology">
                            <span class="export-change-badge">R3-1b</span>
                            <div class="export-change-content">
                                <p>Replaced "pioneer methanogens" with "ancient methanogens"</p>
                                <p class="desc">Avoids loaded "pioneer" terminology</p>
                            </div>
                        </div>
                        <div class="export-change-item terminology">
                            <span class="export-change-badge">R3-1c</span>
                            <div class="export-change-content">
                                <p>Replaced "pioneering microbes" with "depositional-era microbes"</p>
                                <p class="desc">Consistent terminology throughout</p>
                            </div>
                        </div>
                        <div class="export-change-item period">
                            <span class="export-change-badge">R1-5</span>
                            <div class="export-change-content">
                                <p>Replaced "Pliocene/Pleistocene transition" with "Early Pleistocene interglacial"</p>
                                <p class="desc">Correct geological period based on dating evidence</p>
                            </div>
                        </div>
                        <div class="export-change-item method">
                            <span class="export-change-badge">R1-29</span>
                            <div class="export-change-content">
                                <p>Removed "novel" from "novel method"</p>
                                <p class="desc">Appropriate for describing cited methods</p>
                            </div>
                        </div>
                        <div class="export-change-item method">
                            <span class="export-change-badge">R1-29b</span>
                            <div class="export-change-content">
                                <p>Removed "novel" from "novel approach"</p>
                                <p class="desc">Consistent modesty in method descriptions</p>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="export-preview-panel">
                    <h3>Response Preview</h3>
                    <div class="export-preview-content">
                        <div id="response-preview">
                            ${generateResponsePreview()}
                        </div>
                    </div>
                </div>
            `;
            document.getElementById('content-area').innerHTML = html;
        }

        function showEditDetails() {
            const details = document.getElementById('edit-details');
            details.classList.toggle('hidden');
        }

        function requestNewEdit() {
            const prompt = "Please generate a new revised manuscript addressing additional reviewer comments. Focus on:\\n1. Any remaining terminology issues\\n2. Abstract/introduction/conclusion alignment\\n3. Scientific accuracy improvements\\n4. Any specific comments I mark as 'ready for edit'";
            copyPrompt(prompt);
            alert('Prompt copied! Paste it in the chat to request specific manuscript edits.');
        }

        function generateResponsePreview() {
            let preview = '<h2>Response to Reviewers</h2>';
            reviewData.reviewers.forEach(reviewer => {
                preview += `<h3>${reviewer.name}</h3>`;
                reviewer.comments.forEach(comment => {
                    if (comment.draft_response) {
                        preview += `
                            <div class="mb-4">
                                <p><strong>Comment ${comment.id}:</strong> ${comment.original_text.substring(0, 100)}...</p>
                                <p><em>Response:</em> ${comment.draft_response}</p>
                            </div>
                        `;
                    }
                });
            });
            return preview;
        }

        // Helper functions
        function getStatusClass(status) {
            const classes = {
                'completed': 'bg-green-100 text-green-700',
                'in_progress': 'bg-blue-100 text-blue-700',
                'pending': 'bg-yellow-100 text-yellow-700'
            };
            return classes[status] || classes['pending'];
        }

        function getTypeClass(type) {
            return type === 'major' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700';
        }

        // Filter functions
        function filterByPriority(priority) {
            currentFilter = { type: 'priority', value: priority };
            setView('comments', true);  // preserve filter
        }

        function filterByType(type) {
            currentFilter = { type: 'type', value: type };
            setView('comments', true);  // preserve filter
        }

        function filterByCategory(category) {
            currentFilter = { type: 'category', value: category };
            setView('comments', true);  // preserve filter
        }

        function filterByAnalysis(value) {
            currentFilter = { type: 'analysis', value: value };
            setView('comments', true);  // preserve filter
        }

        function clearFilter() {
            currentFilter = null;
            // Clear search input if it exists
            const searchInput = document.getElementById('search-input');
            if (searchInput) searchInput.value = '';
            setView('comments');  // don't preserve (clear it)
        }

        // Debounce timer for search
        let searchDebounceTimer = null;

        function searchComments(query) {
            // Clear previous debounce timer
            if (searchDebounceTimer) {
                clearTimeout(searchDebounceTimer);
            }

            // Debounce the search by 300ms
            searchDebounceTimer = setTimeout(() => {
                // Implement search functionality
                if (!query || query.trim() === '') {
                    currentFilter = null;
                    setView(currentView);
                    return;
                }

                // Set the search filter and show results
                currentFilter = { type: 'search', value: query.trim().toLowerCase() };
                setView('comments', true);  // preserve filter
            }, 300);
        }

        // Comment operations
        function setCommentStatus(reviewerId, commentId, status) {
            const reviewer = reviewData.reviewers.find(r => r.id === reviewerId);
            if (reviewer) {
                const comment = reviewer.comments.find(c => c.id === commentId);
                if (comment) {
                    comment.status = status;
                    updateSidebar();
                    setView(currentView);
                    scheduleAutoSave(); // Auto-save to database after status change
                }
            }
        }

        // =====================================================
        // NAVIGATE TO COMMENT - Universal comment ID linking
        // =====================================================

        // Navigate to a comment by its ID (e.g., R1-1, R2-3)
        // This function is called when clicking comment IDs anywhere in the app
        function navigateToComment(commentId) {
            if (!reviewData || !reviewData.reviewers) {
                console.warn('navigateToComment: No review data loaded');
                return false;
            }

            // Normalize the comment ID format (support both R1-1 and R1.1)
            const normalizedId = commentId.replace(/\./g, '-').toUpperCase();

            // Find the comment and its reviewer
            for (const reviewer of reviewData.reviewers) {
                const comment = reviewer.comments.find(c =>
                    c.id === normalizedId ||
                    c.id === commentId ||
                    c.id.toUpperCase() === normalizedId
                );
                if (comment) {
                    // Found it! Open the comment modal
                    openCommentModal(reviewer.id, comment.id);
                    return true;
                }
            }

            console.warn(`navigateToComment: Comment ${commentId} not found`);
            showNotification(`Comment ${commentId} not found`, 'error');
            return false;
        }

        // Convert comment ID patterns in text to clickable links
        // Returns HTML with clickable comment IDs
        function makeCommentIdsClickable(text) {
            if (!text || typeof text !== 'string') return text || '';

            // Match patterns like R1-1, R1-2, R2-3, etc. (with dash or dot)
            // Also match variations like R1.1, r1-1, etc.
            const commentIdPattern = /\b(R\d+[-\.]\d+[a-z]?)\b/gi;

            return text.replace(commentIdPattern, (match) => {
                return `<a href="javascript:void(0)" class="comment-link" onclick="navigateToComment('${match}')" title="Open ${match}">${match}</a>`;
            });
        }

        function openCommentModal(reviewerId, commentId) {
            const reviewer = reviewData.reviewers.find(r => r.id === reviewerId);
            const comment = reviewer?.comments.find(c => c.id === commentId);
            if (!comment) return;

            editingComment = { reviewerId, commentId };
            document.getElementById('modal-title').textContent = `Response Builder - ${comment.id}`;

            // Initialize actions_taken if not present
            if (!comment.actions_taken) comment.actions_taken = [];

            // Get AI-generated potential solutions from expertDiscussions first
            const aiSolutions = expertDiscussions?.expert_discussions?.[commentId]?.potential_solutions || [];
            // Fall back to local generated solutions if no AI solutions
            if (!comment.potential_solutions) comment.potential_solutions = generatePotentialSolutions(comment);

            // Build solutions HTML - combine AI solutions with local solutions
            // AI solutions are now simple strings (action items), same as local solutions
            const allSolutions = aiSolutions.length > 0 ? aiSolutions : comment.potential_solutions;
            let solutionsHtml = '';
            if (allSolutions.length > 0) {
                solutionsHtml = allSolutions.map((sol, idx) => {
                    // Handle both string solutions and object solutions (legacy)
                    const solText = typeof sol === 'string' ? sol : (sol.title || sol.response || '');
                    return `
                    <label class="rb-solution-item">
                        <input type="checkbox" class="solution-checkbox"
                               data-idx="${idx}"
                               ${comment.actions_taken.includes(solText) ? 'checked' : ''}
                               onchange="toggleSolutionAI('${commentId}', ${idx})">
                        <span>${solText}</span>
                    </label>
                `}).join('');
            } else {
                solutionsHtml = '<p class="rb-empty-text">No suggested solutions for this comment type</p>';
            }

            document.getElementById('modal-content').innerHTML = `
                <!-- Original Comment - Full Width at Top -->
                <div class="rb-card" style="margin-bottom: var(--sp-4);">
                    <div class="rb-card-header">
                        <label class="rb-label">
                            <div class="rb-icon-box blue">
                                <i class="fas fa-comment-alt"></i>
                            </div>
                            Reviewer Comment
                        </label>
                        <div class="rb-tags">
                            ${comment.location && comment.location !== 'null' ? `<span class="rb-tag location"><i class="fas fa-map-marker-alt"></i> ${comment.location}</span>` : ''}
                            <span class="rb-tag type"><i class="fas fa-tag"></i> ${comment.type || 'general'}</span>
                            <span class="rb-tag category"><i class="fas fa-folder"></i> ${comment.category || 'Uncategorized'}</span>
                        </div>
                    </div>
                    <div class="rb-comment-text">${comment.original_text}</div>
                </div>

                <!-- Two Column Layout -->
                <div class="rb-two-column">
                    <!-- Left Column: Solutions & AI -->
                    <div class="rb-column">
                        <!-- Potential Solutions Box -->
                        <div class="rb-card">
                            <label class="rb-label">
                                <div class="rb-icon-box amber">
                                    <i class="fas fa-lightbulb"></i>
                                </div>
                                Potential Solutions (check what you've done)
                            </label>
                            <div class="rb-solutions-list" id="solutions-checklist">
                                ${solutionsHtml}
                            </div>
                            <div style="margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--rule-light);">
                                <input type="text" id="custom-solution" placeholder="Add custom action..."
                                       class="rb-custom-input"
                                       onkeypress="if(event.key==='Enter')addCustomSolution()">
                            </div>
                        </div>

                        <!-- Actions Taken Summary -->
                        <div class="rb-card">
                            <label class="rb-label">
                                <div class="rb-icon-box green">
                                    <i class="fas fa-check-circle"></i>
                                </div>
                                Actions Taken
                            </label>
                            <div id="actions-taken-list" class="rb-actions-list">
                                ${comment.actions_taken.length > 0
                                    ? '<ul>' + comment.actions_taken.map(a => `<li><i class="fas fa-check"></i><span>${a}</span></li>`).join('') + '</ul>'
                                    : '<p class="rb-empty-text">Check solutions above to add actions</p>'}
                            </div>
                        </div>

                        <!-- Ask OpenCode -->
                        <div class="rb-ai-panel">
                            <div class="rb-ai-header">
                                <label class="rb-ai-label">
                                    <div class="rb-ai-icon">
                                        <i class="fas fa-pen-nib"></i>
                                    </div>
                                    Draft response
                                </label>
                                <span id="ws-status-modal" class="rb-status-badge">
                                    <i class="fas fa-circle" style="font-size: 8px; margin-right: 4px; color: var(--sage);"></i>Ready
                                </span>
                            </div>

                            <!-- Skills Selection -->
                            <div class="rb-skills" id="skill-checkboxes">
                                <label class="rb-skill-label">
                                    <input type="checkbox" class="skill-checkbox" value="manuscript-reviewer" checked>
                                    <span>Reviewer</span>
                                </label>
                                <label class="rb-skill-label">
                                    <input type="checkbox" class="skill-checkbox" value="dna-damage-auth" id="skill-dna">
                                    <span>DNA Auth</span>
                                </label>
                                <label class="rb-skill-label">
                                    <input type="checkbox" class="skill-checkbox" value="microbial-ecology" id="skill-ecology">
                                    <span>Ecology</span>
                                </label>
                                <label class="rb-skill-label">
                                    <input type="checkbox" class="skill-checkbox" value="phylogenetics-evolution" id="skill-phylo">
                                    <span>Evolution</span>
                                </label>
                                <label class="rb-skill-label">
                                    <input type="checkbox" class="skill-checkbox" value="ancient-virome" id="skill-virome">
                                    <span>Virome</span>
                                </label>
                                <label class="rb-skill-label">
                                    <input type="checkbox" class="skill-checkbox" value="bioinformatics-methods" id="skill-methods">
                                    <span>Methods</span>
                                </label>
                            </div>

                            <!-- Context Status -->
                            <div class="rb-context-status ${contextLoaded ? 'loaded' : 'not-loaded'}" id="ask-context-status">
                                <div class="rb-context-info">
                                    <span class="rb-context-dot ${contextLoaded ? 'loaded' : 'not-loaded'}" id="ask-context-dot"></span>
                                    <span class="rb-context-text ${contextLoaded ? 'loaded' : 'not-loaded'}" id="ask-context-text">
                                        ${contextLoaded ? 'Context loaded' : 'No context'}
                                    </span>
                                </div>
                                <button onclick="openContextModal()" class="rb-context-btn">
                                    ${contextLoaded ? 'Reload' : 'Load Context'}
                                </button>
                            </div>

                            <div class="rb-model-info">
                                <span>Model: <strong id="current-model-display">gpt-5.2</strong></span>
                                <a href="#" onclick="openSettingsModal(); return false;">Change</a>
                            </div>

                            <button onclick="askOpenCodeForResponse()"
                                    class="rb-generate-btn"
                                    id="ask-opencode-btn">
                                <i class="fas fa-magic"></i> Generate Response
                            </button>
                            <div id="opencode-loading" class="rb-loading hidden">
                                <i class="fas fa-spinner fa-spin"></i>
                                <p>Generating response...</p>
                            </div>
                        </div>
                    </div>

                    <!-- Right Column: Response Editor & Preview -->
                    <div class="space-y-4">
                        <!-- Response Editor -->
                        <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                            <div class="flex items-center justify-between mb-3">
                                <label class="text-sm font-semibold text-gray-800 flex items-center gap-2">
                                    <div class="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center">
                                        <i class="fas fa-pen text-indigo-600"></i>
                                    </div>
                                    Your Response
                                </label>
                                <div class="flex items-center gap-2">
                                    <button onclick="showVersionHistory('${comment.id}')" class="text-xs px-2 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600" title="View version history">
                                        <i class="fas fa-history mr-1"></i>History
                                    </button>
                                    <select id="edit-status" class="text-xs px-3 py-1.5 border rounded-lg bg-gray-50" onchange="updateCommentStatus(this.value)">
                                        <option value="pending" ${comment.status === 'pending' ? 'selected' : ''}>Pending</option>
                                        <option value="in_progress" ${comment.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                                        <option value="completed" ${comment.status === 'completed' ? 'selected' : ''}>Completed</option>
                                    </select>
                                </div>
                            </div>
                            <textarea id="edit-response" class="w-full px-4 py-3 border border-gray-200 rounded-xl bg-gray-50 focus:bg-white focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
                                      style="min-height: 200px;"
                                      placeholder="Your response will appear here...">${comment.draft_response || ''}</textarea>
                        </div>

                        <!-- Preview -->
                        <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
                            <label class="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                                <div class="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
                                    <i class="fas fa-eye text-gray-600"></i>
                                </div>
                                Preview
                            </label>
                            <div id="response-markdown-preview" class="markdown-preview rounded-xl p-4 text-sm prose max-w-none border border-gray-100 bg-gray-50 mt-3" style="min-height: 150px;">
                                ${marked.parse(comment.draft_response || '*Response will appear here*')}
                            </div>
                        </div>
                    </div>
                </div>
            `;

            // Add live preview - use named function to avoid memory leak
            const responseEl = document.getElementById('edit-response');
            const previewEl = document.getElementById('response-markdown-preview');

            // Remove old listener if exists (prevent memory leak)
            if (window._responseInputHandler) {
                responseEl.removeEventListener('input', window._responseInputHandler);
            }

            // Create and store new handler
            window._responseInputHandler = (e) => {
                if (previewEl) {
                    previewEl.innerHTML = marked.parse(e.target.value || '*Response will appear here*');
                }
            };
            responseEl.addEventListener('input', window._responseInputHandler);

            document.getElementById('comment-modal').classList.remove('hidden');

            // Auto-select skills based on comment content
            autoSelectSkills(comment);

            // Update model display
            const modelDisplay = document.getElementById('current-model-display');
            if (modelDisplay) {
                modelDisplay.textContent = aiSettings.model.split('/').pop() || 'GPT-5.2';
            }

            // Update API status in modal
            checkApiConnection();
        }

        function generatePotentialSolutions(comment) {
            // Generate relevant solutions based on comment category and type
            const baseSolutions = [];

            if (comment.requires_new_analysis) {
                comment.analysis_type.forEach(type => {
                    baseSolutions.push(`Performed ${type} analysis`);
                });
            }

            const categorySolutions = {
                'Authentication': [
                    'Added C-to-T deamination plots (Supplementary Figure)',
                    'Performed MapDamage/Pydamage validation',
                    'Added damage threshold justification',
                    'Clarified authentication criteria in Methods'
                ],
                'Terminology': [
                    'Revised terminology throughout manuscript',
                    'Changed "time-traveling" to hypothesis framing',
                    'Replaced "pioneer" with "depositional-era"',
                    'Added clarifying definitions'
                ],
                'Analysis': [
                    'Performed additional statistical analysis',
                    'Added new supplementary figures',
                    'Expanded methods description',
                    'Ran sensitivity analysis'
                ],
                'Methods': [
                    'Clarified methodology in text',
                    'Added parameter justification',
                    'Expanded supplementary methods',
                    'Added workflow diagram'
                ],
                'Interpretation': [
                    'Revised discussion to reflect evidence strength',
                    'Added alternative interpretations',
                    'Moderated claims appropriately',
                    'Added caveats and limitations'
                ],
                'Database': [
                    'Expanded reference database',
                    'Added permafrost metagenome references',
                    'Re-ran source tracking with updated database',
                    'Documented database composition'
                ],
                'Figure': [
                    'Revised figure as requested',
                    'Added statistical annotations',
                    'Improved visualization clarity',
                    'Added to supplementary materials'
                ],
                'Results': [
                    'Added quantitative details',
                    'Expanded results description',
                    'Added supporting statistics',
                    'Moved details to supplement'
                ]
            };

            const catSols = categorySolutions[comment.category] || [];
            return [...baseSolutions, ...catSols].slice(0, 6);
        }

        function toggleSolution(idx) {
            if (!editingComment) return;
            const reviewer = reviewData.reviewers.find(r => r.id === editingComment.reviewerId);
            const comment = reviewer?.comments.find(c => c.id === editingComment.commentId);
            if (!comment) return;

            const solution = comment.potential_solutions[idx];
            if (comment.actions_taken.includes(solution)) {
                comment.actions_taken = comment.actions_taken.filter(a => a !== solution);
            } else {
                comment.actions_taken.push(solution);
            }
            updateActionsTakenDisplay(comment);
        }

        function addCustomSolution() {
            const input = document.getElementById('custom-solution');
            const text = input.value.trim();
            if (!text) return;

            const reviewer = reviewData.reviewers.find(r => r.id === editingComment.reviewerId);
            const comment = reviewer?.comments.find(c => c.id === editingComment.commentId);
            if (!comment) return;

            comment.potential_solutions.push(text);
            comment.actions_taken.push(text);
            input.value = '';

            // Re-render the solutions list
            openCommentModal(editingComment.reviewerId, editingComment.commentId);
        }

        function updateActionsTakenDisplay(comment) {
            const container = document.getElementById('actions-taken-list');
            if (comment.actions_taken.length > 0) {
                container.innerHTML = '<ul class="list-disc list-inside space-y-1">' +
                    comment.actions_taken.map(a => `<li>${a}</li>`).join('') + '</ul>';
            } else {
                container.innerHTML = '<p class="text-gray-400 italic">Check solutions above to add actions</p>';
            }
        }

        function updateCommentStatus(status) {
            if (!editingComment) return;
            const reviewer = reviewData.reviewers.find(r => r.id === editingComment.reviewerId);
            const comment = reviewer?.comments.find(c => c.id === editingComment.commentId);
            if (comment) {
                comment.status = status;
            }
        }

        function closeModal() {
            document.getElementById('comment-modal').classList.add('hidden');
            editingComment = null;
        }

        async function saveComment() {
            if (!editingComment) return;

            const reviewer = reviewData.reviewers.find(r => r.id === editingComment.reviewerId);
            const comment = reviewer?.comments.find(c => c.id === editingComment.commentId);
            if (!comment) return;

            // Get old values for version tracking
            const oldValues = {
                draft_response: comment.draft_response || '',
                status: comment.status || 'pending',
                priority: comment.priority || 'medium',
                type: comment.type || 'minor'
            };

            // Get new values from fields that exist in the modal
            const statusEl = document.getElementById('edit-status');
            const responseEl = document.getElementById('edit-response');

            const newValues = {
                status: statusEl ? statusEl.value : comment.status,
                draft_response: responseEl ? responseEl.value : comment.draft_response
            };

            // Track version history for important field changes
            const fieldsToTrack = ['draft_response', 'status'];
            for (const field of fieldsToTrack) {
                if (oldValues[field] !== newValues[field]) {
                    await saveVersionHistoryEntry(
                        comment.id,
                        currentPaperId,
                        field,
                        oldValues[field],
                        newValues[field],
                        'user'
                    );
                }
            }

            // Apply new values
            comment.status = newValues.status;
            comment.draft_response = newValues.draft_response;

            // If response changed, check for related comments and notify
            const responseChanged = oldValues.draft_response !== newValues.draft_response && newValues.draft_response.length > 0;
            if (responseChanged) {
                checkRelatedCommentsConsistency(comment.id, newValues.draft_response);
            }

            closeModal();
            updateSidebar();
            setView(currentView);
            scheduleAutoSave(); // Auto-save to database after edit
        }

        // Save version history entry to server
        async function saveVersionHistoryEntry(commentId, paperId, fieldName, oldValue, newValue, source = 'user') {
            try {
                await fetch(`${API_BASE}/db/version`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        comment_id: commentId,
                        paper_id: paperId,
                        field_name: fieldName,
                        old_value: oldValue,
                        new_value: newValue,
                        source: source
                    })
                });
            } catch (e) {
                console.log('Version history save failed:', e);
            }
        }

        // Get version history for a comment
        async function getCommentVersionHistory(commentId) {
            try {
                const response = await fetch(`${API_BASE}/db/version/${encodeURIComponent(commentId)}`);
                if (response.ok) {
                    const result = await response.json();
                    return result.history || [];
                }
            } catch (e) {
                console.log('Failed to load version history:', e);
            }
            return [];
        }

        // Revert to a previous version
        async function revertToVersion(versionId) {
            try {
                const response = await fetch(`${API_BASE}/db/version/revert/${versionId}`, {
                    method: 'POST'
                });
                if (response.ok) {
                    const result = await response.json();
                    if (result.success) {
                        // Update local data
                        const comment = findCommentById(result.comment_id);
                        if (comment) {
                            comment[result.field] = result.value;
                        }
                        showNotification('Reverted to previous version', 'success');
                        // Refresh the modal if open
                        if (editingComment && editingComment.commentId === result.comment_id) {
                            openCommentModal(result.comment_id);
                        }
                        return true;
                    }
                }
            } catch (e) {
                console.error('Revert failed:', e);
            }
            showNotification('Failed to revert', 'error');
            return false;
        }

        // Show version history modal
        async function showVersionHistory(commentId) {
            const history = await getCommentVersionHistory(commentId);

            const modal = document.createElement('div');
            modal.id = 'version-history-modal';
            modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

            const formatDate = (dateStr) => {
                const date = new Date(dateStr);
                return date.toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            };

            const getSourceIcon = (source) => {
                switch (source) {
                    case 'ai': return '<i class="fas fa-robot text-emerald-500"></i>';
                    case 'revert': return '<i class="fas fa-undo text-amber-500"></i>';
                    default: return '<i class="fas fa-user text-blue-500"></i>';
                }
            };

            const getFieldLabel = (field) => {
                switch (field) {
                    case 'draft_response': return 'Response';
                    case 'status': return 'Status';
                    default: return field;
                }
            };

            modal.innerHTML = `
                <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                    <div class="p-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white flex items-center justify-between">
                        <div class="flex items-center gap-3">
                            <i class="fas fa-history text-xl"></i>
                            <div>
                                <h3 class="font-bold">Version History</h3>
                                <p class="text-xs opacity-80">${commentId}</p>
                            </div>
                        </div>
                        <button onclick="document.getElementById('version-history-modal').remove()" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/20">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="flex-1 overflow-y-auto p-4">
                        ${history.length === 0 ? `
                            <div class="text-center py-12 text-gray-400">
                                <i class="fas fa-clock text-4xl mb-3"></i>
                                <p>No version history yet</p>
                                <p class="text-sm mt-1">Changes will be tracked when you edit this response</p>
                            </div>
                        ` : `
                            <div class="space-y-3">
                                ${history.map(v => `
                                    <div class="border border-gray-200 rounded-lg p-3 hover:border-purple-300 transition-colors">
                                        <div class="flex items-center justify-between mb-2">
                                            <div class="flex items-center gap-2">
                                                ${getSourceIcon(v.source)}
                                                <span class="text-sm font-medium text-gray-700">${getFieldLabel(v.field_name)}</span>
                                                <span class="text-xs px-2 py-0.5 bg-gray-100 rounded-full text-gray-500">${v.source}</span>
                                            </div>
                                            <div class="flex items-center gap-2">
                                                <span class="text-xs text-gray-400">${formatDate(v.created_at)}</span>
                                                <button onclick="confirmRevert(${v.id}, '${v.field_name}')"
                                                        class="text-xs px-2 py-1 bg-amber-50 text-amber-700 rounded hover:bg-amber-100"
                                                        title="Revert to this version">
                                                    <i class="fas fa-undo mr-1"></i>Revert
                                                </button>
                                            </div>
                                        </div>
                                        ${v.field_name === 'draft_response' ? `
                                            <div class="mt-2 space-y-2">
                                                <div class="bg-red-50 border border-red-100 rounded p-2">
                                                    <div class="text-xs text-red-600 font-medium mb-1">Previous:</div>
                                                    <div class="text-xs text-gray-600 line-clamp-3">${v.old_value || '<em class="text-gray-400">Empty</em>'}</div>
                                                </div>
                                                <div class="bg-green-50 border border-green-100 rounded p-2">
                                                    <div class="text-xs text-green-600 font-medium mb-1">Changed to:</div>
                                                    <div class="text-xs text-gray-600 line-clamp-3">${v.new_value || '<em class="text-gray-400">Empty</em>'}</div>
                                                </div>
                                            </div>
                                        ` : `
                                            <div class="text-sm mt-1">
                                                <span class="text-red-500 line-through">${v.old_value || 'none'}</span>
                                                <i class="fas fa-arrow-right mx-2 text-gray-300"></i>
                                                <span class="text-green-600">${v.new_value || 'none'}</span>
                                            </div>
                                        `}
                                    </div>
                                `).join('')}
                            </div>
                        `}
                    </div>
                </div>
            `;

            document.body.appendChild(modal);
        }

        // Confirm revert action
        function confirmRevert(versionId, fieldName) {
            if (confirm(`Revert the ${fieldName === 'draft_response' ? 'response' : fieldName} to this previous version?`)) {
                revertToVersion(versionId);
                document.getElementById('version-history-modal')?.remove();
            }
        }

        // Check related comments for consistency after response change
        function checkRelatedCommentsConsistency(commentId, newResponse) {
            const related = getRelatedComments(commentId);
            const relatedWithResponses = [...related.direct, ...related.thematic].filter(c => c.draft_response);

            if (relatedWithResponses.length === 0) return;

            // Flag related comments that might need review
            const needsReview = relatedWithResponses.filter(c => {
                // Check if response mentions different key points
                const currentHasDamageStats = c.draft_response.includes('30.31%') || c.draft_response.includes('28');
                const newHasDamageStats = newResponse.includes('30.31%') || newResponse.includes('28');

                // If one mentions damage stats and the other doesn't in a damage-related category
                if (c.category === 'Authentication' || commentRelationships[commentId]?.groups.includes('dna_damage_authentication')) {
                    if (currentHasDamageStats !== newHasDamageStats) return true;
                }

                return false;
            });

            if (needsReview.length > 0) {
                showRelatedUpdateNotification(commentId, needsReview);
            } else if (relatedWithResponses.length > 0) {
                // Show subtle notification about related comments
                showNotification(`Response saved. ${relatedWithResponses.length} related comments may need review for consistency.`, 'info');
            }
        }

        // Show notification about related comments that may need updates
        function showRelatedUpdateNotification(sourceCommentId, relatedComments) {
            const modal = document.createElement('div');
            modal.id = 'related-update-modal';
            modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

            modal.innerHTML = `
                <div class="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
                    <div class="p-4 bg-gradient-to-r from-amber-500 to-orange-500 text-white">
                        <div class="flex items-center gap-3">
                            <i class="fas fa-exclamation-triangle text-xl"></i>
                            <div>
                                <h3 class="font-bold">Related Comments May Need Updates</h3>
                                <p class="text-sm opacity-80">Your response to ${sourceCommentId} was saved</p>
                            </div>
                        </div>
                    </div>
                    <div class="p-4">
                        <p class="text-sm text-gray-600 mb-3">
                            The following related comments may need to be reviewed for consistency:
                        </p>
                        <div class="space-y-2 max-h-60 overflow-y-auto">
                            ${relatedComments.map(c => `
                                <div class="p-3 bg-amber-50 rounded-lg border border-amber-200 cursor-pointer hover:bg-amber-100"
                                     onclick="openCommentModal('${c.reviewerId}', '${c.id}'); document.getElementById('related-update-modal')?.remove();">
                                    <div class="flex items-center justify-between">
                                        <span class="font-bold text-amber-800">${c.id}</span>
                                        <span class="text-xs bg-amber-200 text-amber-800 px-2 py-0.5 rounded">${c.category}</span>
                                    </div>
                                    <p class="text-xs text-amber-700 mt-1 line-clamp-2">${c.original_text.substring(0, 100)}...</p>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <div class="p-4 bg-gray-50 border-t flex justify-between">
                        <button onclick="regenerateRelatedResponses('${sourceCommentId}')" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                            <i class="fas fa-sync-alt mr-2"></i>Auto-Update Related
                        </button>
                        <button onclick="document.getElementById('related-update-modal')?.remove()" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm">
                            Review Later
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);
        }

        // Regenerate responses for related comments based on the source comment
        async function regenerateRelatedResponses(sourceCommentId) {
            const sourceComment = getAllComments().find(c => c.id === sourceCommentId);
            if (!sourceComment) return;

            const related = getRelatedComments(sourceCommentId);
            const relatedWithResponses = [...related.direct, ...related.thematic].filter(c => c.draft_response);

            document.getElementById('related-update-modal')?.remove();

            if (relatedWithResponses.length === 0) {
                showNotification('No related comments with responses to update', 'info');
                return;
            }

            showNotification(`Updating ${relatedWithResponses.length} related responses...`, 'info');

            // Ask OpenCode to review and suggest updates for related comments
            const prompt = `I just updated my response to reviewer comment ${sourceCommentId}:

**Comment ${sourceCommentId} (${sourceComment.category}):**
"${sourceComment.original_text.substring(0, 300)}"

**My new response:**
"${sourceComment.draft_response?.substring(0, 500) || 'No response yet'}"

Please review these related comments and suggest if their responses need to be updated for consistency:

${relatedWithResponses.slice(0, 3).map(c => `
**${c.id} (${c.category}):**
Comment: "${c.original_text.substring(0, 200)}"
Current response: "${c.draft_response?.substring(0, 200) || 'None'}"
`).join('\n')}

For each, briefly say whether the response needs updating and why (or "OK - consistent").`;

            try {
                showOpenCodeLoading('consistency-check', `Checking consistency for ${sourceCommentId}...`);
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt,
                        comment_id: `consistency-check-${sourceCommentId}`,
                        model: aiSettings.model,
                        agent: aiSettings.agent,
                        variant: aiSettings.variant
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    hideOpenCodeLoading('consistency-check', { success: true, message: 'Consistency check complete' });
                    // Show the consistency analysis in chat
                    if (!chatIsOpen) toggleChat();
                    addChatMessage('assistant', `📋 **Consistency Check for ${sourceCommentId}**\n\n${result.response}`);
                } else {
                    hideOpenCodeLoading('consistency-check', { success: false, message: 'Could not analyze consistency' });
                }
            } catch (e) {
                hideOpenCodeLoading('consistency-check', { success: false, message: e.message });
            }
        }

        // Agent functions - Direct OpenCode integration
        const agentSkillMap = {
            'dna-damage': {
                name: 'DNA Damage Authentication Expert',
                skill: 'dna-damage-auth',
                prompt: 'DNA damage patterns, authentication criteria, deamination analysis'
            },
            'phylogenetics': {
                name: 'Phylogenetics & Evolution Expert',
                skill: 'phylogenetics-evolution',
                prompt: 'Molecular clocks, tip dating, evolutionary analyses'
            },
            'microbial-ecology': {
                name: 'Microbial Ecology Expert',
                skill: 'microbial-ecology',
                prompt: 'Community composition, wetlands, methanogens'
            },
            'virology': {
                name: 'Ancient Virome Expert',
                skill: 'ancient-virome',
                prompt: 'Viral detection, IMG/VR, protein-based profiling'
            },
            'methods': {
                name: 'Bioinformatics Methods Expert',
                skill: 'bioinformatics-methods',
                prompt: 'Pipelines, parameters, validation approaches'
            }
        };

        // Current agent consultation state
        let currentAgentConsultation = null;

        // Ask a dynamic expert in the chat
        function askExpertInChat(expertName) {
            // Open chat if not already open
            if (!chatIsOpen) {
                toggleChat();
            }

            // Set the chat input with a question about this expert
            const chatInput = document.getElementById('chat-input');
            if (chatInput) {
                chatInput.value = `What insights does the "${expertName}" have about the reviewer comments? Summarize their key recommendations.`;
                chatInput.focus();
            }
        }

        function startAgentConsultation(agentId, commentContext = null) {
            const agent = agentSkillMap[agentId];
            currentAgentConsultation = { agentId, agent, commentContext };

            document.getElementById('agent-modal-title').textContent = `Consult: ${agent.name}`;
            document.getElementById('agent-modal-content').innerHTML = `
                <div class="space-y-4">
                    <!-- Connection Status -->
                    <div class="flex items-center justify-between p-3 rounded-lg ${apiConnected ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}">
                        <div class="flex items-center gap-2">
                            <span class="w-2 h-2 rounded-full ${apiConnected ? 'bg-green-500' : 'bg-yellow-500'}"></span>
                            <span class="text-sm ${apiConnected ? 'text-green-700' : 'text-yellow-700'}">
                                ${apiConnected ? 'OpenCode Ready - ' + aiSettings.model : 'OpenCode API offline - prompts will be copied'}
                            </span>
                        </div>
                        ${!apiConnected ? '<button onclick="checkApiConnection()" class="text-xs px-2 py-1 bg-yellow-100 rounded">Retry</button>' : ''}
                    </div>

                    <!-- Agent Info -->
                    <div class="bg-gradient-to-r ${agent.color || 'from-green-500 to-teal-500'} rounded-lg p-4 text-white">
                        <div class="flex items-center gap-3 mb-2">
                            <i class="fas ${agent.icon || 'fa-robot'} text-xl"></i>
                            <span class="font-semibold">${agent.name}</span>
                        </div>
                        <p class="text-sm text-white text-opacity-90">${agent.description || agent.prompt}</p>
                    </div>

                    <!-- Question Input -->
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">Your Question</label>
                        <textarea id="agent-question" class="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm" rows="4"
                                  placeholder="Ask the ${agent.name} anything...">${commentContext ? `Help me respond to comment ${commentContext.id}:\n\nReviewer said: "${commentContext.original_text.substring(0, 300)}${commentContext.original_text.length > 300 ? '...' : ''}"\n\nSuggest improvements or a better response.` : ''}</textarea>
                    </div>

                    <!-- Response Area -->
                    <div id="agent-response-area" class="hidden">
                        <label class="block text-sm font-medium text-gray-700 mb-2">OpenCode Response</label>
                        <div id="agent-response" class="bg-gray-50 border rounded-lg p-4 text-sm prose max-w-none"></div>
                    </div>

                    <!-- Loading -->
                    <div id="agent-loading" class="hidden text-center py-4">
                        <i class="fas fa-spinner fa-spin text-green-500 text-2xl mb-2"></i>
                        <p class="text-sm text-gray-600">OpenCode is thinking...</p>
                    </div>

                    <!-- Actions -->
                    <div class="flex justify-end gap-2 pt-2">
                        <button onclick="closeAgentModal()" class="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm">
                            Cancel
                        </button>
                        <button onclick="sendAgentQuestion()" id="send-agent-btn"
                                class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm disabled:opacity-50">
                            <i class="fas fa-paper-plane mr-2"></i>Ask OpenCode
                        </button>
                    </div>
                </div>
            `;
            document.getElementById('agent-modal').classList.remove('hidden');
        }

        async function sendAgentQuestion() {
            const question = document.getElementById('agent-question').value.trim();
            if (!question) {
                alert('Please enter a question.');
                return;
            }

            const agent = currentAgentConsultation?.agent;
            // Map agent skill to OpenCode skill name
            const skillMap = {
                'dna-damage-auth': '@dna-damage-auth',
                'microbial-ecology': '@microbial-ecology',
                'phylogenetics-evolution': '@phylogenetics-evolution',
                'ancient-virome': '@ancient-virome',
                'bioinformatics-methods': '@bioinformatics-methods'
            };
            const skill = skillMap[agent?.skill] || '@manuscript-reviewer';

            const prompt = `${skill}

QUESTION: ${question}

Provide expert guidance based on the manuscript context you have loaded. Be scientifically precise and use PAST TENSE when suggesting responses.`;

            document.getElementById('agent-loading').classList.remove('hidden');
            document.getElementById('send-agent-btn').disabled = true;

            try {
                const response = await fetch(`${API_BASE}/ask`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: prompt,
                        comment_id: currentAgentConsultation?.commentContext?.id || 'agent-consultation',
                        model: aiSettings.model,
                        agent: aiSettings.agent,
                        variant: aiSettings.variant
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    handleAgentResponse(result.response);
                } else {
                    throw new Error('API request failed');
                }
            } catch (e) {
                navigator.clipboard.writeText(prompt).then(() => {
                    alert('OpenCode server not available.\n\nPrompt copied to clipboard!\nRun: node opencode-server.js');
                });
                document.getElementById('agent-loading').classList.add('hidden');
                document.getElementById('send-agent-btn').disabled = false;
            }
        }

        function handleAgentResponse(response) {
            document.getElementById('agent-loading').classList.add('hidden');
            document.getElementById('send-agent-btn').disabled = false;
            document.getElementById('agent-response-area').classList.remove('hidden');
            document.getElementById('agent-response').innerHTML = marked.parse(response);
        }

        function closeAgentModal() {
            document.getElementById('agent-modal').classList.add('hidden');
            currentAgentConsultation = null;
        }

        // Help Modal Functions
        function openHelpModal() {
            document.getElementById('help-modal').classList.remove('hidden');
        }

        function closeHelpModal() {
            document.getElementById('help-modal').classList.add('hidden');
        }

        // Settings Modal Functions
        // Note: aiSettings is declared at the top of the file in global state

        async function loadAISettings() {
            try {
                // Try to load config from API server first
                const response = await fetch(`${API_BASE}/config`);
                if (response.ok) {
                    const config = await response.json();
                    aiSettings = {
                        model: config.model || aiSettings.model,
                        agent: config.agent || aiSettings.agent,
                        variant: config.variant || aiSettings.variant
                    };
                    return;
                }
            } catch (e) {
                // API not available, try static file
            }

            try {
                // Fallback to static config file
                const response = await fetch('opencode-config.json');
                if (response.ok) {
                    const config = await response.json();
                    aiSettings = {
                        model: config.model || aiSettings.model,
                        agent: config.agent || aiSettings.agent,
                        variant: config.variant || aiSettings.variant
                    };
                }
            } catch (e) {
                console.log('Using default AI settings');
            }
        }

        async function loadSessionInfo() {
            try {
                // Try paper-specific session first
                if (currentPaperId) {
                    const response = await fetch(`${API_BASE}/session/${currentPaperId}`);
                    if (response.ok) {
                        const session = await response.json();
                        return {
                            sessionId: session.opencode_session_id || null,
                            messageCount: session.messages?.length || 0,
                            model: session.model,
                            agent: session.agent,
                            variant: session.variant
                        };
                    }
                }
            } catch (e) {
                // Paper session not available
            }

            try {
                // Fallback to default session
                const response = await fetch(`${API_BASE}/session`);
                if (response.ok) {
                    const session = await response.json();
                    return {
                        sessionId: session.opencode_session_id || null,
                        messageCount: session.messages?.length || 0
                    };
                }
            } catch (e) {
                // API not available
            }
            return { sessionId: null, messageCount: 0 };
        }

        // Cache for available models
        let availableModels = null;

        async function loadModels(forceRefresh = false) {
            if (availableModels && !forceRefresh) {
                return availableModels;
            }

            const statusEl = document.getElementById('models-status');
            const selectEl = document.getElementById('settings-model');

            try {
                if (statusEl) statusEl.textContent = 'Fetching available models from OpenCode...';

                const response = await fetch(`${API_BASE}/models`);
                if (response.ok) {
                    const data = await response.json();
                    availableModels = data.models;

                    // Populate the select dropdown
                    populateModelsDropdown(selectEl, availableModels, aiSettings.model);

                    if (statusEl) {
                        statusEl.textContent = `${availableModels.list.length} models available`;
                        statusEl.className = 'text-xs text-green-600 mt-1';
                    }

                    return availableModels;
                }
            } catch (e) {
                console.log('Could not fetch models from API:', e);
            }

            // Fallback: show error
            if (statusEl) {
                statusEl.textContent = 'Could not load models. Start opencode-server.js';
                statusEl.className = 'text-xs text-red-500 mt-1';
            }

            // Add a fallback option
            selectEl.innerHTML = `<option value="${aiSettings.model}">${aiSettings.model}</option>`;

            return null;
        }

        function populateModelsDropdown(selectEl, models, currentModel) {
            selectEl.innerHTML = '';

            if (!models || !models.grouped) {
                selectEl.innerHTML = `<option value="">No models available</option>`;
                return;
            }

            // Create optgroups by provider
            const providers = Object.keys(models.grouped).sort();

            for (const provider of providers) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = formatProviderName(provider);

                for (const model of models.grouped[provider]) {
                    const option = document.createElement('option');
                    option.value = model.id;
                    option.textContent = model.name || model.id.split('/')[1];
                    if (model.description) {
                        option.textContent += ` (${model.description})`;
                    }
                    if (model.current) {
                        option.textContent += ' ★';
                    }
                    if (model.id === currentModel) {
                        option.selected = true;
                    }
                    optgroup.appendChild(option);
                }

                selectEl.appendChild(optgroup);
            }
        }

        function formatProviderName(provider) {
            const names = {
                'openai': 'OpenAI',
                'opencode': 'OpenCode',
                'anthropic': 'Anthropic',
                'google': 'Google',
                'github-copilot': 'GitHub Copilot'
            };
            return names[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
        }

        async function refreshModels() {
            const btn = event.target.closest('button');
            const icon = btn.querySelector('i');
            icon.classList.add('fa-spin');

            await loadModels(true);

            icon.classList.remove('fa-spin');
            showNotification('Models refreshed', 'success');
        }

        async function openSettingsModal() {
            await loadAISettings();
            const sessionInfo = await loadSessionInfo();

            // Show modal first
            document.getElementById('settings-modal').classList.remove('hidden');

            // Load models dynamically
            await loadModels();

            // Update select values (after models are loaded)
            const modelSelect = document.getElementById('settings-model');
            if (modelSelect.querySelector(`option[value="${aiSettings.model}"]`)) {
                modelSelect.value = aiSettings.model;
            }
            document.getElementById('settings-agent').value = aiSettings.agent;
            document.getElementById('settings-variant').value = aiSettings.variant;

            // Update session info
            document.getElementById('settings-session-id').textContent = sessionInfo.sessionId || 'None (new session)';
            document.getElementById('settings-message-count').textContent = sessionInfo.messageCount;
        }

        function closeSettingsModal() {
            document.getElementById('settings-modal').classList.add('hidden');
        }

        async function saveSettings() {
            const newSettings = {
                model: document.getElementById('settings-model').value,
                agent: document.getElementById('settings-agent').value,
                variant: document.getElementById('settings-variant').value
            };

            try {
                // Try to save via API server
                const response = await fetch(`${API_BASE}/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newSettings)
                });

                if (response.ok) {
                    const result = await response.json();
                    aiSettings = newSettings;
                    closeSettingsModal();
                    showNotification('Settings saved! Model: ' + newSettings.model, 'success');
                    updateChatModelIndicator();
                    return;
                }
            } catch (e) {
                console.log('API not available, saving locally');
            }

            // Fallback: save to localStorage
            localStorage.setItem('opencode-settings', JSON.stringify(newSettings));
            aiSettings = newSettings;
            closeSettingsModal();
            updateChatModelIndicator();
            showNotification('Settings saved locally (start opencode-server.js to persist)', 'info');
        }

        async function resetSession() {
            if (!confirm('This will start a fresh conversation with the AI. Previous context will be lost. Continue?')) {
                return;
            }

            try {
                // Try to reset via API server
                const response = await fetch(`${API_BASE}/session/reset`, {
                    method: 'POST'
                });

                if (response.ok) {
                    // Update UI
                    document.getElementById('settings-session-id').textContent = 'None (new session)';
                    document.getElementById('settings-message-count').textContent = '0';
                    showNotification('Session reset. Next message will start fresh.', 'success');
                    return;
                }
            } catch (e) {
                console.log('API not available');
            }

            // Fallback: just clear localStorage
            localStorage.removeItem('opencode-session');
            document.getElementById('settings-session-id').textContent = 'None (new session)';
            document.getElementById('settings-message-count').textContent = '0';
            showNotification('Session reset locally', 'info');
        }

        function showNotification(message, type = 'info') {
            const notif = document.createElement('div');
            notif.className = 'notification-toast';
            notif.setAttribute('data-type', type);

            const icon = type === 'success' ? 'fa-check-circle' :
                        type === 'error' ? 'fa-exclamation-circle' :
                        type === 'warning' ? 'fa-exclamation-triangle' :
                        'fa-info-circle';

            notif.innerHTML = `
                <div class="notification-icon"><i class="fas ${icon}"></i></div>
                <div class="notification-message">${escapeHtml(message)}</div>
            `;
            document.body.appendChild(notif);

            // Auto-remove after 3 seconds with fade out
            setTimeout(() => {
                notif.classList.add('fade-out');
                setTimeout(() => notif.remove(), 300);
            }, 3000);
        }

        // Load settings on startup
        loadAISettings();

        function copyToClipboard() {
            const text = document.getElementById('agent-question').value;
            navigator.clipboard.writeText(text).then(() => {
                const btn = event.target.closest('button');
                const originalHTML = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-check mr-2"></i>Copied!';
                setTimeout(() => btn.innerHTML = originalHTML, 2000);
            });
        }

        function copyPrompt(text) {
            navigator.clipboard.writeText(text).then(() => {
                const btn = event.target.closest('button');
                if (btn) {
                    const originalHTML = btn.innerHTML;
                    btn.innerHTML = '<i class="fas fa-check text-green-500 mr-2"></i>Copied!';
                    btn.classList.add('bg-green-50');
                    setTimeout(() => {
                        btn.innerHTML = originalHTML;
                        btn.classList.remove('bg-green-50');
                    }, 2000);
                }
            });
        }

        function consultAgent(reviewerId, commentId) {
            const reviewer = reviewData.reviewers.find(r => r.id === reviewerId);
            const comment = reviewer?.comments.find(c => c.id === commentId);
            if (!comment) return;

            // Determine best agent based on comment category
            const categoryAgentMap = {
                'Authentication': 'dna-damage',
                'Analysis': 'methods',
                'Validation': 'dna-damage',
                'Figure': 'methods',
                'Methods': 'methods',
                'Interpretation': 'microbial-ecology',
                'Novelty': 'microbial-ecology',
                'Terminology': 'microbial-ecology',
                'Database': 'methods',
                'Results': 'microbial-ecology',
                'Discussion': 'microbial-ecology',
                'Focus': 'methods'
            };

            const agentId = categoryAgentMap[comment.category] || 'methods';
            startAgentConsultation(agentId, comment);
        }

        // Export functions
        function exportJSON() {
            const dataStr = JSON.stringify(reviewData, null, 2);
            const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
            const exportName = 'review_data_' + new Date().toISOString().split('T')[0] + '.json';

            const linkElement = document.createElement('a');
            linkElement.setAttribute('href', dataUri);
            linkElement.setAttribute('download', exportName);
            linkElement.click();
        }

        function exportToWord() {
            alert('Word export will be generated. This integrates with the docx skill in OpenCode.');
            // This would trigger the docx generation through OpenCode
        }

        function exportSummary() {
            const allComments = getAllComments();
            const summary = {
                manuscript: reviewData.manuscript,
                statistics: {
                    total: allComments.length,
                    completed: allComments.filter(c => c.status === 'completed').length,
                    major: allComments.filter(c => c.type === 'major').length,
                    needsAnalysis: allComments.filter(c => c.requires_new_analysis).length
                },
                reviewers: reviewData.reviewers.map(r => ({
                    name: r.name,
                    comments: r.comments.length,
                    completed: r.comments.filter(c => c.status === 'completed').length
                }))
            };

            const dataStr = JSON.stringify(summary, null, 2);
            const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
            const linkElement = document.createElement('a');
            linkElement.setAttribute('href', dataUri);
            linkElement.setAttribute('download', 'review_summary.json');
            linkElement.click();
        }

        function generateTrackChanges() {
            alert('Track changes script will be generated for manuscript modifications. This integrates with the docx skill.');
        }

        // Save progress (uses database functions defined earlier)
        async function saveProgress() {
            const saved = await saveCommentsToDb();
            if (saved) {
                showNotification(`Progress saved to ${dbStatus.storage}!`, 'success');
            } else {
                showNotification('Progress saved to browser storage (start server for persistence)', 'info');
            }
        }

        function loadNewManuscript() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = async (e) => {
                const file = e.target.files[0];
                const text = await file.text();
                reviewData = JSON.parse(text);
                updateSidebar();
                setView('overview');
            };
            input.click();
        }
