FROM node:24-slim

WORKDIR /usr/src/rewards-dashboard

ENV NODE_ENV=production
# Everything persistent (point history, runs, activity, schedule) lives here.
# Mount a volume at /data or it's lost when the container is replaced.
ENV DATA_DIR=/data

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data

EXPOSE 8890

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const u=process.env.DASHBOARD_USERNAME||'';const p=process.env.DASHBOARD_PASSWORD||'';const headers=u&&p?{Authorization:'Basic '+Buffer.from(u+':'+p).toString('base64')}:{};fetch('http://127.0.0.1:8890/api/health',{headers}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
