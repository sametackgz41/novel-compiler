const express = require('express');
const compression = require('compression');
const path = require('path');
const { generateEpub } = require('./make-epub');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable Gzip compression
app.use(compression());

// Parse JSON request body
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory Job store
const jobs = new Map();

// Cleanup jobs older than 1 hour to free memory
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt.getTime() < oneHourAgo) {
      jobs.delete(jobId);
      console.log(`[TEMİZLİK] Eski iş silindi: ${jobId}`);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Endpoint: Start EPUB Compile
app.post('/api/epub/start', (req, res) => {
  const { url, concurrency } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Roman linki veya slug alanı zorunludur.' });
  }

  // Extract slug from URL if needed
  let slug = url.trim();
  if (slug.includes('novelgecesi.com')) {
    const clean = slug.replace(/\/$/, '');
    const parts = clean.split('/');
    slug = parts[parts.length - 1];
  }

  const concurrencyParam = parseInt(concurrency, 10) || 2;
  const jobId = `${slug}-${Date.now()}`;

  const job = {
    id: jobId,
    slug: slug,
    status: 'running',
    message: 'Roman ayrıntıları alınıyor...',
    total: 0,
    current: 0,
    logs: [`[${new Date().toLocaleTimeString('tr-TR')}] [INFO] Derleme işlemi başlatıldı.`],
    filename: null,
    buffer: null,
    error: null,
    createdAt: new Date()
  };

  jobs.set(jobId, job);

  // Trigger generator in the background (asynchronous)
  generateEpub(slug, (p) => {
    const activeJob = jobs.get(jobId);
    if (!activeJob) return; // job was deleted or cleaned up

    if (p.total !== undefined) activeJob.total = p.total;
    if (p.current !== undefined) activeJob.current = p.current;

    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const statusTag = p.status.toUpperCase();
    const logLine = `[${timestamp}] [${statusTag}] ${p.message}`;
    
    activeJob.logs.push(logLine);
    activeJob.message = p.message;
  }, concurrencyParam)
  .then(result => {
    const activeJob = jobs.get(jobId);
    if (activeJob) {
      activeJob.status = 'completed';
      activeJob.filename = result.filename;
      activeJob.buffer = result.buffer;
      activeJob.message = 'EPUB derleme tamamlandı!';
      activeJob.logs.push(`[${new Date().toLocaleTimeString('tr-TR')}] [INFO] EPUB dosyası başarıyla derlendi: ${result.filename}`);
    }
  })
  .catch(err => {
    const activeJob = jobs.get(jobId);
    if (activeJob) {
      activeJob.status = 'failed';
      activeJob.error = err.message;
      activeJob.message = `Derleme hatası: ${err.message}`;
      activeJob.logs.push(`[${new Date().toLocaleTimeString('tr-TR')}] [ERROR] Kritik hata: ${err.message}`);
    }
  });

  res.json({ jobId });
});

// Endpoint: Get Job Status & Logs
app.get('/api/epub/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Derleme işi bulunamadı veya süresi doldu.' });
  }

  res.json({
    id: job.id,
    slug: job.slug,
    status: job.status,
    message: job.message,
    total: job.total,
    current: job.current,
    logs: job.logs,
    filename: job.filename,
    error: job.error
  });
});

// Endpoint: Download Completed EPUB
app.get('/api/epub/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).send('Dosya bulunamadı veya iş süresi doldu.');
  }

  if (job.status !== 'completed' || !job.buffer) {
    return res.status(400).send('Dosya henüz hazır değil veya derleme başarısız oldu.');
  }

  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.filename)}"`);
  res.send(job.buffer);
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`Novel EPUB Generator is running!`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`Gzip Compression: ENABLED`);
  console.log(`==================================================`);
});
