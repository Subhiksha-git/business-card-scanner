// Service Worker to intercept CDN requests and redirect to local files
const CDN_MAPPINGS = {
  'https://cdn.jsdelivr.net/npm/tesseract.js@v5.0.0/dist/worker.min.js': './worker.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.2.3/tesseract-core.wasm': './node_modules/tesseract.js-core/tesseract-core.wasm',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.2.3/tesseract-core-simd.wasm': './node_modules/tesseract.js-core/tesseract-core-simd.wasm',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.2.3/tesseract-core-lstm.wasm': './node_modules/tesseract.js-core/tesseract-core-lstm.wasm',
};
// Pattern-based redirects for language data
const CDN_PATTERNS = [
  {
    pattern: /https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/(.*?)\/(\d+\.\d+\.\d+)\/(.*)/,
    replace: './tessdata/$3'
  }
];

self.addEventListener('fetch', event => {
  const url = event.request.url;
  
  // Check direct mappings first
  if (CDN_MAPPINGS[url]) {
    console.log('[Service Worker] Redirecting:', url, '→', CDN_MAPPINGS[url]);
    event.respondWith(fetch(CDN_MAPPINGS[url]));
    return;
  }
  
  // Check pattern-based redirects
  for (const { pattern, replace } of CDN_PATTERNS) {
    if (pattern.test(url)) {
      const localUrl = url.replace(pattern, replace);
      console.log('[Service Worker] Redirecting:', url, '→', localUrl);
      event.respondWith(fetch(localUrl));
      return;
    }
  }
  
  // Pass through other requests
  event.respondWith(fetch(event.request));
});
