document.addEventListener('DOMContentLoaded', () => {
    const historyKey = 'neko-history';
    const maxHistory = 50;

    // 1. Record Visit
    try {
        const currentUrl = window.location.pathname;
        let currentTitle = document.title;

        // Clean title if it starts with "Site Name - " prefix
        const siteTitle = window.nekoConfig?.branding?.title;
        if (siteTitle && currentTitle.startsWith(siteTitle + ' - ')) {
            currentTitle = currentTitle.substring(siteTitle.length + 3);
        }

        let history = [];
        const stored = localStorage.getItem(historyKey);
        if (stored) {
            history = JSON.parse(stored);
        }

        // Remove existing entry for this page (to move it to top)
        history = history.filter(item => item.url !== currentUrl);

        // Add to top
        history.unshift({ url: currentUrl, title: currentTitle });

        // Limit
        if (history.length > maxHistory) {
            history = history.slice(0, maxHistory);
        }

        localStorage.setItem(historyKey, JSON.stringify(history));
    } catch (e) {
        console.error('Failed to update navigation history:', e);
    }

    // Global toggle function
    window.toggleHistory = function() {
        const popup = document.getElementById('history-popup');
        const list = document.getElementById('history-list');
        const btn = document.getElementById('history-btn');

        if (!popup || !list) return;

        if (popup.classList.contains('hidden')) {
            // Show
            renderHistoryList(list);
            popup.classList.remove('hidden');
            // Close on click outside
            setTimeout(() => {
                document.addEventListener('click', closeHistoryOnClickOutside);
            }, 0);
        } else {
            // Hide
            popup.classList.add('hidden');
            document.removeEventListener('click', closeHistoryOnClickOutside);
        }

        function closeHistoryOnClickOutside(e) {
            if (!popup.contains(e.target) && !btn.contains(e.target)) {
                popup.classList.add('hidden');
                document.removeEventListener('click', closeHistoryOnClickOutside);
            }
        }
    };

    function renderHistoryList(container) {
        let history = [];
        try {
            history = JSON.parse(localStorage.getItem(historyKey) || '[]');
        } catch (e) {
            console.error('Failed to read navigation history:', e);
        }

        container.innerHTML = '';

        if (history.length === 0) {
            const li = document.createElement('li');
            li.className = 'px-4 py-3 text-sm text-gray-500 dark:text-gray-400 text-center italic';
            li.textContent = 'No recent history.';
            container.appendChild(li);
            return;
        }

        history.forEach(item => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = item.url;
            a.className = 'block px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 truncate transition-colors flex items-center gap-2';

            // Icon
            const icon = document.createElement('i');
            icon.className = 'fi fi-rr-clock text-gray-400 text-xs';
            a.appendChild(icon);

            const span = document.createElement('span');
            span.textContent = item.title || item.url;
            a.appendChild(span);

            li.appendChild(a);
            container.appendChild(li);
        });
    }
});
