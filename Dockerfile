FROM node:20

# Install Puppeteer dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all project files
COPY . .

# Create directories for auth info (though Render free tier doesn't have persistent storage)
RUN mkdir -p baileys_auth_info

# Expose port (will use PORT env var)
EXPOSE 10000

# Start the app
CMD ["node", "whatsapp_reporter.js"]
