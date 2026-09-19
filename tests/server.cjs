const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async function serve() {
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/PrefixType-original.html'));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/original.html') { res.setHeader('Content-Type', 'text/html'); res.end(original); return; }
    const file = path.resolve('.' + decodeURIComponent(url.pathname === '/' ? '/PrefixType.html' : url.pathname));
    if (!file.startsWith(process.cwd() + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const content = fs.readFileSync(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
};
