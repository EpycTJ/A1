const PROXIES =[
    { prefix: 'https://api.allorigins.win/raw?url=' },
    { prefix: 'https://cors.sh/?url=' },
    { prefix: 'https://proxy.cors.sh/' },
    { prefix: 'https://api.codetabs.com/v1/proxy?quest=' },
    // ...[Keep all your other a1-bug-build-bypass Vercel proxies here] ...
    { prefix: 'https://a1-bug-build-bypass.vercel.app/api/bypass?url='}
];

const FETCH_TIMEOUT = 12000; // Slightly increased to 12s for better proxy success rates
const USER_AGENTS =[
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15',
];

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

let activeProxies = [...PROXIES];

/**
 * Checks proxies against a lightweight, non-blocking domain.
 * Google.com aggressively blocks proxies, which would falsely mark good proxies as dead.
 */
async function checkProxies() {
    const testUrl = 'https://example.com'; 
    
    // Test in batches to avoid overwhelming the network
    const batchSize = 10;
    const workingProxies =[];

    for (let i = 0; i < PROXIES.length; i += batchSize) {
        const batch = PROXIES.slice(i, i + batchSize);
        const checkedBatch = await Promise.all(batch.map(async (proxy) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            try {
                const response = await fetch(`${proxy.prefix}${encodeURIComponent(testUrl)}`, {
                    signal: controller.signal,
                    headers: { 'User-Agent': getRandomUserAgent() }
                });
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    const text = await response.text();
                    // Ensure it actually fetched example.com and didn't hit a proxy error page
                    if (text.includes('Example Domain') && !/Cloudflare|hCaptcha|Verifying you are human/i.test(text)) {
                        return proxy;
                    }
                }
            } catch (error) {
                // Ignore failed proxies silently
            } finally {
                clearTimeout(timeoutId);
            }
            return null;
        }));
        
        workingProxies.push(...checkedBatch.filter(p => p !== null));
    }

    if (workingProxies.length > 0) {
        activeProxies = workingProxies;
        console.log(`[Proxy Manager] ${activeProxies.length} proxies are currently active.`);
    }
}

/**
 * Fetches a URL using a limited race condition.
 * Instead of firing 70 requests at once (which causes browser network crashes),
 * it races the top 5 random proxies and aborts the losers to save memory.
 */
async function fetchWithProxy(targetUrl, headers = {}) {
    if (activeProxies.length === 0) throw new Error('No active proxies available.');

    // Pick 5 random working proxies to race
    const sampleSize = Math.min(5, activeProxies.length);
    const shuffledProxies = [...activeProxies].sort(() => Math.random() - 0.5).slice(0, sampleSize);
    
    const controllers = shuffledProxies.map(() => new AbortController());

    try {
        const result = await Promise.any(shuffledProxies.map(async (proxy, index) => {
            const controller = controllers[index];
            const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
            
            try {
                const userAgent = headers['User-Agent'] || getRandomUserAgent();
                const response = await fetch(`${proxy.prefix}${encodeURIComponent(targetUrl)}`, {
                    headers: {
                        'User-Agent': userAgent,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) throw new Error(`Status ${response.status}`);
                
                const text = await response.text();
                if (/Cloudflare|hCaptcha|Verifying you are human|Checking your browser/i.test(text)) {
                    throw new Error('CAPTCHA Blocked');
                }
                
                return text;
            } catch (error) {
                throw error;
            }
        }));

        // Abort the slower requests that are still pending
        controllers.forEach(c => c.abort());
        return result;

    } catch (error) {
        controllers.forEach(c => c.abort());
        console.warn('Live proxies failed. Attempting Archive.org fallback...');
        return await fetchArchiveFallback(targetUrl);
    }
}

/**
 * Fallback mechanism: If live proxies fail or are blocked, try fetching the latest snapshot from Archive.org
 */
async function fetchArchiveFallback(url) {
    try {
        const archiveUrl = `https://web.archive.org/web/2/${url}`;
        const response = await fetch(archiveUrl);
        if (response.ok) return await response.text();
        throw new Error('Archive fallback failed');
    } catch (e) {
        throw new Error('All proxies and fallbacks failed.');
    }
}

// Initialize proxies
checkProxies();
setInterval(checkProxies, 5 * 60 * 1000);

/**
 * Highly improved Login/Paywall detection.
 * Looks for actual form structures and common paywall CSS classes instead of broad text matches.
 */
async function detectAndBypassLogin(doc, url) {
    // 1. Check for actual login forms (much more accurate than textContent)
    const forms = Array.from(doc.querySelectorAll('form'));
    const hasLoginForm = forms.some(form => {
        const hasPassword = form.querySelector('input[type="password"]');
        const hasEmailOrUser = form.querySelector('input[type="email"], input[type="text"], input[name*="user"], input[name*="login"]');
        return hasPassword && hasEmailOrUser;
    });

    // 2. Check for common Paywall/Gate selectors
    const paywallSelectors =[
        '#paywall', '.paywall', '.metered-paywall', '.tp-modal', 
        '.tp-backdrop', '#gateway-content', '.article-paywall', 
        '[data-test-id="paywall"]', '.wall-bottom'
    ];
    const hasPaywall = paywallSelectors.some(selector => doc.querySelector(selector));

    if (hasLoginForm || hasPaywall) {
        console.log("[Bypass] Login/Paywall detected. Attempting extraction...");
        
        try {
            // Clean up the DOM before passing to Mercury to prevent it from parsing the paywall modal
            paywallSelectors.forEach(sel => {
                const el = doc.querySelector(sel);
                if (el) el.remove();
            });

            const article = await Mercury.parse(url, { html: doc.documentElement.outerHTML });
            
            if (article && article.content && article.content.length > 500) {
                if (typeof dom !== 'undefined' && dom.readerView) {
                    dom.readerView.querySelector('#reader-view-content').innerHTML = `
                        <h1 style="margin-bottom: 10px;">${article.title}</h1>
                        <div class="byline" style="color: gray; margin-bottom: 20px;">
                            ${article.author ? `By ${article.author}` : ''}
                        </div>
                        ${article.content}
                    `;
                    dom.readerView.style.display = 'block';
                    if (dom.iframe) dom.iframe.style.display = 'none';
                }
                return true;
            }
        } catch (e) {
            console.error("[Bypass] Failed to parse article with Mercury:", e);
        }

        // Fallback to scoped search if Mercury fails
        console.log("[Bypass] Mercury failed. Falling back to scoped search.");
        const title = doc.title.replace(/log in|sign in|login|signin|subscribe|paywall/i, '').replace(/[-|–_]/g, ' ').trim();
        const hostname = new URL(url).hostname.replace('www.', '');
        const searchQuery = `site:${hostname} "${title}"`;

        if (typeof toggleLoginBypassSheet === 'function') toggleLoginBypassSheet(true);
        if (typeof performScopedSearch === 'function') await performScopedSearch(searchQuery, dom.loginBypassResults);
        
        return true;
    }
    return false;
}
