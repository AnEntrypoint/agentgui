import zlib from 'zlib';

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('error', reject);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
  });
}

export function acceptsEncoding(req, encoding) {
  const accept = req.headers['accept-encoding'] || '';
  return accept.includes(encoding);
}

export function compressAndSend(req, res, statusCode, contentType, body) {
  const raw = typeof body === 'string' ? Buffer.from(body) : body;
  const isHtml = contentType && contentType.includes('text/html');
  const baseHeaders = { 'Content-Type': contentType };
  if (isHtml) baseHeaders['Cache-Control'] = 'no-store';
  if (raw.length < 860) {
    res.writeHead(statusCode, { ...baseHeaders, 'Content-Length': raw.length });
    res.end(raw);
    return;
  }
  if (acceptsEncoding(req, 'gzip')) {
    const compressed = zlib.gzipSync(raw, { level: 6 });
    res.writeHead(statusCode, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    res.end(compressed);
  } else {
    res.writeHead(statusCode, { ...baseHeaders, 'Content-Length': raw.length });
    res.end(raw);
  }
}

export function sendJSON(req, res, statusCode, data) {
  compressAndSend(req, res, statusCode, 'application/json', JSON.stringify(data));
}
