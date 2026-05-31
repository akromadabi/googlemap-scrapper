// State variables to manage app data locally
let scrapedLeads = [];
let filteredLeads = [];
let eventSource = null;
let currentSortField = null;
let currentSortOrder = 'asc'; // 'asc' or 'desc'
let crossHistoryDuplicates = {}; // Global dictionary mapping phone -> duplicate crawls

// Fetch duplicates dynamically across saved crawl files
function fetchCrossHistoryDuplicates() {
  fetch('/api/duplicates')
    .then(res => res.json())
    .then(data => {
      crossHistoryDuplicates = data;
      console.log('Cross-history duplicates successfully indexed:', Object.keys(data).length);
      // Re-render views if leads are currently loaded to apply newly updated labels
      if (scrapedLeads.length > 0) {
        renderTable(filteredLeads);
        const currentTab = localStorage.getItem('active_tab');
        if (currentTab === 'outreach-tab') {
          renderOutreachList(scrapedLeads);
        }
      }
    })
    .catch(err => console.error('Error fetching cross-history duplicates:', err));
}

// Robust WhatsApp number cleaner for Indonesia (+62)
function formatWhatsAppNumber(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.substring(1);
  }
  if (!cleaned.startsWith('62') && cleaned.length >= 9 && cleaned.length <= 13) {
    cleaned = '62' + cleaned;
  }
  return cleaned;
}

// Generate badges for duplicate listings from other runs and cross-history crawls
function getDuplicateLabels(lead, allLeads) {
  if (!lead.phone) return '';
  const cleanPhone = lead.phone.replace(/[^0-9]/g, '');
  if (!cleanPhone) return '';
  
  // 1. Check local memory duplicates (within currently active results list)
  const localDuplicates = allLeads.filter(l => 
    l.id !== lead.id && 
    l.phone && 
    l.phone.replace(/[^0-9]/g, '') === cleanPhone
  );
  const localSources = localDuplicates.map(d => d.sourceQuery || 'Scrape Baru').filter(Boolean);
  
  // 2. Check cross-history duplicates scanned across other saved crawl files
  let crossSources = [];
  if (crossHistoryDuplicates && crossHistoryDuplicates[cleanPhone]) {
    const currentCrawlId = activeCrawlId || '';
    const otherCrawlEntries = crossHistoryDuplicates[cleanPhone].filter(entry => entry.crawlId !== currentCrawlId);
    crossSources = otherCrawlEntries.map(entry => entry.query);
  }
  
  // Merge and deduplicate all query sources
  const allSources = [...new Set([...localSources, ...crossSources])];
  if (allSources.length === 0) return '';
  
  return allSources.map(src => `<span class="count-badge" style="background: rgba(99, 102, 241, 0.08); color: var(--accent-text); border-color: rgba(99, 102, 241, 0.15); margin-left: 6px;">Sama di: ${src}</span>`).join('');
}

// Server-side persistent template syncing
let templateSaveTimeout = null;
function saveTemplateToServer(template) {
  if (templateSaveTimeout) clearTimeout(templateSaveTimeout);
  templateSaveTimeout = setTimeout(() => {
    fetch('/api/template', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ template })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        console.log('Template synced persistently to VPS server disk');
      }
    })
    .catch(err => console.error('Error syncing template to server:', err));
  }, 1000); // 1 second debounce
}

// Persistent Outreaching States
let activeCrawlId = null; // Keeps track of current run filename on backend
const defaultTemplate = "Halo *{name}*, saya melihat profil bisnis Anda di Google Maps. Apakah benar melayani jasa *{category}* di daerah *{address}*?";
let activeTemplate = localStorage.getItem('whatsapp_template') || defaultTemplate;

// DOM Elements
const scrapeForm = document.getElementById('scrape-form');
const searchQueryInput = document.getElementById('search-query');
const maxResultsInput = document.getElementById('max-results');
const maxValDisplay = document.getElementById('max-val-display');
const submitBtn = document.getElementById('submit-btn');
const presetBtns = document.querySelectorAll('.preset-btn');

