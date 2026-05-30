#!/bin/bash

# Define directories
PROJECT_DIR="/www/wwwroot/scrapp.map"

echo "=================================================="
echo "🚀 Google Maps Scraper - Auto Deployment Script"
echo "=================================================="

# Navigate to project directory
echo "📂 Navigating to $PROJECT_DIR..."
cd "$PROJECT_DIR" || { echo "❌ Directory not found!"; exit 1; }

# Pull latest changes from GitHub
echo "🔄 Pulling latest changes from GitHub..."
git pull origin main || { echo "❌ Git pull failed!"; exit 1; }

# Install any newly added dependencies
echo "📦 Installing npm dependencies..."
npm install --no-audit --no-fund || { echo "❌ npm install failed!"; exit 1; }

# Restart the process in PM2
echo "🔄 Restarting PM2 scraper instance..."
pm2 restart scraper || {
  echo "⚠️ PM2 'scraper' process not found. Attempting to start a new one..."
  pm2 start server.js --name "scraper" || { echo "❌ Failed to start PM2 process!"; exit 1; }
}

# Display PM2 status table
echo "✅ Deployment completed successfully!"
echo "=================================================="
pm2 status
