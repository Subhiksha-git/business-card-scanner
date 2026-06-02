const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 8080;
const root = process.cwd();

const mime = {
  '.html': 'text/html',
  '.htm':  'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.wasm': 'application/wasm',
  '.gz':   'application/gzip',
  '.txt':  'text/plain'
};

const server = http.createServer((req, res) => {
  try {
    let requested = decodeURIComponent(req.url.split('?')[0]);
    if (requested === '/') requested = '/public/cardscan.html';
    if (requested === '/cardscan.html') requested = '/public/cardscan.html';

    const filePath = path.resolve(path.join(root, '.' + requested));
    const relative  = path.relative(root, filePath);

    // Prevent directory traversal and invalid paths
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const type = mime[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', type);
      // Let browser decide caching; disable caching for development
      res.setHeader('Cache-Control', 'no-store');

      const stream = fs.createReadStream(filePath);
      stream.on('error', () => { res.statusCode = 500; res.end('Server error'); });
      stream.pipe(res);
    });
  } catch (e) {
    res.statusCode = 500; res.end('Server error');
  }
});

server.listen(port, () => {
  console.log(`Static server running at http://localhost:${port}/`);
  console.log('Serving from', root);
});