const progressCard = document.getElementById('progress-card');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressPercentText = document.getElementById('progress-percent');
const progressCountText = document.getElementById('progress-count');
const abortBtn = document.getElementById('abort-btn');
const abortBtnLarge = document.getElementById('abort-btn-large');
const activityLogItems = document.getElementById('activity-log-items');

// Stats Elements
const statTotalLeads = document.getElementById('stat-total-leads');
const statAvgRating = document.getElementById('stat-avg-rating');
const statWebsites = document.getElementById('stat-websites');
const statPhones = document.getElementById('stat-phones');

// Table & Control Elements
const tableBody = document.getElementById('table-body');
const mobileLeadsList = document.getElementById('mobile-leads-list');
const tableSearch = document.getElementById('table-search');
const databaseCountBadge = document.getElementById('database-count-badge');
const exportCsvBtn = document.getElementById('export-csv-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const sortableHeaders = document.querySelectorAll('th.sortable');

// Tab Navigation Elements
const tabBtns = document.querySelectorAll('.tab-btn, .bottom-nav-btn');
const tabContents = document.querySelectorAll('.tab-content');
const historyList = document.getElementById('history-list');

// Outreach Panel Elements
const whatsappTemplate = document.getElementById('whatsapp-template');
const tagBadgeBtns = document.querySelectorAll('.tag-badge-btn');
const prospectsDeck = document.getElementById('prospects-deck');
const outreachCountBadge = document.getElementById('outreach-count-badge');
const outreachSearch = document.getElementById('outreach-search');

// Initialize events
document.addEventListener('DOMContentLoaded', () => {
  // Synchronize range slider value and preset buttons
  maxResultsInput.addEventListener('input', (e) => {
    updateSliderLabel(e.target.value);
    presetBtns.forEach(btn => {
      if (parseInt(btn.dataset.val) === parseInt(e.target.value)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  });

  // Preset quick selections
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const val = btn.dataset.val;
      maxResultsInput.value = val;
      updateSliderLabel(val);
    });
  });

  // Search input change -> dynamic client-side filtering
  tableSearch.addEventListener('input', (e) => {
    filterLeads(e.target.value);
  });

  // Sortable headers click listeners
  sortableHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const field = header.dataset.sort;
      handleSort(field);
      sortableHeaders.forEach(h => {
        const icon = h.querySelector('i');
        icon.className = 'fa-solid fa-sort';
      });
      const currentIcon = header.querySelector('i');
      currentIcon.className = `fa-solid fa-sort-${currentSortOrder === 'asc' ? 'up' : 'down'}`;
    });
  });

  // Form submission: Start scrape task
  scrapeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    startScraping();
  });

  // Export buttons
  exportCsvBtn.addEventListener('click', exportToCSV);
  exportJsonBtn.addEventListener('click', exportToJSON);

  // Abort scraping button
  abortBtn.addEventListener('click', stopScraping);
  if (abortBtnLarge) {
    abortBtnLarge.addEventListener('click', stopScraping);
  }

  // Tab switching handler
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      localStorage.setItem('active_tab', targetTab); // SAVE ACTIVE TAB
      
      // Synchronize active state for both top and bottom buttons
      tabBtns.forEach(b => {
        if (b.dataset.tab === targetTab) {
          b.classList.add('active');
        } else {
          b.classList.remove('active');
        }
      });

      tabContents.forEach(c => c.classList.remove('active'));
      document.getElementById(targetTab).classList.add('active');
      
      // Fetch history or trigger outreach rendering on tab change
      if (targetTab === 'history-tab') {
        fetchHistory();
      } else if (targetTab === 'outreach-tab') {
        renderOutreachList(scrapedLeads);
      }
    });
  });

  // Outreach Template Initializer
  whatsappTemplate.value = activeTemplate;
  whatsappTemplate.addEventListener('input', (e) => {
    activeTemplate = e.target.value;
    localStorage.setItem('whatsapp_template', activeTemplate);
    renderOutreachList(scrapedLeads); // Real-time preview updates!
    saveTemplateToServer(activeTemplate); // Sync persistently to server
  });

  // Template tag buttons: insert tag at cursor position
  tagBadgeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      const startPos = whatsappTemplate.selectionStart;
      const endPos = whatsappTemplate.selectionEnd;
      const text = whatsappTemplate.value;
      
      whatsappTemplate.value = text.substring(0, startPos) + tag + text.substring(endPos);
      whatsappTemplate.focus();
      
      // Update template content state
      activeTemplate = whatsappTemplate.value;
      localStorage.setItem('whatsapp_template', activeTemplate);
      renderOutreachList(scrapedLeads);
    });
  });

  // Outreach Search Input filtering
  outreachSearch.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = scrapedLeads.filter(lead => {
      return (
        (lead.name && lead.name.toLowerCase().includes(q)) ||
        (lead.category && lead.category.toLowerCase().includes(q)) ||
        (lead.phone && lead.phone.includes(q))
      );
    });
    renderOutreachList(filtered, true);
  });

  // Restore saved active tab on page load
  const savedTab = localStorage.getItem('active_tab') || 'database-tab';
  const matchingTabBtn = document.querySelector(`.tab-btn[data-tab="${savedTab}"], .bottom-nav-btn[data-tab="${savedTab}"]`);
  if (matchingTabBtn) {
    matchingTabBtn.click();
  }

  // Load saved template from server permanently on page load
  fetch('/api/template')
    .then(res => res.json())
    .then(data => {
      if (data.template) {
        activeTemplate = data.template;
        whatsappTemplate.value = activeTemplate;
        renderOutreachList(scrapedLeads);
      }
    })
    .catch(err => console.error('Error loading server template:', err));

  // Restore saved active crawl run on page load
  const savedCrawlId = localStorage.getItem('active_crawl_id');
  if (savedCrawlId) {
    loadHistoryRun(savedCrawlId, true);
  }

  // Pre-load cross-history duplicates mapping
  fetchCrossHistoryDuplicates();
});

