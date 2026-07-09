FROM node:24-slim

WORKDIR /usr/src/rewards-dashboard

ENV NODE_ENV=production

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data

EXPOSE 8890

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8890/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
