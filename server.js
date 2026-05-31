const express = require('express');
const path = require('path');
const fs = require('fs');
const { scrapeGoogleMaps, scrapeSocialMedia } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON body parsing for API updates
app.use(express.json());

// Setup local data directory for persistent search logs
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Serve static files from root directory
app.use(express.static(__dirname));

// SSE Endpoint for Google Maps & Social Media Scraping
app.get('/api/scrape', async (req, res) => {
  const { query, max, sources } = req.query;
  const maxResults = parseInt(max) || 10;
  
  // Parse sources from query, default to gmaps if empty
  const selectedSources = sources ? sources.split(',').filter(Boolean) : ['gmaps'];

  if (!query) {
    return res.status(400).json({ error: 'Query parameter is required' });
  }

  // Setup SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  console.log(`Received SSE scrape request: "${query}" | Sources: [${selectedSources.join(', ')}] (total max: ${maxResults})`);

  let isAborted = false;
  req.on('close', () => {
    console.log(`Client disconnected. Aborting scrape task for query: "${query}"`);
    isAborted = true;
  });

  // Split maxResults limit evenly across selected sources
  const resultsPerSource = Math.max(1, Math.floor(maxResults / selectedSources.length));
  let aggregatedResults = [];
  
  try {
    for (let i = 0; i < selectedSources.length; i++) {
      if (isAborted) {
        console.log("Scraping aborted early due to client disconnect.");
        break;
      }

      const source = selectedSources[i];
      const sourceLimit = (i === selectedSources.length - 1) 
        ? (maxResults - aggregatedResults.length) // Give remainder to the last source
        : resultsPerSource;

      if (sourceLimit <= 0) break;

      sendSSE(res, 'info', { message: `Menginisialisasi pencarian di platform: ${source.toUpperCase()} (Batas: ${sourceLimit})...` });

      let sourceResults = [];
      if (source === 'gmaps') {
        sourceResults = await scrapeGoogleMaps(query, sourceLimit, (item, percent) => {
          if (isAborted) return;
          // Calculate overall progress percentage
          const overallPercent = Math.min(100, Math.round(((i + (percent / 100)) / selectedSources.length) * 100));
          sendSSE(res, 'progress', { item, percent: overallPercent });
        });
      } else {
        sourceResults = await scrapeSocialMedia(query, source, sourceLimit, (item, percent) => {
          if (isAborted) return;
          const overallPercent = Math.min(100, Math.round(((i + (percent / 100)) / selectedSources.length) * 100));
          sendSSE(res, 'progress', { item, percent: overallPercent });
        });
      }

      // Add source identification tags
      sourceResults.forEach(item => {
        item.sourcePlatform = source;
      });

      aggregatedResults = aggregatedResults.concat(sourceResults);
    }

    if (isAborted) {
      res.end();
      return;
    }

    // Auto-save the crawl results locally to /data/ folder
    let fileId = '';
    if (aggregatedResults.length > 0) {
      fileId = `${query.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now()}`;
      const filePath = path.join(DATA_DIR, `crawl_${fileId}.json`);
      const fileContent = {
        id: fileId,
        query: query,
        timestamp: new Date().toISOString(),
        leads: aggregatedResults
      };
      fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2));
      console.log(`Crawl saved successfully to disk: crawl_${fileId}.json`);
    }

    // Send completion message
    sendSSE(res, 'complete', { 
      message: `Scraping completed successfully. Extracted ${aggregatedResults.length} leads in total.`,
      fileId,
      results: aggregatedResults 
    });
    res.end();

  } catch (error) {
    console.error('Scraping handler error:', error);
    if (!isAborted) {
      sendSSE(res, 'error', { message: error.message || 'An unknown error occurred during scraping.' });
    }
    res.end();
  }
});