// Helper: Update slider badge text
function updateSliderLabel(value) {
  maxValDisplay.textContent = value;
}

// Write line into log viewer
function writeLog(text, type = '') {
  const item = document.createElement('div');
  item.className = `log-item ${type}`;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  activityLogItems.appendChild(item);
  activityLogItems.scrollTop = activityLogItems.scrollHeight;
}

// Reset stats UI
function resetStats() {
  statTotalLeads.textContent = '0';
  statAvgRating.textContent = '0.0';
  statWebsites.textContent = '0%';
  statPhones.textContent = '0%';
  databaseCountBadge.textContent = '0 entries';
}

// Compute and render real-time statistics
function updateStats(leads) {
  const count = leads.length;
  statTotalLeads.textContent = count;
  databaseCountBadge.textContent = `${count} entries`;

  if (count === 0) {
    resetStats();
    return;
  }

  // Average Rating
  const ratedLeads = leads.filter(l => l.rating !== null);
  const avgRating = ratedLeads.length > 0 
    ? (ratedLeads.reduce((acc, curr) => acc + curr.rating, 0) / ratedLeads.length).toFixed(1)
    : '0.0';
  statAvgRating.textContent = avgRating;

  // Website percentage
  const withWebsite = leads.filter(l => !!l.website).length;
  const webPercent = Math.round((withWebsite / count) * 100);
  statWebsites.textContent = `${webPercent}%`;

  // Phone percentage
  const withPhone = leads.filter(l => !!l.phone).length;
  const phonePercent = Math.round((withPhone / count) * 100);
  statPhones.textContent = `${phonePercent}%`;
}

// Compiles WhatsApp template dynamically replacing placeholder tags
function compileTemplate(template, lead) {
  return template
    .replace(/{name}/g, lead.name || '')
    .replace(/{category}/g, lead.category || '')
    .replace(/{address}/g, lead.address || '')
    .replace(/{phone}/g, lead.phone || '')
    .replace(/{website}/g, lead.website || '');
}

