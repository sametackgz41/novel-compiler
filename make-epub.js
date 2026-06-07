const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.novelgecesi.com';

const fetchHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://www.novelgecesi.com/'
};

// ==========================================
// PAUSABLE CONCURRENCY QUEUE
// ==========================================
class RequestQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.isPaused = false;
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.next();
    });
  }

  next() {
    if (this.isPaused) return;

    while (this.running < this.concurrency && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.running++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this.running--;
          this.next();
        });
    }
  }

  pause(durationMs = 5000) {
    if (this.isPaused) return;
    this.isPaused = true;
    console.log(`\n[QUEUE PAUSED] 429 Rate limit hit. Cooling down for ${durationMs}ms...`);
    setTimeout(() => {
      this.isPaused = false;
      console.log(`[QUEUE ACTIVE] Resuming scraper...`);
      this.next();
    }, durationMs);
  }
}

const requestQueue = new RequestQueue(2);

// ==========================================
// SCRAPER FETCH WITH COOL-DOWN & RETRIES
// ==========================================
async function directFetch(url, retries = 10, delay = 2000, progressCallback = null, queue = requestQueue) {
  return queue.add(async () => {
    let currentRetries = retries;
    let currentDelay = delay;

    while (true) {
      let response;
      try {
        response = await fetch(url, { headers: fetchHeaders });
      } catch (e) {
        if (currentRetries > 0) {
          if (progressCallback) progressCallback({ status: 'warning', message: `[AĞ HATASI] ${url} alınamadı. Tekrar denenecek...` });
          await new Promise(r => setTimeout(r, currentDelay));
          currentRetries--;
          currentDelay *= 2;
          continue;
        }
        throw e;
      }

      if (response.status === 429 || response.status === 503) {
        queue.pause(6000);
        if (currentRetries > 0) {
          if (progressCallback) progressCallback({ status: 'warning', message: `[429 LİMİT] Sınır hatası alındı. Bekleniyor...` });
          await new Promise(r => setTimeout(r, 6000));
          currentRetries--;
          continue;
        }
      }

      if (!response.ok) {
        if (currentRetries > 0) {
          await new Promise(r => setTimeout(r, currentDelay));
          currentRetries--;
          currentDelay *= 2;
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    }
  });
}

// ==========================================
// NOVEL DETAILS & CHAPTER EXTRACTORS
// ==========================================
async function fetchNovelDetails(slug, progressCallback, queue) {
  const url = `${BASE_URL}/${slug}`;
  const response = await directFetch(url, 10, 2000, progressCallback, queue);
  const html = await response.text();
  const $ = cheerio.load(html);

  let ldData = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).html();
      const parsed = JSON.parse(text);
      if (parsed['@type'] === 'Book') {
        ldData = parsed;
      }
    } catch (e) {}
  });

  let title = '';
  let author = '';
  let coverUrl = '';
  let synopsis = '';
  let genres = [];

  if (ldData) {
    title = ldData.name || '';
    author = ldData.author?.name || '';
    coverUrl = ldData.image || '';
    synopsis = ldData.description || '';
    genres = ldData.genre || [];
  } else {
    title = $('h1.main-page-title').text().trim() || slug;
    synopsis = $('.series-description').text().trim() || $('#summary').text().trim();
    coverUrl = $('.series-image img').attr('src') || '';
    $('.series-genres .badge').each((_, b) => {
      genres.push($(b).text().trim());
    });
  }

  if (coverUrl && coverUrl.startsWith('/')) {
    coverUrl = BASE_URL + coverUrl;
  }

  return { slug, title, author, coverUrl, synopsis, genres };
}

async function fetchChaptersList(slug, progressCallback, queue) {
  const url = `${BASE_URL}/api/series/${slug}/chapters`;
  const response = await directFetch(url, 10, 2000, progressCallback, queue);
  const json = await response.json();
  
  return (json.chapters || []).map(ch => ({
    chapter: ch.chapter,
    title: ch.title,
    date: ch.date,
    url: ch.url
  }));
}

async function fetchChapterContent(slug, chapterNum, progressCallback, queue) {
  const url = `${BASE_URL}/${slug}/${chapterNum}`;
  const response = await directFetch(url, 10, 2000, progressCallback, queue);
  const html = await response.text();
  const $ = cheerio.load(html);

  // Extract title
  let title = $('.novel-content h1, .content-text').prev('h3, h2, h1').first().text().trim() || 
                $('title').text().replace('| Türkçe Novel Oku', '').trim();

  // Extract paragraphs
  const paragraphs = [];
  $('.content-text p').each((_, p) => {
    const txt = $(p).text().trim();
    if (txt) paragraphs.push(txt);
  });

  if (paragraphs.length === 0) {
    const textBlock = $('.content-text').html();
    if (textBlock) {
      const cleanText = textBlock.replace(/<br\s*\/?>/gi, '\n');
      const temp = cheerio.load(cleanText);
      temp('body').text().split('\n').forEach(line => {
        const l = line.trim();
        if (l) paragraphs.push(l);
      });
    }
  }

  return { title, paragraphs };
}

