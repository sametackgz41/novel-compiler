document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const compileForm = document.getElementById('compile-form');
  const novelUrlInput = document.getElementById('novel-url');
  const btnSubmit = document.getElementById('btn-submit');
  const statusPanel = document.getElementById('status-panel');
  const progressCircle = document.getElementById('progress-circle');
  const progressPercent = document.getElementById('progress-percent');
  const progressFraction = document.getElementById('progress-fraction');
  const statusNovelTitle = document.getElementById('status-novel-title');
  const statusMessage = document.getElementById('status-message');
  const statusSpeedInfo = document.getElementById('status-speed-info');
  const consoleLogs = document.getElementById('console-logs');
  const btnClearConsole = document.getElementById('btn-clear-console');
  const historyTbody = document.getElementById('history-tbody');
  const btnToggleConsole = document.getElementById('btn-toggle-console');
  const consoleDrawer = document.getElementById('console-drawer');
  const toggleConsoleText = document.getElementById('toggle-console-text');
  
  // State variables
  let pollInterval = null;
  let activeJobId = null;
  let renderedLogCount = 0;
  const CIRCLE_CIRCUMFERENCE = 213.6; // 2 * Math.PI * 34 (r=34)

  // Console Drawer Toggle Logic
  if (btnToggleConsole && consoleDrawer) {
    btnToggleConsole.addEventListener('click', () => {
      const isCollapsed = consoleDrawer.classList.contains('collapsed');
      if (isCollapsed) {
        expandConsole();
      } else {
        collapseConsole();
      }
    });
  }

  function expandConsole() {
    if (consoleDrawer) {
      consoleDrawer.classList.remove('collapsed');
      if (toggleConsoleText) toggleConsoleText.textContent = 'İşlem Günlüklerini Gizle';
    }
  }

  function collapseConsole() {
    if (consoleDrawer) {
      consoleDrawer.classList.add('collapsed');
      if (toggleConsoleText) toggleConsoleText.textContent = 'İşlem Günlüklerini Göster';
    }
  }

  // Unregister service workers if any (leftover from legacy version)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
      for (const registration of registrations) {
        registration.unregister().then(success => {
          if (success) {
            console.log('[SYSTEM] Legacy Service Worker unregistered.');
          }
        });
      }
    });
  }

  // Initialize History
  loadHistory();

  // Handle Form Submission
  compileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const url = novelUrlInput.value.trim();
    if (!url) return;

    // Get selected concurrency
    const concurrencyRadio = document.querySelector('input[name="concurrency"]:checked');
    const concurrency = concurrencyRadio ? parseInt(concurrencyRadio.value, 10) : 2;

    try {
      // Reset State
      setLoadingState(true);
      clearConsole();
      addLogLine('info', `[SYSTEM] Bağlantı hazırlanıyor...`);
      addLogLine('info', `[SYSTEM] İstek gönderiliyor: ${url} (Eşzamanlılık: ${concurrency})`);
      
      // Open status panel
      statusPanel.classList.remove('hidden');
      statusPanel.scrollIntoView({ behavior: 'smooth' });

      // Update circular progress to 0
      setProgress(0, 0);
      statusNovelTitle.textContent = 'Bilgiler alınıyor...';
      statusMessage.textContent = 'API ile bağlantı kuruluyor...';
      statusSpeedInfo.textContent = `Eşzamanlı istek limiti: ${concurrency}`;

      // Call API
      const response = await fetch('/api/epub/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url, concurrency })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'İşlem başlatılamadı.');
      }

      const data = await response.json();
      activeJobId = data.jobId;
      renderedLogCount = 0;

      addLogLine('info', `[SYSTEM] Derleyici işi başlatıldı. ID: ${activeJobId}`);
      
      // Save temporary running job to history
      saveToHistory({
        id: activeJobId,
        slug: extractSlug(url),
        title: extractSlug(url), // fallback
        date: new Date().toLocaleString('tr-TR'),
        chapters: '...',
        status: 'running'
      });

      // Start Polling
      startPolling(activeJobId);

    } catch (err) {
      setLoadingState(false);
      addLogLine('error', `[ERROR] Başlatma hatası: ${err.message}`);
      statusMessage.textContent = `Hata: ${err.message}`;
      statusNovelTitle.textContent = 'Başarısız Oldu';
      expandConsole();
    }
  });

  // Start Polling API for status updates
  function startPolling(jobId) {
    if (pollInterval) clearInterval(pollInterval);
    
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/epub/status/${jobId}`);
        if (!res.ok) {
          throw new Error('İş durumu alınamadı.');
        }

        const job = await res.json();
        
        // Update Title & Message
        statusNovelTitle.textContent = job.slug;
        statusMessage.textContent = job.message;

        // Render new logs
        if (job.logs && job.logs.length > renderedLogCount) {
          const newLogs = job.logs.slice(renderedLogCount);
          newLogs.forEach(line => {
            let type = 'system';
            if (line.includes('[INFO]')) type = 'info';
            else if (line.includes('[WARNING]') || line.includes('[429 LİMİT]') || line.includes('[UYARI]')) type = 'warning';
            else if (line.includes('[ERROR]') || line.includes('[CRITICAL]')) type = 'error';
            addLogLine(type, line);
          });
          renderedLogCount = job.logs.length;
        }

        // Update Progress
        if (job.total > 0) {
          setProgress(job.current, job.total);
        }

        // Check completion state
        if (job.status === 'completed') {
          clearInterval(pollInterval);
          setLoadingState(false);
          addLogLine('info', `[SYSTEM] Tamamlandı! EPUB dosyası indiriliyor...`);
          
          // Update history entry
          updateHistoryItem(jobId, {
            title: job.filename.replace('.epub', ''),
            chapters: job.total,
            status: 'completed'
          });

          // Trigger Auto Download
          triggerDownload(jobId);

        } else if (job.status === 'failed') {
          clearInterval(pollInterval);
          setLoadingState(false);
          addLogLine('error', `[ERROR] Derleme başarısız oldu: ${job.error}`);
          expandConsole();
          
          updateHistoryItem(jobId, {
            status: 'failed'
          });
        }

      } catch (err) {
        clearInterval(pollInterval);
        setLoadingState(false);
        addLogLine('error', `[ERROR] İzleme hatası: ${err.message}`);
        expandConsole();
      }
    }, 1000);
  }

  // Set circular progress values
  function setProgress(current, total) {
    if (total === 0) {
      progressCircle.style.strokeDashoffset = CIRCLE_CIRCUMFERENCE;
      progressPercent.textContent = '0%';
      progressFraction.textContent = '0/0';
      return;
    }

    const percent = Math.floor((current / total) * 100);
    const offset = CIRCLE_CIRCUMFERENCE - (current / total) * CIRCLE_CIRCUMFERENCE;
    progressCircle.style.strokeDashoffset = offset;
    progressPercent.textContent = `${percent}%`;
    progressFraction.textContent = `${current}/${total}`;
  }

  // Add line to terminal console
  function addLogLine(type, text) {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = text;
    consoleLogs.appendChild(line);
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
  }

  // Clear Terminal logs
  btnClearConsole.addEventListener('click', clearConsole);
  
  function clearConsole() {
    consoleLogs.innerHTML = '';
  }

  // Set Loading UI state
  function setLoadingState(isLoading) {
    btnSubmit.disabled = isLoading;
    if (isLoading) {
      btnSubmit.innerHTML = `<span class="spinner-inline"></span> DERLENİYOR, LÜTFEN BEKLEYİN...`;
      btnSubmit.style.opacity = '0.7';
      btnSubmit.style.cursor = 'not-allowed';
    } else {
      btnSubmit.innerHTML = `<span class="material-icons">bolt</span> DERLEME İŞLEMİNİ BAŞLAT`;
      btnSubmit.style.opacity = '1';
      btnSubmit.style.cursor = 'pointer';
    }
  }

  // Trigger browser file download
  function triggerDownload(jobId) {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = `/api/epub/download/${jobId}`;
    document.body.appendChild(iframe);
    setTimeout(() => iframe.remove(), 2000);
  }

  // Helpers: Extract slug from URL/string
  function extractSlug(input) {
    let slug = input.trim();
    if (slug.includes('novelgecesi.com')) {
      const clean = slug.replace(/\/$/, '');
      const parts = clean.split('/');
      slug = parts[parts.length - 1];
    }
    return slug;
  }

  // ==========================================
  // LOCAL STORAGE HISTORY MANAGEMENT
  // ==========================================

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem('epub_compiler_history')) || [];
    } catch (e) {
      return [];
    }
  }

  function saveToHistory(item) {
    const history = getHistory();
    // Remove if already exists (anti-duplication)
    const filtered = history.filter(x => x.id !== item.id);
    filtered.unshift(item); // add to top
    // Limit history to 20 items
    if (filtered.length > 20) filtered.pop();
    localStorage.setItem('epub_compiler_history', JSON.stringify(filtered));
    loadHistory();
  }

  function updateHistoryItem(id, updates) {
    const history = getHistory();
    const item = history.find(x => x.id === id);
    if (item) {
      Object.assign(item, updates);
      localStorage.setItem('epub_compiler_history', JSON.stringify(history));
      loadHistory();
    }
  }

  function deleteHistoryItem(id) {
    const history = getHistory();
    const filtered = history.filter(x => x.id !== id);
    localStorage.setItem('epub_compiler_history', JSON.stringify(filtered));
    loadHistory();
  }

  function loadHistory() {
    const history = getHistory();
    historyTbody.innerHTML = '';

    if (history.length === 0) {
      historyTbody.innerHTML = `
        <tr class="empty-history-row">
          <td colspan="5" class="empty-history">
            <span class="material-icons">folder_open</span>
            <p>Henüz bu cihazda oluşturulmuş bir EPUB kaydı yok.</p>
          </td>
        </tr>
      `;
      return;
    }

    history.forEach(item => {
      const tr = document.createElement('tr');
      
      let statusBadge = '';
      if (item.status === 'completed') {
        statusBadge = `<span class="status-badge completed"><span class="material-icons" style="font-size:12px">check_circle</span> Tamamlandı</span>`;
      } else if (item.status === 'failed') {
        statusBadge = `<span class="status-badge failed"><span class="material-icons" style="font-size:12px">error</span> Başarısız</span>`;
      } else {
        statusBadge = `<span class="status-badge running"><span class="material-icons" style="font-size:12px">autorenew</span> Derleniyor</span>`;
      }

      let actions = '';
      if (item.status === 'completed') {
        actions = `
          <div class="action-buttons">
            <button class="action-btn download" data-id="${item.id}" title="Dosyayı Yeniden İndir">
              <span class="material-icons" style="font-size:14px">download</span> İndir
            </button>
            <button class="action-btn recompile" data-slug="${item.slug}" title="Yeniden Derle">
              <span class="material-icons" style="font-size:14px">replay</span> Yeniden Yap
            </button>
            <button class="action-btn delete" data-id="${item.id}" title="Geçmişten Sil">
              <span class="material-icons" style="font-size:14px">delete</span>
            </button>
          </div>
        `;
      } else if (item.status === 'failed') {
        actions = `
          <div class="action-buttons">
            <button class="action-btn recompile" data-slug="${item.slug}" title="Yeniden Dene">
              <span class="material-icons" style="font-size:14px">replay</span> Yeniden Dene
            </button>
            <button class="action-btn delete" data-id="${item.id}" title="Geçmişten Sil">
              <span class="material-icons" style="font-size:14px">delete</span>
            </button>
          </div>
        `;
      } else {
        // running
        actions = `
          <div class="action-buttons">
            <button class="action-btn track" data-id="${item.id}" title="Durumu İzle">
              <span class="material-icons" style="font-size:14px">visibility</span> İzle
            </button>
          </div>
        `;
      }

      tr.innerHTML = `
        <td>
          <div class="history-novel-name">${escapeHtml(item.title)}</div>
          <div class="history-novel-slug">${escapeHtml(item.slug)}</div>
        </td>
        <td>${escapeHtml(item.date)}</td>
        <td>${escapeHtml(String(item.chapters))}</td>
        <td>${statusBadge}</td>
        <td>${actions}</td>
      `;

      historyTbody.appendChild(tr);
    });

    // Attach Event Listeners to Action Buttons
    attachHistoryEvents();
  }

  function attachHistoryEvents() {
    // Re-download button
    document.querySelectorAll('.action-btn.download').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = btn.getAttribute('data-id');
        triggerDownload(id);
      });
    });

    // Re-compile / Retry button
    document.querySelectorAll('.action-btn.recompile').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const slug = btn.getAttribute('data-slug');
        novelUrlInput.value = `https://www.novelgecesi.com/${slug}`;
        compileForm.dispatchEvent(new Event('submit'));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    // Track button for already running jobs
    document.querySelectorAll('.action-btn.track').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = btn.getAttribute('data-id');
        activeJobId = id;
        renderedLogCount = 0;
        statusPanel.classList.remove('hidden');
        statusPanel.scrollIntoView({ behavior: 'smooth' });
        clearConsole();
        addLogLine('info', `[SYSTEM] İşlemi izleme moduna geçildi. ID: ${id}`);
        startPolling(id);
      });
    });

    // Delete history button
    document.querySelectorAll('.action-btn.delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = btn.getAttribute('data-id');
        deleteHistoryItem(id);
      });
    });
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
