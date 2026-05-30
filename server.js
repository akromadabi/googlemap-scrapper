const express = require('express');
const path = require('path');
const fs = require('fs');
const { scrapeGoogleMaps } = require('./scraper');

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

// SSE Endpoint for Google Maps Scraping
app.get('/api/scrape', async (req, res) => {
  const { query, max } = req.query;
  const maxResults = parseInt(max) || 10;

  if (!query) {
    return res.status(400).json({ error: 'Query parameter is required' });
  }

  // Setup SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  console.log(`Received SSE scrape request: "${query}" (max: ${maxResults})`);

  // Send initial connection message
  sendSSE(res, 'info', { message: 'Browser initialized. Navigating to Google Maps...' });

  try {
    const results = await scrapeGoogleMaps(query, maxResults, (item, percent) => {
      // Send real-time progress update
      sendSSE(res, 'progress', { item, percent });
    });

    // Auto-save the crawl results locally to /data/ folder
    let fileId = '';
    if (results.length > 0) {
      fileId = `${query.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now()}`;
      const filePath = path.join(DATA_DIR, `crawl_${fileId}.json`);
      const fileContent = {
        id: fileId,
        query: query,
        timestamp: new Date().toISOString(),
        leads: results
      };
      fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2));
      console.log(`Crawl saved successfully to disk: crawl_${fileId}.json`);
    }

    // Send completion message
    sendSSE(res, 'complete', { 
      message: `Scraping completed successfully. Extracted ${results.length} places.`,
      fileId,
      results 
    });
    res.end();

  } catch (error) {
    console.error('Scraping handler error:', error);
    sendSSE(res, 'error', { message: error.message || 'An unknown error occurred during scraping.' });
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
      return {
        id: content.id,
        query: content.query,
        timestamp: content.timestamp,
        count: content.leads ? content.leads.length : 0,
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

// POST /api/history/:id/contact - Persists contacted tracking state to local crawl file
app.post('/api/history/:id/contact', (req, res) => {
  const { id } = req.params;
  const { leadId, contacted } = req.body;
  const filePath = path.join(DATA_DIR, `crawl_${id}.json`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Saved crawl not found' });
  }

  try {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let updated = false;

    if (content.leads) {
      content.leads = content.leads.map(lead => {
        if (lead.id === leadId) {
          lead.contacted = contacted;
          updated = true;
        }
        return lead;
      });
    }

    if (updated) {
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
      res.json({ success: true, message: 'Contacted tracking state saved' });
    } else {
      res.status(404).json({ error: 'Lead ID not found in saved crawl' });
    }
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