// Render leads onto Desktop Table & Mobile Compact Cards list simultaneously!
function renderTable(leads) {
  // 1. Render Desktop Table Body
  tableBody.innerHTML = '';
  if (leads.length === 0) {
    tableBody.innerHTML = `
      <tr class="empty-row-placeholder">
        <td colspan="7">
          <div class="empty-state">
            <h3>No Leads Match</h3>
            <p>Try refining your search keyword or clearing the filter.</p>
          </div>
        </td>
      </tr>
    `;
  } else {
    leads.forEach(lead => {
      const row = document.createElement('tr');
      
      const websiteHtml = lead.website 
        ? `<a href="${lead.website}" target="_blank" class="website-btn"><i class="fa-solid fa-arrow-up-right-from-square"></i> Visit</a>`
        : `<span class="text-muted">—</span>`;

      const phoneHtml = lead.phone 
        ? `<a href="tel:${lead.phone}" class="phone-link">${lead.phone}</a>`
        : `<span class="text-muted">—</span>`;

      const ratingHtml = lead.rating 
        ? `<span class="rating-pill"><i class="fa-solid fa-star"></i> ${lead.rating.toFixed(1)}</span>`
        : `<span class="text-muted">—</span>`;

      const dupLabels = getDuplicateLabels(lead, leads);
      row.innerHTML = `
        <td style="font-weight: 500; position: relative;">
          ${lead.name}
          ${lead.contacted ? `<span class="count-badge" style="background: rgba(16, 185, 129, 0.1); color: var(--accent-green); margin-left: 6px; border-color: rgba(16,185,129,0.2)">Sent (${typeof lead.contacted === 'number' ? lead.contacted : 1}x)</span>` : ''}
          ${dupLabels}
        </td>
        <td>${lead.category ? `<span class="category-tag">${lead.category}</span>` : '<span class="text-muted">—</span>'}</td>
        <td class="text-center">${ratingHtml}</td>
        <td class="text-center reviews-count">${lead.reviewsCount || 0}</td>
        <td>${phoneHtml}</td>
        <td>${websiteHtml}</td>
        <td><div class="address-text" title="${lead.address || ''}">${lead.address || '<span class="text-muted">—</span>'}</div></td>
      `;
      tableBody.appendChild(row);
    });
  }

  // 2. Render Mobile Compact Card List
  mobileLeadsList.innerHTML = '';
  if (leads.length === 0) {
    mobileLeadsList.innerHTML = `
      <div class="empty-state">
        <h3>No Leads Match</h3>
        <p>Try refining your search keyword or clearing the filter.</p>
      </div>
    `;
  } else {
    leads.forEach(lead => {
      const card = document.createElement('div');
      card.className = 'mobile-lead-card';

      const cleanPhone = formatWhatsAppNumber(lead.phone);
      const textMessage = compileTemplate(activeTemplate, lead);
      const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(textMessage)}`;
      const dupLabels = getDuplicateLabels(lead, leads);

      card.innerHTML = `
        <div class="mobile-lead-header">
          <span class="mobile-lead-title">${lead.name} ${dupLabels}</span>
          ${lead.category ? `<span class="mobile-lead-cat">${lead.category}</span>` : ''}
        </div>
        <div class="mobile-lead-meta">
          ${lead.rating ? `<span class="rating-pill"><i class="fa-solid fa-star"></i> ${lead.rating.toFixed(1)}</span>` : ''}
          <span class="reviews-count">(${lead.reviewsCount || 0} reviews)</span>
        </div>
        <div class="mobile-lead-address">${lead.address || 'No address details'}</div>
        <div class="mobile-lead-actions">
          <div class="mobile-lead-links">
            <a href="${lead.website || '#'}" target="_blank" class="mobile-action-btn ${lead.website ? '' : 'disabled'}" title="Website">
              <i class="fa-solid fa-globe"></i>
            </a>
            <a href="tel:${lead.phone || ''}" class="mobile-action-btn ${lead.phone ? '' : 'disabled'}" title="Call">
              <i class="fa-solid fa-phone"></i>
            </a>
          </div>
          ${lead.phone ? `
            <a href="${waUrl}" target="_blank" class="mobile-wa-btn ${lead.contacted ? 'contacted' : ''}" data-id="${lead.id}">
              <i class="fa-brands fa-whatsapp"></i> ${lead.contacted ? `Sudah di-WA (${typeof lead.contacted === 'number' ? lead.contacted : 1}x)` : 'Kirim WA'}
            </a>
          ` : `
            <span class="text-muted" style="font-size: 11px;">No Phone</span>
          `}
        </div>
      `;

      // Set WA click duplicate tracker on mobile card
      const waBtn = card.querySelector('.mobile-wa-btn');
      if (waBtn) {
        waBtn.addEventListener('click', (e) => {
          markLeadContacted(lead.id);
        });
      }

      mobileLeadsList.appendChild(card);
    });
  }
}

// Client-side search/filter
function filterLeads(query) {
  if (!query) {
    filteredLeads = [...scrapedLeads];
  } else {
    const q = query.toLowerCase();
    filteredLeads = scrapedLeads.filter(lead => {
      return (
        (lead.name && lead.name.toLowerCase().includes(q)) ||
        (lead.category && lead.category.toLowerCase().includes(q)) ||
        (lead.address && lead.address.toLowerCase().includes(q)) ||
        (lead.phone && lead.phone.includes(q)) ||
        (lead.website && lead.website.toLowerCase().includes(q))
      );
    });
  }
  renderTable(filteredLeads);
}

// Client-side sorting logic
function handleSort(field) {
  if (currentSortField === field) {
    currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    currentSortField = field;
    currentSortOrder = 'asc';
  }

  const sorted = [...filteredLeads].sort((a, b) => {
    let valA = a[field];
    let valB = b[field];

    if (valA === null || valA === undefined) valA = '';
    if (valB === null || valB === undefined) valB = '';

    if (typeof valA === 'string') {
      return currentSortOrder === 'asc' 
        ? valA.localeCompare(valB)
        : valB.localeCompare(valA);
    } else {
      return currentSortOrder === 'asc' ? valA - valB : valB - valA;
    }
  });

  filteredLeads = sorted;
  renderTable(filteredLeads);
}

// Render dynamic outreach deck for WhatsApp panel
function renderOutreachList(leads, isSearch = false) {
  prospectsDeck.innerHTML = '';
  outreachCountBadge.textContent = `${leads.length} prospects`;

  if (leads.length === 0) {
    prospectsDeck.innerHTML = `
      <div class="empty-state">
        <h3>No Prospects Matching</h3>
        <p>${isSearch ? 'Refine search terms.' : 'Load a crawl to run outreach.'}</p>
      </div>
    `;
    return;
  }

  leads.forEach(lead => {
    const card = document.createElement('div');
    card.className = 'prospect-card';

    const textMessage = compileTemplate(activeTemplate, lead);
    const cleanPhone = formatWhatsAppNumber(lead.phone);
    const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(textMessage)}`;
    const dupLabels = getDuplicateLabels(lead, leads);

    card.innerHTML = `
      <div class="prospect-info">
        <div class="prospect-name-row">
          <span class="prospect-name">${lead.name}</span>
          ${dupLabels}
          ${lead.category ? `<span class="prospect-cat">${lead.category}</span>` : ''}
        </div>
        <div class="prospect-meta-row">
          ${lead.phone ? `<span class="meta-item"><i class="fa-solid fa-phone"></i> ${lead.phone}</span>` : ''}
          ${lead.website ? `<span class="meta-item"><i class="fa-solid fa-globe"></i> <a href="${lead.website}" target="_blank">Website</a></span>` : ''}
        </div>
        <div class="prospect-msg-preview">${textMessage}</div>
      </div>
      
      <div class="prospect-actions">
        ${lead.phone ? `
          <a href="${waUrl}" target="_blank" class="btn-whatsapp ${lead.contacted ? 'contacted' : ''}" data-id="${lead.id}">
            <i class="fa-brands fa-whatsapp"></i> ${lead.contacted ? `Sudah di-WA (${typeof lead.contacted === 'number' ? lead.contacted : 1}x)` : 'Kirim WA'}
          </a>
        ` : `
          <span class="text-muted" style="font-size: 11px;">No Phone Available</span>
        `}
      </div>
    `;

    // Intercept clicks on WA outreach button to prevent double messages and save states
    const waBtn = card.querySelector('.btn-whatsapp');
    if (waBtn) {
      waBtn.addEventListener('click', (e) => {
        markLeadContacted(lead.id);
      });
    }

    prospectsDeck.appendChild(card);
  });
}

