const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Enable stealth plugin
puppeteer.use(StealthPlugin());

function generateId(url) {
  if (!url) return Math.random().toString(36).substring(2, 9);
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return 'place_' + Math.abs(hash).toString(36);
}

/**
 * Scrapes Google Maps for a given query and calls the onProgress callback as items are found.
 * @param {string} query - The search query (e.g., "Restoran di Jakarta")
 * @param {number} maxResults - Maximum number of results to fetch
 * @param {function} onProgress - Callback function for real-time progress updates: (item, progressPercent) => {}
 */
async function scrapeGoogleMaps(query, maxResults = 10, onProgress = null) {
  console.log(`Starting scrape for: "${query}" with max results: ${maxResults}`);
  
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    // Navigate to Google Maps search page
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the feed container (search results sidebar)
    // Google Maps uses role="feed" for the results list
    const feedSelector = 'div[role="feed"]';
    try {
      await page.waitForSelector(feedSelector, { timeout: 15000 });
    } catch (e) {
      console.log("Feed selector not found directly, checking if we navigated to a single place card...");
      // Sometimes if the query is very specific, Google Maps redirects directly to a single place page
      const singlePlaceTitleSelector = 'h1.DUwDvf';
      const hasSinglePlace = await page.evaluate((sel) => !!document.querySelector(sel), singlePlaceTitleSelector);
      
      if (hasSinglePlace) {
        const details = await extractPlaceDetails(page);
        details.url = page.url();
        details.id = generateId(details.url);
        details.contacted = false;
        if (onProgress) {
          onProgress({ ...details, query }, 100);
        }
        await browser.close();
        return [details];
      }
      throw new Error("Could not find search results feed. Please try a broader search query.");
    }

    let results = [];
    let seenUrls = new Set();
    let seenUniqueKeys = new Set(); // Prevent duplicate name/phone/address in results
    let endOfListReached = false;
    let retries = 0;

    while (results.length < maxResults && !endOfListReached) {
      // Find all place link elements in the feed
      // Place links contain "/maps/place/" in their href
      const placeElements = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]'));
        const seenUrlsInFeed = new Set();
        const feedResults = [];
        
        links.forEach((link, index) => {
          const url = link.href;
          if (seenUrlsInFeed.has(url)) return;
          seenUrlsInFeed.add(url);
          
          const container = link.closest('.Nv2PK') || link;
          const titleEl = container.querySelector('.qBF1Pd');
          feedResults.push({
            title: titleEl ? titleEl.textContent.trim() : 'Unknown Place',
            url: url,
            selectorIndex: index
          });
        });
        return feedResults;
      });

      console.log(`Found ${placeElements.length} place links in current view.`);

      if (placeElements.length === 0) {
        break;
      }

      // Check if we have new places to process
      let newPlacesToProcess = placeElements.filter(p => !seenUrls.has(p.url));
      
      if (newPlacesToProcess.length === 0) {
        retries++;
        if (retries > 5) {
          console.log("No new elements found after several scrolls. Ending search.");
          endOfListReached = true;
          break;
        }
      } else {
        retries = 0;
      }

      // Process places in the current view
      for (const place of newPlacesToProcess) {
        if (results.length >= maxResults) break;

        seenUrls.add(place.url);
        
        try {
          console.log(`Extracting details for: ${place.title}`);
          
          // Get currently opened place title to detect if card updates
          const oldTitle = await page.evaluate(() => {
            return document.querySelector('h1.DUwDvf')?.textContent?.trim() || "";
          });

          // Generate a safe unique ID for this element in order to click it natively without selector issues
          const tempId = `place-click-${Date.now()}`;
          const elementAssigned = await page.evaluate((url, id) => {
            // Find link with the exact URL
            const el = document.querySelector(`div[role="feed"] a[href="${url}"]`);
            if (el) {
              const clickTarget = el.querySelector('.qBF1Pd') || el;
              clickTarget.setAttribute('id', id);
              clickTarget.scrollIntoView({ block: 'center', inline: 'center' });
              return true;
            }
            return false;
          }, place.url, tempId);

          if (!elementAssigned) {
            throw new Error("Could not locate the listing element in the DOM.");
          }

          // Trigger click using BOTH page.click and browser-level .click() fallback
          try {
            await page.click(`#${tempId}`);
          } catch (clickErr) {
            console.log("Puppeteer click failed, trying DOM click...");
            await page.evaluate((id) => {
              document.getElementById(id)?.click();
            }, tempId);
          }

          // Wait for the detail panel to update to the new place details
          let loaded = false;
          const startTime = Date.now();
          while (Date.now() - startTime < 8000) {
            const currentTitle = await page.evaluate(() => {
              return document.querySelector('h1.DUwDvf')?.textContent?.trim() || "";
            });
            
            // If the title has updated (different from previous place, or matches target)
            if (currentTitle && (currentTitle !== oldTitle || !oldTitle)) {
              loaded = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }

          if (!loaded) {
            console.log(`Warning: Detail card did not transition from "${oldTitle}" to new place.`);
          }

          // Wait briefly for content to finish rendering
          await new Promise(resolve => setTimeout(resolve, 600));

          // Extract details
          const details = await extractPlaceDetails(page);
          details.url = place.url;
          details.id = generateId(place.url);
          details.contacted = false;

          // Double prevention: filter duplicates by Name + Address or Name + Phone
          const nameClean = (details.name || '').toLowerCase().trim();
          const secondaryClean = (details.phone || details.address || '').toLowerCase().trim();
          const uniqueKey = `${nameClean}|${secondaryClean}`;
          
          if (seenUniqueKeys.has(uniqueKey)) {
            console.log(`Duplicate skipped in result list: ${details.name}`);
            continue;
          }
          
          seenUniqueKeys.add(uniqueKey);
          results.push(details);

          console.log(`Scraped (${results.length}/${maxResults}): ${details.name}`);

          if (onProgress) {
            const progressPercent = Math.min(100, Math.round((results.length / maxResults) * 100));
            onProgress({ ...details, query }, progressPercent);
          }

        } catch (err) {
          console.error(`Error scraping place ${place.title}:`, err.message);
          // Continue to next place even if one fails
        }
      }

      if (results.length >= maxResults) break;

      // Scroll feed down to load more results
      console.log("Scrolling down results panel...");
      const scrollResult = await page.evaluate(async (feedSel) => {
        const feed = document.querySelector(feedSel);
        if (!feed) return { scrolled: false, end: true };

        const previousHeight = feed.scrollHeight;
        feed.scrollBy(0, 1500);
        
        // Wait for lazy loading
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const isEnd = document.body.innerText.includes("Anda telah mencapai akhir daftar") || 
                      document.body.innerText.includes("reached the end of the list") ||
                      feed.scrollHeight === previousHeight;

        return {
          scrolled: feed.scrollHeight > previousHeight,
          end: isEnd
        };
      }, feedSelector);

      if (scrollResult.end && !scrollResult.scrolled) {
        console.log("End of Google Maps listing reached.");
        endOfListReached = true;
      }
    }

    await browser.close();
    return results;

  } catch (error) {
    console.error("Scraping error:", error);
    if (browser) await browser.close();
    throw error;
  }
}

