(function() {
    // Password-protected pages ship their content encrypted (AES-GCM); the key is
    // derived from the password with PBKDF2. Deriving the key is deliberately slow,
    // so we pay it once: on the first successful unlock the derived key is cached in
    // sessionStorage, keyed by the page's salt. Every page protected with the same
    // password shares that salt (see PageEncryptor.DeriveSalt), so subsequent pages
    // reuse the cached key and decrypt immediately — no re-derivation, and the
    // password prompt (hidden by default) is never shown again this session.

    const PBKDF2_ITERATIONS = 100000;

    function b64ToBytes(b64) {
        return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    }

    function bytesToB64(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }

    // sessionStorage cache key for a derived AES key, namespaced by the page salt so
    // pages protected with different passwords (different salts) don't collide.
    function cacheName(saltB64) {
        return "neko-pw-key:" + saltB64;
    }

    // sessionStorage cache key for a page's decrypted body, namespaced by path so
    // each page caches its own HTML. The body is no more exposed than the derived
    // key cached above (anyone with that key can decrypt every page); both live in
    // sessionStorage and clear when the tab closes. Caching the plaintext lets a
    // revisited — or hover-prefetched — protected page paint its content on the
    // first frame instead of flashing the empty placeholder while it re-decrypts.
    function contentCacheName(path) {
        return "neko-pw-html:" + path;
    }

    function cacheContent(path, saltB64, html) {
        try {
            sessionStorage.setItem(contentCacheName(path), JSON.stringify({ salt: saltB64, html: html }));
        } catch (e) {
            // Non-fatal (e.g. quota): we simply re-decrypt on the next visit.
        }
    }

    async function importRawKey(rawBytes) {
        return window.crypto.subtle.importKey(
            "raw", rawBytes, { name: "AES-GCM" }, true, ["decrypt"]
        );
    }

    // Slow path: stretch the password into an AES-GCM key with PBKDF2. The key is
    // marked extractable so it can be exported and cached for the session.
    async function deriveKey(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
        );
        return window.crypto.subtle.deriveKey(
            { name: "PBKDF2", salt: salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            true,
            ["decrypt"]
        );
    }

    async function decryptWithKey(payload, key) {
        const iv = b64ToBytes(payload.iv);
        const data = b64ToBytes(payload.data);
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv }, key, data
        );
        return new TextDecoder().decode(decrypted);
    }

    async function getCachedKey(saltB64) {
        const b64 = sessionStorage.getItem(cacheName(saltB64));
        if (!b64) return null;
        try {
            return await importRawKey(b64ToBytes(b64));
        } catch (e) {
            return null;
        }
    }

    async function cacheKey(saltB64, key) {
        try {
            const raw = new Uint8Array(await window.crypto.subtle.exportKey("raw", key));
            sessionStorage.setItem(cacheName(saltB64), bytesToB64(raw));
        } catch (e) {
            // Non-fatal: without caching we simply re-derive on the next page.
        }
    }

    // Reveal the sidebar entries whose titles were encrypted, using whatever keys
    // are already cached this session. Items protected with a password we haven't
    // unlocked yet stay hidden (their salt has no cached key).
    async function unlockSidebar() {
        const items = document.querySelectorAll('.protected-sidebar-item');
        for (const item of items) {
            if (!item.classList.contains('hidden')) continue;
            const payloadBase64 = item.getAttribute('data-protected-payload');
            if (!payloadBase64) continue;
            try {
                const payload = JSON.parse(atob(payloadBase64));
                const key = await getCachedKey(payload.salt);
                if (!key) continue;
                const decryptedName = await decryptWithKey(payload, key);
                const textSpan = item.querySelector('.protected-text');
                if (textSpan) textSpan.innerHTML = decryptedName;
                item.classList.remove('hidden');
                // Reveal any collapsed ancestors so the item is actually visible.
                let parent = item.parentElement;
                while (parent && parent.id !== 'sidebar-list') {
                    parent.classList.remove('hidden');
                    if (parent.tagName === 'DETAILS') parent.open = true;
                    parent = parent.parentElement;
                }
            } catch (e) {
                // Wrong/absent key for this item — leave it hidden.
            }
        }
        // The inline scroll-restore ran while these entries were still hidden, so
        // the sidebar was too short for scrollTop to stick. Now that they're
        // revealed, re-apply the saved position so the sidebar keeps its place.
        if (window.nekoRestoreSidebarScroll) window.nekoRestoreSidebarScroll();
    }

    // Hover/focus prefetch. Navigation is a full page load, so the body of the
    // next protected page can only render on its first frame if its plaintext is
    // already in sessionStorage when the inline pre-paint restore runs. When the
    // visitor points at an internal link we fetch its HTML, decrypt the body with
    // the key already cached this session, and stash it — so the click that
    // follows lands on fully rendered content instead of an empty flash. Entirely
    // best-effort: any failure (public page, different password, network) is
    // swallowed and the target just decrypts the usual way after it loads.
    const prefetched = new Set();
    async function prefetchProtected(href) {
        let url;
        try { url = new URL(href, location.href); } catch (e) { return; }
        if (url.origin !== location.origin) return;
        const path = url.pathname;
        if (path === location.pathname || prefetched.has(path)) return;
        prefetched.add(path);
        if (sessionStorage.getItem(contentCacheName(path))) return;
        try {
            const res = await fetch(url.href, { credentials: 'same-origin' });
            if (!res.ok) return;
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            const enc = doc.getElementById('encrypted-data');
            if (!enc) return; // target isn't protected — nothing to prefetch.
            const p = JSON.parse(enc.textContent);
            const key = await getCachedKey(p.salt);
            if (!key) return; // protected with a password we haven't unlocked.
            cacheContent(path, p.salt, await decryptWithKey(p, key));
        } catch (e) {
            // Best-effort: leave the target to decrypt on navigation.
        }
    }

    function wirePrefetch() {
        const onHint = (e) => {
            const a = e.target.closest && e.target.closest('a[href]');
            if (a) prefetchProtected(a.href);
        };
        document.addEventListener('mouseover', onHint, { passive: true });
        document.addEventListener('focusin', onHint);
        document.addEventListener('touchstart', onHint, { passive: true });
    }

    // Re-run the dynamic content initialisers over freshly injected HTML. The page's
    // own DOMContentLoaded/load handlers already fired against the still-encrypted
    // placeholder, so highlighting, math and diagrams must be (re)applied here.
    function reinitContent(container) {
        if (!container) return;

        // <script> tags inserted via innerHTML do not execute; re-create them so
        // components that ship inline scripts (quiz, lesson, …) wire themselves up.
        container.querySelectorAll('script').forEach((oldScript) => {
            const newScript = document.createElement('script');
            for (const attr of oldScript.attributes) {
                newScript.setAttribute(attr.name, attr.value);
            }
            newScript.text = oldScript.textContent;
            oldScript.parentNode.replaceChild(newScript, oldScript);
        });

        if (window.hljs) {
            container.querySelectorAll('pre code').forEach((block) => {
                // Skip blocks the page's own highlightAll already processed: content
                // restored before first paint is in the DOM when that runs, so it gets
                // highlighted with the rest — re-highlighting here would warn/clobber.
                if (block.dataset.highlighted === 'yes') return;
                hljs.highlightElement(block);
            });
            if (window.hljs.initLineNumbersOnLoad) {
                hljs.initLineNumbersOnLoad({ singleLine: true });
            }
            container.querySelectorAll('pre code[data-highlight]').forEach(block => {
                const highlightRange = block.getAttribute('data-highlight');
                if (!highlightRange) return;
                const linesToHighlight = new Set();
                highlightRange.split(',').forEach(part => {
                    if (part.includes('-')) {
                        const [start, end] = part.split('-').map(Number);
                        for (let i = start; i <= end; i++) linesToHighlight.add(i);
                    } else {
                        linesToHighlight.add(Number(part));
                    }
                });
                const table = block.querySelector('.hljs-ln');
                if (table) {
                    table.querySelectorAll('tr').forEach((row, index) => {
                        if (linesToHighlight.has(index + 1)) {
                            row.classList.add('bg-yellow-100', 'dark:bg-yellow-900', 'bg-opacity-20', 'dark:bg-opacity-20');
                            row.querySelectorAll('td').forEach(td => td.style.backgroundColor = 'inherit');
                        }
                    });
                }
            });
        }

        if (window.renderMathInElement) {
            renderMathInElement(container);
        }

        if (window.mermaid && typeof renderMermaid === 'function') {
            renderMermaid();
        }
    }

    const encryptedDataEl = document.getElementById('encrypted-data');

    // A page can carry protected sidebar entries without being protected itself
    // (per-page passwords). Unlock whatever the session already holds, then return.
    if (!encryptedDataEl) {
        unlockSidebar();
        return;
    }

    let payload;
    try {
        payload = JSON.parse(encryptedDataEl.textContent);
    } catch (e) {
        console.error("Failed to parse encrypted payload", e);
        return;
    }

    const contentContainer = document.getElementById('content-container');
    const formContainer = document.getElementById('password-form-container');
    let promptWired = false;

    // The inline script emitted right after #content-container restores this page's
    // body from the sessionStorage plaintext cache synchronously, before first
    // paint, so a revisited (or hover-prefetched) protected page never flashes the
    // empty placeholder. When it did, we decorate that content here and skip
    // re-injecting it below.
    const alreadyInjected = window.__nekoProtectedInjected === true;

    // Build the table of contents from the just-decrypted headings — so no heading
    // text ships in the page source — and set the real document title from the H1.
    function revealProtectedChrome(container) {
        // password.js loads mid-body (right after the content), so the TOC rail,
        // which sits further down the DOM, may not be parsed yet when we decrypt.
        // Build the list as soon as the rail exists — now if it's already parsed,
        // otherwise on DOMContentLoaded.
        const buildToc = () => {
            const tocList = document.getElementById('toc-list');
            if (!tocList || tocList.querySelector('.toc-link')) return;
            container.querySelectorAll('h2[id], h3[id], h4[id]').forEach((h) => {
                const level = parseInt(h.tagName.substring(1), 10);
                const li = document.createElement('li');
                const a = document.createElement('a');
                a.href = '#' + h.id;
                a.className = 'block ' + (level === 2 ? 'pl-4' : 'pl-8') + ' hover:text-primary-600 dark:hover:text-primary-400 transition-colors toc-link';
                a.setAttribute('data-id', h.id);
                a.textContent = h.textContent;
                li.appendChild(a);
                tocList.appendChild(li);
            });
            const tocWrap = document.getElementById('toc-protected');
            if (tocWrap) tocWrap.classList.remove('hidden');
        };
        if (document.getElementById('toc-list')) buildToc();
        else document.addEventListener('DOMContentLoaded', buildToc, { once: true });

        const h1 = container.querySelector('h1');
        if (h1) {
            const site = (window.nekoConfig && window.nekoConfig.branding && window.nekoConfig.branding.title) || '';
            const heading = h1.textContent.trim();
            if (heading) document.title = site ? site + ' - ' + heading : heading;
        }
    }

    // Decrypt with an already-resolved key, inject the content, and cache the key for
    // the rest of the session. Throws if the key doesn't match (caller shows the form).
    async function renderDecrypted(key) {
        const html = await decryptWithKey(payload, key);
        // Cache before unlocking the sidebar, which reads cached keys per item.
        await cacheKey(payload.salt, key);
        // Stash the plaintext so a later revisit can paint it before first paint.
        cacheContent(location.pathname, payload.salt, html);

        // The body was already restored before first paint from the plaintext
        // cache; don't re-inject identical HTML (a needless transition over the
        // same content). Just finish wiring it up and reveal the sidebar.
        if (alreadyInjected) {
            await unlockSidebar();
            return;
        }

        const apply = async () => {
            if (contentContainer) {
                contentContainer.innerHTML = html;
                revealProtectedChrome(contentContainer);
                reinitContent(contentContainer);
            }
            await unlockSidebar();
        };

        // Mask the decryption reveal with a view transition: the content (and the
        // sidebar entries) fade in instead of popping in. Falls back to a direct
        // update where the API isn't available.
        if (document.startViewTransition) {
            try { await document.startViewTransition(apply).finished; } catch (e) {}
        } else {
            await apply();
        }
    }

    function showPrompt() {
        if (formContainer) formContainer.classList.remove('hidden');
        if (promptWired) return;
        promptWired = true;

        const passwordInput = document.getElementById('password-input');
        const submitBtn = document.getElementById('password-submit');
        const errorMsg = document.getElementById('password-error');

        async function handleUnlock(password) {
            if (!password) return;
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Unlocking...'; }
            if (errorMsg) errorMsg.classList.add('hidden');
            try {
                const key = await deriveKey(password, b64ToBytes(payload.salt));
                await renderDecrypted(key);
            } catch (e) {
                if (errorMsg) errorMsg.classList.remove('hidden');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Unlock'; }
            }
        }

        if (submitBtn) submitBtn.addEventListener('click', () => handleUnlock(passwordInput.value));
        if (passwordInput) {
            passwordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleUnlock(passwordInput.value);
            });
            passwordInput.focus();
        }
    }

    // The pre-paint restore only injects raw HTML; build its TOC, set the title,
    // and run the dynamic initialisers (the page's own DOMContentLoaded handlers
    // highlight/typeset the content, but inline component scripts still need
    // re-executing). Done once here so it happens even if there's no key to decrypt
    // sidebar siblings.
    if (alreadyInjected && contentContainer) {
        revealProtectedChrome(contentContainer);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => reinitContent(contentContainer), { once: true });
        } else {
            reinitContent(contentContainer);
        }
    }

    // Reuse the session key if we have one; otherwise reveal the prompt.
    (async function() {
        wirePrefetch();
        const cached = await getCachedKey(payload.salt);
        if (cached) {
            try {
                await renderDecrypted(cached);
                return;
            } catch (e) {
                // Stale/incompatible cached key — fall back to prompting.
            }
        }
        // The body is already on screen from the plaintext cache; we just lack a key
        // to reveal sidebar siblings. Don't prompt for a password the reader can't
        // see a reason for — the page is fully usable.
        if (alreadyInjected) {
            await unlockSidebar();
            return;
        }
        showPrompt();
    })();
})();
