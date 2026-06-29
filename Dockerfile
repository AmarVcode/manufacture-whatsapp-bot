FROM php:8.2-apache

# Install Node.js, Puppeteer dependencies (Chromium), and MySQL extensions
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && docker-php-ext-install pdo pdo_mysql

# Enable Apache mod_rewrite
RUN a2enmod rewrite

# Set working directory to Apache web root
WORKDIR /var/www/html

# Copy all project files
COPY . .

# Install Node dependencies
RUN npm install

# Expose port 80 for Render Web Service
EXPOSE 80

# Create a startup script
RUN echo "#!/bin/bash\napache2-foreground & node whatsapp_reporter.js\nwait -n\nexit \$?" > /start.sh
RUN chmod +x /start.sh

# Run the startup script
CMD ["/start.sh"]