// ==========================================
// CORE EPUB BUILDER
// ==========================================
async function generateEpub(slug, progressCallback = () => {}, concurrency = 2) {
  // Create an isolated queue for this compilation
  const queue = new RequestQueue(concurrency);

  // 1. Fetch novel info
  progressCallback({ status: 'info', message: `[1/4] Roman detayları çekiliyor: ${slug}...` });
  const details = await fetchNovelDetails(slug, progressCallback, queue);

  // 2. Fetch chapter list
  progressCallback({ status: 'info', message: '[2/4] Bölüm listesi alınıyor...' });
  const chaptersList = await fetchChaptersList(slug, progressCallback, queue);

  const total = chaptersList.length;
  progressCallback({ status: 'info', message: `[3/4] Toplam ${total} bölüm bulundu. İçerikler indiriliyor...`, total, current: 0 });

  // 3. Download Chapters Content in Parallel with retry queue
  const fetchedChapters = [];
  let fetchedCount = 0;

  const downloadPromises = chaptersList.map((ch, idx) => {
    return (async () => {
      try {
        const content = await fetchChapterContent(slug, ch.chapter, progressCallback, queue);
        fetchedChapters.push({
          index: idx,
          chapter: ch.chapter,
          title: content.title || `Bölüm ${ch.chapter}`,
          paragraphs: content.paragraphs
        });
      } catch (err) {
        console.error(`[CRITICAL] Bölüm ${ch.chapter} tamamen başarısız oldu:`, err.message);
        fetchedChapters.push({
          index: idx,
          chapter: ch.chapter,
          title: `Bölüm ${ch.chapter}: [İndirilemedi]`,
          paragraphs: ['[Bu bölüm indirilirken ağ hatası oluştu ve içeriği alınamadı.]']
        });
      }

      fetchedCount++;
      progressCallback({ 
        status: 'progress', 
        message: `İndiriliyor: ${fetchedCount}/${total} (${Math.floor((fetchedCount/total)*100)}%) - Bölüm ${ch.chapter} indirildi`,
        total,
        current: fetchedCount
      });
    })();
  });

  await Promise.all(downloadPromises);

  // Sort chronologically based on initial index to keep reading order correct
  fetchedChapters.sort((a, b) => a.index - b.index);

  progressCallback({ status: 'info', message: '[4/4] EPUB yapısı derleniyor...' });

  // 4. Download Cover Art Buffer
  let coverBuffer = null;
  let coverMediaType = 'image/jpeg';
  if (details.coverUrl) {
    try {
      const imgRes = await fetch(details.coverUrl);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type');
        if (contentType) coverMediaType = contentType;
        const arrayBuffer = await imgRes.arrayBuffer();
        coverBuffer = Buffer.from(arrayBuffer);
      }
    } catch (e) {
      console.warn('Cover image could not be loaded.');
    }
  }

  // 5. Build ZIP Container
  const zip = new JSZip();

  // mimetype MUST be first and STORED uncompressed
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // container.xml
  zip.folder('META-INF').file('container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // stylesheet.css
  zip.folder('OEBPS').file('stylesheet.css', `body {
  font-family: sans-serif;
  margin: 5%;
  line-height: 1.6;
  color: #111;
  background-color: #fff;
}
h1.title {
  text-align: center;
  margin-top: 25%;
  font-size: 2.2em;
}
h2.author {
  text-align: center;
  font-size: 1.2em;
  color: #444;
  margin-bottom: 15%;
}
h3.chapter-title {
  font-size: 1.4em;
  border-bottom: 2px solid #333;
  padding-bottom: 6px;
  margin-top: 30px;
  margin-bottom: 20px;
}
p {
  margin-bottom: 1.2em;
  text-indent: 1.5em;
  text-align: justify;
}
.cover-img-container {
  text-align: center;
  margin: 20px 0;
}
.cover-img {
  max-width: 90%;
  height: auto;
}`);

  if (coverBuffer) {
    zip.folder('OEBPS/images').file('cover.jpg', coverBuffer);
  }

  // Title page
  zip.folder('OEBPS/chapters').file('titlepage.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${details.title}</title>
  <link rel="stylesheet" href="../stylesheet.css" type="text/css"/>
</head>
<body>
  <h1 class="title">${details.title}</h1>
  <h2 class="author">Yazar: ${details.author || 'Bilinmiyor'}</h2>
  ${coverBuffer ? `<div class="cover-img-container"><img class="cover-img" src="../images/cover.jpg" alt="Cover"/></div>` : ''}
  <div style="margin-top: 15%; font-size: 0.9em; text-align: center; color: #555;">
    <p>Novel Derleyicisi tarafından derlenmiştir.</p>
    <p>Oluşturulma Tarihi: ${new Date().toLocaleDateString('tr-TR')}</p>
  </div>
</body>
</html>`);

  // Chapters XHTML
  fetchedChapters.forEach(ch => {
    const filename = `chapter_${ch.chapter}.xhtml`;
    const paragraphsHtml = ch.paragraphs
      .map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
      .join('\n');

    zip.file(`OEBPS/chapters/${filename}`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Bölüm ${ch.chapter}: ${ch.title}</title>
  <link rel="stylesheet" href="../stylesheet.css" type="text/css"/>
</head>
<body>
  <h3 class="chapter-title">Bölüm ${ch.chapter}: ${ch.title}</h3>
  ${paragraphsHtml}
</body>
</html>`);
  });

  // content.opf
  const uuid = `urn:uuid:${slug}-${Date.now()}`;
  const manifestItems = fetchedChapters.map(ch => 
    `    <item id="chapter_${ch.chapter}" href="chapters/chapter_${ch.chapter}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n');
  
  const spineItems = fetchedChapters.map(ch => 
    `    <itemref idref="chapter_${ch.chapter}"/>`
  ).join('\n');

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId">${uuid}</dc:identifier>
    <dc:title>${details.title}</dc:title>
    <dc:creator opf:role="aut">${details.author || 'Bilinmiyor'}</dc:creator>
    <dc:language>tr</dc:language>
    <dc:publisher>Novel Compiler</dc:publisher>
    <dc:date>${new Date().toISOString().split('T')[0]}</dc:date>
    ${coverBuffer ? '    <meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="stylesheet.css" media-type="text/css"/>
    <item id="titlepage" href="chapters/titlepage.xhtml" media-type="application/xhtml+xml"/>
    ${coverBuffer ? `    <item id="cover-image" href="images/cover.jpg" media-type="${coverMediaType}"/>` : ''}
${manifestItems}
  </manifest>
  <spine toc="ncx">
    <itemref idref="titlepage"/>
${spineItems}
  </spine>
</package>`;

  zip.file('OEBPS/content.opf', contentOpf);

  // toc.ncx
  const tocNavPoints = fetchedChapters.map((ch, idx) => `    <navPoint id="chapter_${ch.chapter}" playOrder="${idx + 2}">
      <navLabel><text>Bölüm ${ch.chapter}: ${ch.title}</text></navLabel>
      <content src="chapters/chapter_${ch.chapter}.xhtml"/>
    </navPoint>`).join('\n');

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${details.title}</text></docTitle>
  <navMap>
    <navPoint id="titlepage" playOrder="1">
      <navLabel><text>Kapak</text></navLabel>
      <content src="chapters/titlepage.xhtml"/>
    </navPoint>
${tocNavPoints}
  </navMap>
</ncx>`;

  zip.file('OEBPS/toc.ncx', tocNcx);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { filename: `${details.title}.epub`, buffer };
}

// ==========================================
// CLI INITIALIZER
// ==========================================
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
Kullanım: node make-epub.js <url_veya_slug> [paralel_istek_sayısı]
Örnek: node make-epub.js omniscient-reader-s-viewpoint-deepl
      node make-epub.js https://www.novelgecesi.com/supreme-magus 1
    `);
    process.exit(1);
  }

  const input = args[0];
  const concurrencyParam = args[1] ? parseInt(args[1], 10) : 2;
  if (!isNaN(concurrencyParam) && concurrencyParam > 0) {
    requestQueue.concurrency = concurrencyParam;
  }

  let slug = input;
  if (input.includes('novelgecesi.com')) {
    const clean = input.replace(/\/$/, '');
    const parts = clean.split('/');
    slug = parts[parts.length - 1];
  }

  console.log(`\n==========================================`);
  console.log(`[EPUB BAŞLATILDI] Roman: ${slug}`);
  console.log(`[AYAR] Paralel İstek Limiti: ${requestQueue.concurrency}`);
  console.log(`==========================================\n`);

  generateEpub(slug, (progress) => {
    if (progress.status === 'info') {
      console.log(`\n[BİLGİ] ${progress.message}`);
    } else if (progress.status === 'warning') {
      console.log(`\n[UYARI] ${progress.message}`);
    } else if (progress.status === 'progress') {
      process.stdout.write(`\r[İLERLEME] ${progress.message}`);
    }
  }).then(result => {
    console.log('\n');
    console.log(`[BAŞARILI] EPUB derlemesi eksiksiz bitti!`);
    const outputPath = path.join(process.cwd(), result.filename);
    fs.writeFileSync(outputPath, result.buffer);
    console.log(`[KAYDEDİLDİ] E-kitap şurada: ${outputPath}`);
    console.log(`==========================================\n`);
  }).catch(err => {
    console.log('\n');
    console.error(`[HATA] EPUB derlenirken hata oluştu:`, err.message);
    console.log(`==========================================\n`);
    process.exit(1);
  });
}

module.exports = { generateEpub, fetchNovelDetails };
