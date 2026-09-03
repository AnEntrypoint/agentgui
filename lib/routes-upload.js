import express from 'express';
import Busboy from 'busboy';
import fsbrowse from 'fsbrowse';
import fs from 'fs';
import path from 'path';

export function createExpressApp({ queries, BASE_URL }) {
  const app = express();
  const fsbrowseRouters = new Map();

  app.post(BASE_URL + '/api/upload/:conversationId', (req, res) => {
    try {
      const conv = queries.getConversation(req.params.conversationId);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      if (!conv.workingDirectory) return res.status(400).json({ error: 'No working directory set for this conversation' });

      const uploadDir = conv.workingDirectory;
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const bb = Busboy({ headers: req.headers });
      const fileNames = [];
      const writePromises = [];

      bb.on('file', (fieldname, file, info) => {
        const safeName = path.basename(info.filename);
        const filePath = path.join(uploadDir, safeName);
        fileNames.push(safeName);
        const p = new Promise((resolve) => {
          const writeStream = fs.createWriteStream(filePath);
          file.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', () => { file.resume(); resolve(); });
        });
        writePromises.push(p);
      });

      bb.on('finish', () => {
        Promise.all(writePromises).then(() => {
          res.json({ ok: true, files: fileNames, count: fileNames.length });
        }).catch(() => {
          res.json({ ok: true, files: fileNames, count: fileNames.length });
        });
      });

      bb.on('error', (err) => {
        res.status(500).json({ error: 'Upload failed: ' + err.message });
      });

      req.pipe(bb);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use(BASE_URL + '/files/:conversationId', (req, res, next) => {
    const convId = req.params.conversationId;
    const conv = queries.getConversation(convId);
    if (!conv || !conv.workingDirectory) {
      return res.status(404).json({ error: 'Conversation not found or no working directory' });
    }

    const normalizedWorkingDir = path.resolve(conv.workingDirectory);

    let router = fsbrowseRouters.get(convId);
    if (!router) {
      router = fsbrowse({ baseDir: normalizedWorkingDir, name: 'Files' });
      fsbrowseRouters.set(convId, router);
    }

    req.baseUrl = BASE_URL + '/files/' + convId;
    req.url = req.url.replace(new RegExp(`^${BASE_URL}/files/${convId}`), '');

    router(req, res, next);
  });

  return app;
}