// GET /api/history - Lists all saved crawls dynamically
app.get('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('crawl_') && f.endsWith('.json'));
    const history = files.map(file => {
      const filePath = path.join(DATA_DIR, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      
      // Determine unique sourcePlatform tags used in this crawl
      let platforms = ['gmaps'];
      if (content.leads && Array.isArray(content.leads)) {
        const uniquePlats = [...new Set(content.leads.map(l => l.sourcePlatform || 'gmaps'))];
        if (uniquePlats.length > 0) {
          platforms = uniquePlats;
        }
      }

      return {
        id: content.id,
        query: content.query,
        timestamp: content.timestamp,
        count: content.leads ? content.leads.length : 0,
        platforms: platforms,
        filename: file
      };
    });
    // Sort by latest timestamp (newest crawls first)
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(history);
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/:id - Loads full dataset of a specific saved crawl
app.get('/api/history/:id', (req, res) => {
  const { id } = req.params;
  const filePath = path.join(DATA_DIR, `crawl_${id}.json`);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Saved crawl not found' });
  }
  
  try {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json(content);
  } catch (err) {
    console.error('Error loading saved crawl:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/duplicates - Aggregates cross-history duplicate listings by phone number
app.get('/api/duplicates', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('crawl_') && f.endsWith('.json'));
    const phoneToCrawls = {}; // cleanPhone -> Set of crawlIds
    const phoneToLeads = {};  // cleanPhone -> Array of { leadId, name, query, crawlId, contacted }

    // First pass: scan and group all lead phone numbers
    files.forEach(file => {
      const filePath = path.join(DATA_DIR, file);
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const crawlId = content.id;
        const query = content.query;
        if (content.leads) {
          content.leads.forEach(lead => {
            if (lead.phone) {
              const clean = lead.phone.replace(/[^0-9]/g, '');
              if (clean && clean.length >= 9) {
                if (!phoneToCrawls[clean]) {
                  phoneToCrawls[clean] = new Set();
                  phoneToLeads[clean] = [];
                }
                phoneToCrawls[clean].add(crawlId);
                phoneToLeads[clean].push({
                  leadId: lead.id,
                  name: lead.name,
                  query: query,
                  crawlId: crawlId,
                  contacted: lead.contacted || false
                });
              }
            }
          });
        }
      } catch (e) {
        console.error(`Error parsing duplicate check file ${file}:`, e);
      }
    });

    // Second pass: filter to keep only phone numbers that exist in 2 or more DIFFERENT crawls
    const crossDuplicates = {};
    for (const [phone, crawls] of Object.entries(phoneToCrawls)) {
      if (crawls.size >= 2) {
        crossDuplicates[phone] = phoneToLeads[phone];
      }
    }

    res.json(crossDuplicates);
  } catch (err) {
    console.error('Error calculating duplicates:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/history/:id/contact - Persists contacted tracking state to local crawl file and auto-syncs duplicates
app.post('/api/history/:id/contact', (req, res) => {
  const { id } = req.params;
  const { leadId, contacted } = req.body;
  const filePath = path.join(DATA_DIR, `crawl_${id}.json`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Saved crawl not found' });
  }

  try {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let targetPhone = '';
    let updated = false;

    if (content.leads) {
      content.leads = content.leads.map(lead => {
        if (lead.id === leadId) {
          lead.contacted = contacted;
          targetPhone = lead.phone ? lead.phone.replace(/[^0-9]/g, '') : '';
          updated = true;
        }
        return lead;
      });
    }

    if (!updated) {
      return res.status(404).json({ error: 'Lead ID not found in saved crawl' });
    }

    // Save the primary file
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));

    // Cross-History Sync: If phone exists, update all other files sharing this phone number
    if (targetPhone) {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('crawl_') && f.endsWith('.json') && f !== `crawl_${id}.json`);
      files.forEach(file => {
        const otherPath = path.join(DATA_DIR, file);
        try {
          const otherContent = JSON.parse(fs.readFileSync(otherPath, 'utf-8'));
          let otherUpdated = false;
          if (otherContent.leads) {
            otherContent.leads = otherContent.leads.map(lead => {
              const leadPhone = lead.phone ? lead.phone.replace(/[^0-9]/g, '') : '';
              if (leadPhone && leadPhone === targetPhone) {
                lead.contacted = contacted;
                otherUpdated = true;
              }
              return lead;
            });
          }
          if (otherUpdated) {
            fs.writeFileSync(otherPath, JSON.stringify(otherContent, null, 2));
            console.log(`Auto-synchronized contacted status (${contacted}x) in crawl file ${file}`);
          }
        } catch (err) {
          console.error(`Error syncing duplicate in file ${file}:`, err);
        }
      });
    }

    res.json({ success: true, message: 'Contacted tracking state saved and synchronized across history' });
  } catch (err) {
    console.error('Error updating contacted status:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/history/:id - Deletes a specific saved crawl JSON file from local disk
app.delete('/api/history/:id', (req, res) => {
  const { id } = req.params;
  const filePath = path.join(DATA_DIR, `crawl_${id}.json`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Saved crawl not found' });
  }

  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: 'Saved crawl deleted successfully' });
  } catch (err) {
    console.error('Error deleting saved crawl:', err);
    res.status(500).json({ error: err.message });
  }
});

// Path to save template permanently on server disk
const TEMPLATE_FILE = path.join(DATA_DIR, 'whatsapp_template.txt');

// GET /api/template - Loads the saved WhatsApp message template
app.get('/api/template', (req, res) => {
  try {
    if (fs.existsSync(TEMPLATE_FILE)) {
      const template = fs.readFileSync(TEMPLATE_FILE, 'utf-8');
      res.json({ template });
    } else {
      res.json({ template: '' });
    }
  } catch (err) {
    console.error('Error reading template:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/template - Persists the active WhatsApp template to disk
app.post('/api/template', (req, res) => {
  const { template } = req.body;
  try {
    fs.writeFileSync(TEMPLATE_FILE, template || '', 'utf-8');
    res.json({ success: true, message: 'Template saved successfully' });
  } catch (err) {
    console.error('Error saving template:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to send SSE messages
function sendSSE(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

// Fallback to index.html for single page routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 Google Maps Scraper running at: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