// Persistent duplicate prevention tracker
function markLeadContacted(leadId) {
  let updatedCount = 1;
  const targetLead = scrapedLeads.find(l => l.id === leadId);
  if (!targetLead) return;
  
  const targetPhone = targetLead.phone ? targetLead.phone.replace(/[^0-9]/g, '') : '';
  
  // 1. In-memory state update
  scrapedLeads = scrapedLeads.map(lead => {
    const isSamePhone = targetPhone && lead.phone && lead.phone.replace(/[^0-9]/g, '') === targetPhone;
    if (lead.id === leadId || isSamePhone) {
      if (typeof lead.contacted === 'number') {
        lead.contacted += 1;
      } else if (lead.contacted === true) {
        lead.contacted = 2;
      } else {
        lead.contacted = 1;
      }
      if (lead.id === leadId) {
        updatedCount = lead.contacted;
      }
      writeLog(`Marked contacted: ${lead.name} (${lead.contacted}x)`, 'system');
    }
    return lead;
  });
  
  filteredLeads = [...scrapedLeads];

  // 2. Refresh lists row-by-row & card-by-card instantly!
  renderTable(filteredLeads);
  renderOutreachList(filteredLeads);

  // 3. Save persistently to backend folder for ALL affected leads!
  const affectedLeads = scrapedLeads.filter(lead => {
    const isSamePhone = targetPhone && lead.phone && lead.phone.replace(/[^0-9]/g, '') === targetPhone;
    return (lead.id === leadId || isSamePhone) && lead.sourceId;
  });
  
  affectedLeads.forEach(lead => {
    fetch(`/api/history/${lead.sourceId}/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ leadId: lead.id, contacted: lead.contacted })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        console.log(`Saved contacted status (${lead.contacted}x) to JSON crawl ${lead.sourceId} on disk`);
      }
    })
    .catch(err => console.error('Error saving contacted status to disk:', err));
  });
}

// Fetch saved histories catalog from backend
function fetchHistory() {
  historyList.innerHTML = `<div class="empty-state"><h3>Loading Saved History...</h3></div>`;
  
  fetch('/api/history')
    .then(res => res.json())
    .then(history => {
      historyList.innerHTML = '';
      if (history.length === 0) {
        historyList.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon"><i class="fa-solid fa-folder-open"></i></div>
            <h3>No History Found</h3>
            <p>Your search crawls will automatically show up here once you run a scraping task.</p>
          </div>
        `;
        return;
      }

      history.forEach(item => {
        const row = document.createElement('div');
        row.className = 'history-item';

        const dateStr = new Date(item.timestamp).toLocaleString();

        row.innerHTML = `
          <div class="history-item-info">
            <span class="history-query">${item.query}</span>
            <div class="history-meta">
              <span><i class="fa-solid fa-calendar"></i> ${dateStr}</span>
              <span><i class="fa-solid fa-address-book"></i> ${item.count} Leads</span>
            </div>
          </div>
          <div class="history-item-actions">
            <button class="btn-load-run" data-id="${item.id}">Load Run</button>
            <button class="btn-delete-run" data-id="${item.id}" title="Hapus Riwayat"><i class="fa-solid fa-trash"></i></button>
          </div>
        `;

        const loadBtn = row.querySelector('.btn-load-run');
        loadBtn.addEventListener('click', () => {
          loadHistoryRun(item.id);
        });

        const deleteBtn = row.querySelector('.btn-delete-run');
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`Apakah Anda yakin ingin menghapus riwayat scraping "${item.query}" ini secara permanen?`)) {
            deleteHistoryRun(item.id);
          }
        });

        historyList.appendChild(row);
      });
    })
    .catch(err => {
      console.error('History fetch error:', err);
      historyList.innerHTML = `<div class="empty-state"><h3 style="color: var(--accent-red)">Error loading history</h3></div>`;
    });
}