/**
 * Helper to extract place details from the active panel.
 * Uses robust attributes to survive DOM shifts.
 */
async function extractPlaceDetails(page) {
  return page.evaluate(() => {
    const getText = (selector) => document.querySelector(selector)?.textContent?.trim() || "";
    
    // Name
    const name = getText('h1.DUwDvf');

    // Rating & Reviews
    let rating = "";
    let reviewsCount = "";
    const ratingContainer = document.querySelector('div.F7nice');
    if (ratingContainer) {
      const ratingEl = ratingContainer.querySelector('span[aria-hidden="true"]');
      rating = ratingEl ? ratingEl.textContent.trim() : "";
      
      const reviewsEl = ratingContainer.querySelector('span[aria-label*="ulasan"], span[aria-label*="review"]');
      if (reviewsEl) {
        const matches = reviewsEl.getAttribute('aria-label').match(/\d+/);
        reviewsCount = matches ? matches[0] : "";
      }
    }

    // Category
    const category = getText('button[class*="DkE7fc"]'); // Common class for category below title

    // Address
    const addressEl = document.querySelector('button[data-item-id="address"]');
    const address = addressEl ? addressEl.textContent.trim() : "";

    // Website
    const websiteEl = document.querySelector('a[data-item-id="authority"]');
    const website = websiteEl ? websiteEl.getAttribute('href') : "";

    // Phone
    const phoneEl = document.querySelector('button[data-item-id^="phone:tel:"]');
    const phone = phoneEl ? phoneEl.textContent.trim() : "";

    // Hours (Extracting today's hours if available)
    const hoursEl = document.querySelector('div[data-item-id="oh"]');
    let hours = "";
    if (hoursEl) {
      hours = hoursEl.getAttribute('aria-label') || getText('div[data-item-id="oh"] .t39EBc');
    }

    return {
      name,
      rating: rating ? parseFloat(rating.replace(',', '.')) : null,
      reviewsCount: reviewsCount ? parseInt(reviewsCount) : 0,
      category,
      address,
      website,
      phone,
      hours: hours ? hours.trim() : ""
    };
  });
}

module.exports = { scrapeGoogleMaps };
