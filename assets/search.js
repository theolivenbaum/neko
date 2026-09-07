// Search UI
(function() {
    let miniSearch = null;
    let indexLoadPromise = null;
    let isSearchOpen = false;

    const RECENT_KEY = 'neko-search-recent';
    const RECENT_LIMIT = 5;

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function getRecent() {
        try {
            const raw = localStorage.getItem(RECENT_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.slice(0, RECENT_LIMIT) : [];
        } catch { return []; }
    }

    function pushRecent(query) {
        if (!query) return;
        const trimmed = query.trim();
        if (!trimmed) return;
        try {
            const existing = getRecent().filter(q => q.toLowerCase() !== trimmed.toLowerCase());
            existing.unshift(trimmed);
            localStorage.setItem(RECENT_KEY, JSON.stringify(existing.slice(0, RECENT_LIMIT)));
        } catch { /* ignore quota / disabled storage */ }
    }

    // Load search index
    function loadSearchIndex() {
        if (miniSearch) return Promise.resolve();
        if (indexLoadPromise) return indexLoadPromise;
        indexLoadPromise = (async () => {
            try {
                // Always fetch the aggregated index from the root, not the
                // sub-project copy at <prefix>/search.json. In a multi-repo
                // build the root output contains every sub-project's entries
                // (with route-prefixed ids), so a search from any sub-site can
                // find pages anywhere on the site.
                const response = await fetch('/search.json');
                const data = await response.json();

                // Normalize the current sub-site's route prefix to the same
                // shape document ids use ("workspace", no leading slash) so we
                // can cheaply test `id.startsWith(currentPrefix + "/")`. If the
                // visitor is on the root project the prefix is empty and the
                // sub-site boost is skipped entirely.
                let currentPrefix = (window.NEKO_ROUTE_PREFIX || '').replace(/\\/g, '/');
                while (currentPrefix.startsWith('/')) currentPrefix = currentPrefix.slice(1);
                while (currentPrefix.endsWith('/'))   currentPrefix = currentPrefix.slice(0, -1);
                const currentPrefixSegment = currentPrefix ? currentPrefix + '/' : '';

                const ms = new MiniSearch({
                    fields: ['title', 'content', 'headings', 'slug'],
                    storeFields: ['title', 'content', 'parentTitle', 'parentId', 'type', 'slug', 'tags', 'cover', 'breadcrumbs'],
                    searchOptions: {
                        boost: { title: 3, slug: 4, headings: 2 },
                        boostDocument: (id, _term, stored) => {
                            // Tiny tilt toward page-level docs so a page wins over its own
                            // sections when scores are close — feels right when typing a
                            // page name (e.g. "index", "roadmap") rather than a phrase.
                            let factor = stored && stored.type === 'page' ? 1.15 : 1;
                            // Substantial boost for results that live under the
                            // sub-site the visitor is currently browsing. Other
                            // sub-sites stay reachable but rank below the local
                            // match, which matches how people use search — they
                            // expect "their" section's hits first.
                            if (currentPrefixSegment && typeof id === 'string' && id.startsWith(currentPrefixSegment)) {
                                factor *= 1.6;
                            }
                            return factor;
                        },
                        fuzzy: term => term.length > 3 ? 0.2 : false,
                        prefix: term => term.length > 1,
                        combineWith: 'AND'
                    }
                });
                ms.addAll(data);
                miniSearch = ms;
            } catch (error) {
                console.error('Failed to load search index', error);
                indexLoadPromise = null;
                throw error;
            }
        })();
        return indexLoadPromise;
    }

    function renderStatus(container, icon, title, subtitle) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <div class="bg-gray-100 dark:bg-gray-700/50 rounded-full p-4 mb-4">
                    <i class="${icon} text-2xl text-gray-500 dark:text-gray-400"></i>
                </div>
                <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">${title}</h3>
                <p class="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto">${subtitle}</p>
            </div>
        `;
    }

    function renderEmptyState(container, input) {
        const recent = getRecent();
        if (recent.length === 0) {
            renderStatus(container, 'fi fi-rr-search', 'Type to search', 'Start typing to search the documentation.');
            return;
        }
        container.innerHTML = `
            <div class="px-4 pt-3 pb-1 flex items-center justify-between">
                <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Recent searches</span>
                <button type="button" id="search-recent-clear" class="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">Clear</button>
            </div>
            ${recent.map(q => `
                <button type="button" data-recent="${escapeHtml(q)}" class="recent-item w-full text-left flex items-center gap-3 px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <i class="fi fi-rr-time-past text-gray-400"></i>
                    <span class="text-sm text-gray-700 dark:text-gray-200">${escapeHtml(q)}</span>
                </button>
            `).join('')}
        `;
        const clearBtn = container.querySelector('#search-recent-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                try { localStorage.removeItem(RECENT_KEY); } catch {}
                renderEmptyState(container, input);
            });
        }
        container.querySelectorAll('.recent-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const q = btn.getAttribute('data-recent');
                input.value = q;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
            });
        });
    }

    function highlight(escapedText, terms) {
        if (!terms || terms.length === 0) return escapedText;
        const patterns = terms
            .map(t => t && t.trim())
            .filter(Boolean)
            .map(escapeRegex);
        if (patterns.length === 0) return escapedText;
        const re = new RegExp('(' + patterns.join('|') + ')', 'gi');
        return escapedText.replace(re, '<mark class="bg-yellow-200 dark:bg-yellow-700/50 rounded px-0.5 text-inherit">$1</mark>');
    }

    function makeSnippet(text, terms, len = 160) {
        if (!text) return '';
        let pos = -1;
        const lower = text.toLowerCase();
        for (const t of terms || []) {
            if (!t) continue;
            const i = lower.indexOf(t.toLowerCase());
            if (i >= 0 && (pos < 0 || i < pos)) pos = i;
        }
        if (pos < 0) pos = 0;
        const start = Math.max(0, pos - 40);
        const end = Math.min(text.length, start + len);
        let snip = text.slice(start, end);
        if (start > 0) snip = '… ' + snip;
        if (end < text.length) snip = snip + ' …';
        return highlight(escapeHtml(snip), terms);
    }

    // Show at most one result per parent page. Results are already sorted by
    // score, so the highest-scoring entry (page or section) for each page wins
    // and the rest are dropped. This keeps the list focused on distinct pages
    // while still surfacing section anchors when a section is a stronger match
    // than the page itself.
    function dedupePerPage(results) {
        const seenPages = new Set();
        const out = [];
        for (const r of results) {
            const pageKey = r.type === 'section' ? r.parentId : r.id;
            if (!pageKey) { out.push(r); continue; }
            if (seenPages.has(pageKey)) continue;
            seenPages.add(pageKey);
            out.push(r);
        }
        return out;
    }

    function createSearchModal() {
        let selectedIndex = -1;
        const modal = document.createElement('div');
        modal.id = 'search-modal';
        // Phones get a smaller top offset and side padding so the panel doesn't sit
        // half a screen down and doesn't run edge-to-edge (which clips its rounded
        // corners); from `sm` up it keeps the original centred-at-24 placement.
        modal.className = 'fixed inset-0 z-50 flex items-start justify-center px-4 pt-16 sm:px-0 sm:pt-24 hidden';
        modal.innerHTML = `
            <div class="fixed inset-0 bg-gray-900/50 backdrop-blur-sm" id="search-backdrop"></div>
            <div class="relative w-full max-w-lg bg-white dark:bg-gray-800 rounded-xl shadow-2xl ring-1 ring-black/5 overflow-hidden">
                <div class="flex items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                    <i id="search-icon" class="fi fi-rr-search text-gray-500 mr-3 text-lg"></i>
                    <input type="text" id="search-input" class="w-full bg-transparent border-none focus:outline-none focus:ring-0 text-gray-900 dark:text-gray-100 placeholder-gray-500 mr-3 px-0 py-1" placeholder="Search documentation..." autocomplete="off">
                    <button id="search-close" class="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded text-gray-500 border border-gray-200 dark:border-gray-600">ESC</button>
                </div>
                <div id="search-results" class="max-h-[60vh] sm:max-h-96 overflow-y-auto py-2"></div>
                <div id="search-footer" class="px-4 py-2 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 hidden sm:flex justify-end items-center space-x-4">
                    <div class="flex items-center space-x-1">
                        <kbd class="px-1.5 py-0.5 text-[10px] font-sans bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400">↑</kbd>
                        <kbd class="px-1.5 py-0.5 text-[10px] font-sans bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400">↓</kbd>
                        <span class="ml-1">to navigate</span>
                    </div>
                    <div class="flex items-center space-x-1">
                        <kbd class="px-1.5 py-0.5 text-[10px] font-sans bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400">↵</kbd>
                        <span class="ml-1">to open</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Event listeners
        const input = modal.querySelector('#search-input');
        const backdrop = modal.querySelector('#search-backdrop');
        const closeBtn = modal.querySelector('#search-close');
        const icon = modal.querySelector('#search-icon');
        const resultsContainer = modal.querySelector('#search-results');

        renderEmptyState(resultsContainer, input);

        backdrop.addEventListener('click', closeSearch);
        closeBtn.addEventListener('click', closeSearch);

        function runSearch(query) {
            if (!miniSearch) {
                renderStatus(resultsContainer, 'fi fi-rr-spinner', 'Loading search…', 'Indexing the documentation, just a moment.');
                return;
            }
            const raw = miniSearch.search(query);
            const results = dedupePerPage(raw).slice(0, 20);
            renderResults(results, resultsContainer, input);
        }

        input.addEventListener('input', (e) => {
            selectedIndex = -1;
            const query = e.target.value;
            if (!query) {
                renderEmptyState(resultsContainer, input);
                return;
            }
            if (miniSearch) {
                runSearch(query);
            } else {
                icon.classList.add('animate-spin');
                renderStatus(resultsContainer, 'fi fi-rr-spinner animate-spin', 'Loading search…', 'Indexing the documentation, just a moment.');
                loadSearchIndex().then(() => {
                    icon.classList.remove('animate-spin');
                    // Only re-run if the user hasn't cleared / changed away.
                    if (input.value === query) runSearch(query);
                    else if (input.value) runSearch(input.value);
                    else renderEmptyState(resultsContainer, input);
                }).catch(() => {
                    icon.classList.remove('animate-spin');
                    renderStatus(resultsContainer, 'fi fi-rr-triangle-warning', 'Search unavailable', 'The search index could not be loaded.');
                });
            }
        });

        function updateSelection() {
            const items = resultsContainer.querySelectorAll('a');
            items.forEach((item, index) => {
                if (index === selectedIndex) {
                    item.classList.add('bg-gray-100', 'dark:bg-gray-700/50');
                    item.scrollIntoView({ block: 'nearest' });
                } else {
                    item.classList.remove('bg-gray-100', 'dark:bg-gray-700/50');
                }
            });
        }

        input.addEventListener('keydown', (e) => {
            const items = resultsContainer.querySelectorAll('a');
            if (e.key === 'Enter') {
                if (selectedIndex >= 0 && selectedIndex < items.length) {
                    e.preventDefault();
                    pushRecent(input.value);
                    items[selectedIndex].click();
                } else if (items.length > 0) {
                    e.preventDefault();
                    pushRecent(input.value);
                    items[0].click();
                }
                return;
            }
            if (items.length === 0) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIndex = (selectedIndex + 1) % items.length;
                updateSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIndex = (selectedIndex <= 0) ? items.length - 1 : selectedIndex - 1;
                updateSelection();
            }
        });
    }

    function renderResults(results, container, inputEl, options) {
        const hideBreadcrumbs = !!(options && options.hideBreadcrumbs);
        if (results.length === 0) {
            renderStatus(container, 'fi fi-rr-search', 'No results found', 'We couldn\'t find any items matching your search criteria.');
            return;
        }

        container.innerHTML = results.map((result) => {
            // Split id into path + anchor for section results. In a multi-repo
            // build the id already carries the sub-project's route prefix
            // (e.g. `workspace/core-concepts/graph-model.html`), so we don't
            // re-apply NEKO_ROUTE_PREFIX — that would double-prefix when the
            // result lives in a different sub-site than the one being viewed.
            const rawId = String(result.id);
            const hashIdx = rawId.indexOf('#');
            let pathPart = hashIdx >= 0 ? rawId.slice(0, hashIdx) : rawId;
            const anchor = hashIdx >= 0 ? rawId.slice(hashIdx) : '';

            let href = pathPart.replace(/\\/g, '/');
            if (!href.startsWith('/')) href = '/' + href;

            href = href + anchor;

            const terms = result.terms || [];
            const titleHtml = highlight(escapeHtml(result.title || ''), terms);
            const snippet = makeSnippet(result.content || '', terms);

            // Breadcrumb trail above the title: the page's ancestor group titles
            // from the navigation, plus the parent page title for section hits.
            // Pages that aren't part of the configured navigation fall back to
            // their directory path segments so results stay distinguishable.
            // Breadcrumbs are suppressed in blog mode: every post lives under
            // "blog", so the trail is always the same single crumb and just adds
            // noise above the title.
            let crumbs = [];
            if (!hideBreadcrumbs) {
                crumbs = Array.isArray(result.breadcrumbs) ? result.breadcrumbs.filter(Boolean) : [];
                if (crumbs.length === 0) {
                    const segments = pathPart.replace(/\\/g, '/').replace(/\.html$/i, '').split('/').filter(Boolean);
                    if (segments.length > 0 && segments[segments.length - 1].toLowerCase() === 'index') segments.pop();
                    segments.pop(); // the page's own segment — the title line already names it
                    crumbs = segments;
                }
                if (result.type === 'section' && result.parentTitle) {
                    crumbs = crumbs.concat(result.parentTitle);
                }
            }

            const crumbSeparator = '<i class="fi fi-rr-angle-small-right text-[9px] leading-none shrink-0" aria-hidden="true"></i>';
            const breadcrumb = crumbs.length > 0
                ? `<div class="flex items-center gap-1 min-w-0 text-[11px] text-gray-400 dark:text-gray-500 mb-1">${crumbs.map(c => `<span class="truncate">${escapeHtml(c)}</span>`).join(crumbSeparator)}</div>`
                : '';

            // Surface a page's tags as chips below the snippet. Tag text that
            // matches the query is highlighted so it's obvious why a tag-only
            // match surfaced.
            const tags = Array.isArray(result.tags) ? result.tags.filter(Boolean) : [];
            const tagsHtml = tags.length > 0
                ? `<div class="flex flex-wrap items-center gap-1.5 mt-2">${tags.slice(0, 6).map(t => `<span class="inline-flex items-center gap-1 text-[11px] font-medium rounded-full bg-gray-100 dark:bg-gray-700/60 text-gray-600 dark:text-gray-300 px-2 py-0.5"><i class="fi fi-rr-hashtag text-[9px] opacity-70" aria-hidden="true"></i>${highlight(escapeHtml(t), terms)}</span>`).join('')}</div>`
                : '';

            // Cover thumbnail (blog post `cover:`), shown as a leading tile. The
            // tile is always rendered at a fixed size so result rows line up
            // whether or not a post has a cover: a placeholder picture icon sits
            // behind, the real cover (when present and loadable) covers it, and a
            // missing or broken cover hides itself (onerror) so the placeholder
            // shows instead of collapsing the row.
            const cover = result.cover ? String(result.cover) : '';
            const coverHtml = `
                <div class="relative shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-700">
                    <span class="absolute inset-0 flex items-center justify-center"><i class="fi fi-rr-picture text-lg text-gray-400 dark:text-gray-500" aria-hidden="true"></i></span>
                    ${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" onload="this.previousElementSibling.style.display='none'" onerror="this.style.display='none'" class="absolute inset-0 w-full h-full object-cover">` : ''}
                </div>`;

            return `
            <a href="${href}" class="flex gap-3 px-4 py-3 hover:bg-gray-100 dark:hover:bg-gray-700/50 group">
                ${coverHtml}
                <div class="min-w-0 flex-1">
                    ${breadcrumb}
                    <div class="text-base font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 leading-snug">
                        ${titleHtml}
                    </div>
                    ${snippet ? `<div class="text-xs text-gray-500 dark:text-gray-400 mt-1.5 line-clamp-2">${snippet}</div>` : ''}
                    ${tagsHtml}
                </div>
            </a>
        `;
        }).join('');

        // Record recent query when a result is clicked. The owning input is
        // passed in (the modal's, or the blog's inline box); fall back to the
        // modal input id for older callers.
        const input = inputEl || document.getElementById('search-input');
        container.querySelectorAll('a').forEach(a => {
            a.addEventListener('click', () => { if (input) pushRecent(input.value); });
        });
    }

    function openSearch() {
        if (!document.getElementById('search-modal')) {
            createSearchModal();
        }
        const modal = document.getElementById('search-modal');
        modal.classList.remove('hidden');
        document.getElementById('search-input').focus();
        isSearchOpen = true;
        loadSearchIndex().catch(() => { /* surfaced when user types */ });
    }

    function closeSearch() {
        const modal = document.getElementById('search-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
        isSearchOpen = false;
    }

    // Global keyboard shortcut (Ctrl+K or Cmd+K)
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            if (isSearchOpen) closeSearch();
            else openSearch();
        }
        if (e.key === 'Escape' && isSearchOpen) {
            closeSearch();
        }
    });

    // Expose openSearch to button clicks
    window.openSearch = openSearch;

    // Inline search — used by blog mode instead of the modal. The builder
    // renders an in-page <input id="neko-inline-search"> with a results
    // container (#neko-inline-search-results), an optional tag-chip row
    // (#neko-blog-tags) and the post grid (#neko-blog-grid). Typing filters the
    // index live to blog posts only and shows the results in place of the grid;
    // clearing the box restores the grid. The tag chips filter the grid in place
    // (cards, not result rows) so an empty query can still narrow by tag.
    function initInlineSearch() {
        const input = document.getElementById('neko-inline-search');
        const resultsContainer = document.getElementById('neko-inline-search-results');
        if (!input || !resultsContainer) return;
        const grid = document.getElementById('neko-blog-grid');
        const tagsContainer = document.getElementById('neko-blog-tags');
        const emptyEl = document.getElementById('neko-blog-empty');
        let selectedIndex = -1;
        let activeTag = '';

        // The id prefix every blog post carries in the search index. Blog posts
        // always live under `blog/` (see SiteBuilder), optionally behind a
        // multi-repo route prefix. We use this to keep the inline search focused
        // on posts only — other pages (about, contact, …) stay out of the results.
        let routePrefix = (window.NEKO_ROUTE_PREFIX || '').replace(/\\/g, '/');
        while (routePrefix.startsWith('/')) routePrefix = routePrefix.slice(1);
        while (routePrefix.endsWith('/'))   routePrefix = routePrefix.slice(0, -1);
        const blogPrefix = (routePrefix ? routePrefix + '/' : '') + 'blog/';

        function isBlogResult(r) {
            const key = r.type === 'section' ? (r.parentId || r.id) : r.id;
            if (typeof key !== 'string' || !key.startsWith(blogPrefix)) return false;
            // The blog landing page is the index, not a post — keep it out.
            return key !== blogPrefix + 'index.html' && key !== blogPrefix + 'index';
        }

        function hasTag(r, tag) {
            return Array.isArray(r.tags) && r.tags.some(t => t && String(t).toLowerCase() === tag);
        }

        // Must mirror chipBase/chipIdleColors/chipActiveStyle in RenderBlogIndex
        // (HtmlGenerator.Content.cs) so the script-applied state matches the
        // server-rendered initial state. The active fill is the blog ink colour,
        // applied as an inline style (CSS vars can't go through a Tailwind class).
        function chipClass(on) {
            return 'neko-blog-tag inline-flex items-center gap-1.5 text-sm font-medium rounded-full border px-3 py-1 transition-colors cursor-pointer'
                + (on
                    ? ''
                    : ' border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50');
        }

        function applyChipStyle(btn, on) {
            if (on) {
                btn.style.backgroundColor = 'var(--blog-ink,#1f1f1f)';
                btn.style.borderColor = 'var(--blog-ink,#1f1f1f)';
                btn.style.color = 'var(--blog-bg,#f1f1f1)';
            } else {
                btn.style.backgroundColor = '';
                btn.style.borderColor = '';
                btn.style.color = '';
            }
        }

        function styleChips() {
            if (!tagsContainer) return;
            tagsContainer.querySelectorAll('[data-tag]').forEach(btn => {
                const on = (btn.getAttribute('data-tag') || '') === activeTag;
                btn.className = chipClass(on);
                applyChipStyle(btn, on);
            });
        }

        // Filter the post cards in place by the active tag. With no active tag every
        // card shows; an empty match surfaces the "no posts" note.
        function filterGrid() {
            if (!grid) return;
            let visible = 0;
            Array.from(grid.children).forEach(card => {
                const tags = (card.getAttribute('data-tags') || '').split('|').filter(Boolean);
                const show = !activeTag || tags.indexOf(activeTag) >= 0;
                card.classList.toggle('hidden', !show);
                if (show) visible++;
            });
            if (emptyEl) emptyEl.classList.toggle('hidden', visible !== 0);
        }

        // Card mode: hide the search-result rows and show the (tag-filtered) grid.
        function showCards() {
            resultsContainer.classList.add('hidden');
            resultsContainer.innerHTML = '';
            if (grid) grid.classList.remove('hidden');
            filterGrid();
        }

        // Results mode: show the highlighted search rows, hide the grid.
        function showSearch() {
            resultsContainer.classList.remove('hidden');
            if (grid) grid.classList.add('hidden');
            if (emptyEl) emptyEl.classList.add('hidden');
        }

        function runSearch(query) {
            if (!miniSearch) return;
            const raw = miniSearch.search(query);
            let results = dedupePerPage(raw).filter(isBlogResult);
            if (activeTag) results = results.filter(r => hasTag(r, activeTag));
            results = results.slice(0, 20);
            renderResults(results, resultsContainer, input, { hideBreadcrumbs: true });
        }

        if (tagsContainer) {
            styleChips();
            tagsContainer.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-tag]');
                if (!btn) return;
                const tag = btn.getAttribute('data-tag') || '';
                // Re-clicking the active tag clears it; the "All" chip (tag === '')
                // always clears.
                activeTag = (tag && tag === activeTag) ? '' : tag;
                styleChips();
                input.value = '';
                selectedIndex = -1;
                showCards();
            });
        }

        function updateSelection() {
            const items = resultsContainer.querySelectorAll('a');
            items.forEach((item, index) => {
                const on = index === selectedIndex;
                item.classList.toggle('bg-gray-100', on);
                item.classList.toggle('dark:bg-gray-700/50', on);
                if (on) item.scrollIntoView({ block: 'nearest' });
            });
        }

        // Warm the index on first focus so results appear instantly on type.
        input.addEventListener('focus', () => { loadSearchIndex().catch(() => {}); }, { once: true });

        input.addEventListener('input', (e) => {
            selectedIndex = -1;
            const query = e.target.value.trim();
            if (!query) {
                // Empty query: fall back to the (tag-filtered) cards, never an
                // empty highlighted result list.
                showCards();
                return;
            }
            showSearch();
            if (miniSearch) {
                runSearch(query);
            } else {
                renderStatus(resultsContainer, 'fi fi-rr-spinner animate-spin', 'Loading search…', 'Indexing the blog, just a moment.');
                loadSearchIndex().then(() => {
                    const current = input.value.trim();
                    if (current) runSearch(current);
                    else showCards();
                }).catch(() => {
                    renderStatus(resultsContainer, 'fi fi-rr-triangle-warning', 'Search unavailable', 'The search index could not be loaded.');
                });
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                input.value = '';
                selectedIndex = -1;
                showCards();
                input.blur();
                return;
            }
            const items = resultsContainer.querySelectorAll('a');
            if (e.key === 'Enter') {
                if (selectedIndex >= 0 && selectedIndex < items.length) {
                    e.preventDefault();
                    pushRecent(input.value);
                    items[selectedIndex].click();
                } else if (items.length > 0) {
                    e.preventDefault();
                    pushRecent(input.value);
                    items[0].click();
                }
                return;
            }
            if (items.length === 0) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIndex = (selectedIndex + 1) % items.length;
                updateSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIndex = (selectedIndex <= 0) ? items.length - 1 : selectedIndex - 1;
                updateSelection();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initInlineSearch);
    } else {
        initInlineSearch();
    }

})();