// DELETE saved crawl from history catalog
function deleteHistoryRun(id) {
  fetch(`/api/history/${id}`, {
    method: 'DELETE'
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      // Re-fetch the history list instantly
      fetchHistory();
      fetchCrossHistoryDuplicates();
      if (activeCrawlId === id) {
        activeCrawlId = null;
      }
    } else {
      alert(`Error: ${data.error}`);
    }
  })
  .catch(err => {
    console.error('Error deleting history:', err);
    alert('Failed to delete saved crawl.');
  });
}

// Load full crawl JSON from history
function loadHistoryRun(id, preventTabSwitch = false) {
  fetch(`/api/history/${id}`)
    .then(res => res.json())
    .then(data => {
      // 1. Load data to active memory
      scrapedLeads = (data.leads || []).map(lead => {
        lead.sourceId = data.id;
        lead.sourceQuery = data.query;
        return lead;
      });
      filteredLeads = [...scrapedLeads];
      activeCrawlId = data.id;
      localStorage.setItem('active_crawl_id', id); // Save active crawl id

      // 2. Synchronize controls inputs
      searchQueryInput.value = data.query;
      maxResultsInput.value = scrapedLeads.length;
      updateSliderLabel(scrapedLeads.length);
      
      presetBtns.forEach(btn => {
        if (parseInt(btn.dataset.val) === scrapedLeads.length) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      // 3. Update stats, tables & card lists
      updateStats(scrapedLeads);
      renderTable(filteredLeads);
      
      exportCsvBtn.disabled = false;
      exportJsonBtn.disabled = false;

      // 4. Switch UI to Database Tab if not prevented
      if (!preventTabSwitch) {
        const dbTabBtn = document.querySelector('[data-tab="database-tab"]');
        if (dbTabBtn) dbTabBtn.click();
      } else {
        const currentTab = localStorage.getItem('active_tab') || 'database-tab';
        if (currentTab === 'outreach-tab') {
          renderOutreachList(scrapedLeads);
        }
      }

      // Show completed message in logs
      progressCard.classList.remove('hidden');
      const progressHeaderTitle = progressCard.querySelector('.progress-header h3');
      if (progressHeaderTitle) {
        progressHeaderTitle.innerHTML = '<i class="fa-solid fa-circle-check" style="color: var(--accent-green)"></i> Crawl Loaded';
      }
      activityLogItems.innerHTML = '';
      writeLog(`Loaded crawl run "${data.query}" saved on ${new Date(data.timestamp).toLocaleString()}`, 'success');
    })
    .catch(err => {
      console.error('Load history run error:', err);
      if (!preventTabSwitch) {
        alert('Failed to load saved search crawl.');
      }
    });
}

// Start SSE connection and scraping task
function startScraping() {
  const query = searchQueryInput.value.trim();
  const max = maxResultsInput.value;

  if (!query) return;

  // Retrieve checked search target sources
  const selectedCheckboxes = Array.from(document.querySelectorAll('.source-checkbox:checked'));
  if (selectedCheckboxes.length === 0) {
    alert('Silakan pilih minimal satu target pencarian (Google Maps, Instagram, TikTok, atau Facebook).');
    return;
  }
  const sources = selectedCheckboxes.map(cb => cb.value).join(',');

  // UI state transition
  submitBtn.disabled = true;
  submitBtn.classList.add('loading');
  submitBtn.querySelector('.btn-text').textContent = 'Scraping...';
  
  progressCard.classList.remove('hidden');
  const progressHeaderTitle = progressCard.querySelector('.progress-header h3');
  if (progressHeaderTitle) {
    progressHeaderTitle.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" style="color: var(--accent-blue)"></i> Scraping...';
  }
  progressBarFill.style.width = '0%';
  progressPercentText.textContent = '0%';
  progressCountText.textContent = `0 / ${max} Leads`;
  
  if (abortBtnLarge) {
    abortBtnLarge.style.display = 'flex';
  }
  
  activityLogItems.innerHTML = '';
  scrapedLeads = [];
  filteredLeads = [];
  activeCrawlId = null; // Scrape is active, not saved yet
  resetStats();
  renderTable([]);
  
  exportCsvBtn.disabled = true;
  exportJsonBtn.disabled = true;

  writeLog(`Initializing scraper task for "${query}" (Target: ${max})...`, 'system');

  // Connect to SSE Endpoint
  const url = `/api/scrape?query=${encodeURIComponent(query)}&max=${max}&sources=${sources}`;
  eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'info':
        writeLog(data.message, 'system');
        break;
      
      case 'progress':
        const { item, percent } = data;
        item.sourceQuery = query; // Map source query on progress
        scrapedLeads.push(item);
        filteredLeads = [...scrapedLeads];
        
        // Update progress visualizer
        progressBarFill.style.width = `${percent}%`;
        progressPercentText.textContent = `${percent}%`;
        progressCountText.textContent = `${scrapedLeads.length} / ${max} Leads`;
        
        writeLog(`Leads found: ${item.name} | Phone: ${item.phone || 'None'} | Rating: ${item.rating || 'None'}`, 'success');
        
        updateStats(scrapedLeads);
        renderTable(filteredLeads);
        break;

      case 'complete':
        writeLog(data.message, 'success');
        cleanupScrapeState();
        if (data.results && data.results.length > 0) {
          scrapedLeads = data.results.map(lead => {
            lead.sourceId = data.fileId;
            lead.sourceQuery = query;
            return lead;
          });
          filteredLeads = [...scrapedLeads];
          activeCrawlId = data.fileId; // Save active crawl file reference
          localStorage.setItem('active_crawl_id', data.fileId); // Save active crawl id
          fetchCrossHistoryDuplicates(); // Load newly updated cross-history indexes
          updateStats(scrapedLeads);
          renderTable(filteredLeads);
          exportCsvBtn.disabled = false;
          exportJsonBtn.disabled = false;
        }
        break;

      case 'error':
        writeLog(`Error occurred: ${data.message}`, 'error');
        cleanupScrapeState();
        alert(`Scraping Error: ${data.message}`);
        break;
    }
  };

  eventSource.onerror = (err) => {
    console.error('EventSource error:', err);
    writeLog('Connection with scraper backend lost or completed.', 'system');
    cleanupScrapeState();
  };
}

