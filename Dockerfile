# Playwright base: Chromium + its system deps preinstalled. Keep the tag in sync with the `playwright` npm version.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app
ENV NODE_ENV=production

# Install workspace deps first for layer caching (dev deps too: the backend runs via tsx, the frontend builds with Vite).
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --include=dev --ignore-scripts

COPY tsconfig.base.json ./
COPY shared shared
COPY backend backend
COPY frontend frontend
RUN npm run build -w frontend

# Inside a container there is no display: always headless.
ENV BROWSER_HEADLESS=true PORT=3000
EXPOSE 3000
CMD ["npm", "start", "-w", "backend"]