// Abort actively running scraper
function stopScraping() {
  if (eventSource) {
    writeLog('Scraping session aborted by user.', 'error');
    cleanupScrapeState();
  }
}

// Restore UI states from loading to idle
function cleanupScrapeState() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  submitBtn.disabled = false;
  submitBtn.classList.remove('loading');
  submitBtn.querySelector('.btn-text').textContent = 'Generate Leads';
  
  if (abortBtnLarge) {
    abortBtnLarge.style.display = 'none';
  }

  // Update progress header state
  const progressHeaderTitle = progressCard.querySelector('.progress-header h3');
  if (progressHeaderTitle) {
    progressHeaderTitle.innerHTML = '<i class="fa-solid fa-circle-check" style="color: var(--accent-green)"></i> Completed';
  }

  // If we collected leads, enable export buttons
  if (scrapedLeads.length > 0) {
    exportCsvBtn.disabled = false;
    exportJsonBtn.disabled = false;
  }
}

// Export array results to CSV format
function exportToCSV() {
  if (scrapedLeads.length === 0) return;

  const headers = ['Name', 'Category', 'Rating', 'ReviewsCount', 'Phone', 'Website', 'Address', 'Hours', 'URL', 'Contacted'];
  const rows = scrapedLeads.map(lead => [
    lead.name || '',
    lead.category || '',
    lead.rating || '',
    lead.reviewsCount || 0,
    lead.phone || '',
    lead.website || '',
    lead.address || '',
    lead.hours || '',
    lead.url || '',
    lead.contacted ? `Yes (${typeof lead.contacted === 'number' ? lead.contacted : 1}x)` : 'No'
  ]);

  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += headers.map(h => `"${h.replace(/"/g, '""')}"`).join(',') + "\n";
  
  rows.forEach(row => {
    csvContent += row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + "\n";
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  const querySanitized = searchQueryInput.value.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  link.setAttribute("download", `gmaps_leads_${querySanitized}_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Export array results to JSON format
function exportToJSON() {
  if (scrapedLeads.length === 0) return;

  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(scrapedLeads, null, 2));
  const link = document.createElement("a");
  link.setAttribute("href", dataStr);
  const querySanitized = searchQueryInput.value.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  link.setAttribute("download", `gmaps_leads_${querySanitized}_${Date.now()}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
