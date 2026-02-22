#!/usr/bin/env node
/**
 * Memory benchmark: measures server RSS (MB) under sustained large output.
 */
'use strict';

const WebSocket = require('ws');
const { execSync, execFileSync } = require('child_process');

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.BENCH_PORT || process.env.PORT || '7682';
const URI = `ws://${HOST}:${PORT}/ws`;

function getServerRssMb() {
  try {
    const port = process.env.BENCH_PORT || process.env.PORT || '7682';
    const result = execSync(
      `pgrep -f "rust-terminal.*--port ${port}"`, { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim().split('\n').filter(Boolean);
    if (result.length === 0) return null;
    const pid = result[0];
    const rssKb = parseInt(
      execFileSync('ps', ['-o', 'rss=', '-p', pid], { stdio: ['pipe', 'pipe', 'pipe'] })
        .toString().trim(),
      10,
    );
    return isNaN(rssKb) ? null : rssKb / 1024;
  } catch (_) {
    return null;
  }
}

async function run() {
  const rssSamples = [];

  // Sample initial RSS
  const initialRss = getServerRssMb();
  if (initialRss !== null) rssSamples.push(initialRss);

  // Start RSS sampler
  const samplerInterval = setInterval(() => {
    const rss = getServerRssMb();
    if (rss !== null) rssSamples.push(rss);
  }, 500);

  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(URI, ['tty']);
      ws.binaryType = 'nodebuffer';

      let promptReceived = false;
      let bytesReceived = 0;
      let done = false;

      const finish = () => {
        if (!done) { done = true; ws.terminate(); resolve(); }
      };

      const timeout = setTimeout(finish, 30000);

      ws.on('error', (err) => { clearTimeout(timeout); clearInterval(samplerInterval); reject(err); });

      const send = (text) => {
        const payload = Buffer.concat([Buffer.from([0x30]), Buffer.from(text)]);
        ws.send(payload);
      };

      ws.on('open', () => {
        const init = JSON.stringify({ AuthToken: '', columns: 80, rows: 24 });
        ws.send(Buffer.from(init));
        setTimeout(() => send('echo __BENCH_READY__\r'), 2000);
      });

      ws.on('message', (data) => {
        if (done) return;
        if (!Buffer.isBuffer(data) || data.length < 2 || data[0] !== 0x30) return;

        const text = data.slice(1).toString('utf8');

        if (!promptReceived) {
          if (text.includes('__BENCH_READY__')) {
            promptReceived = true;
            send('head -c 5000000 /dev/zero | xxd\r');
          }
          return;
        }

        bytesReceived += data.length - 1;

        if (bytesReceived > 4_000_000) {
          clearTimeout(timeout);
          setTimeout(finish, 1000);
        }
      });
    });
  } finally {
    clearInterval(samplerInterval);
  }

  if (rssSamples.length === 0) {
    return { error: 'no RSS samples collected' };
  }

  return {
    test: 'memory',
    initial_rss_mb: Math.round(rssSamples[0] * 10) / 10,
    peak_rss_mb: Math.round(Math.max(...rssSamples) * 10) / 10,
    final_rss_mb: Math.round(rssSamples[rssSamples.length - 1] * 10) / 10,
    samples: rssSamples.length,
  };
}

run()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ error: String(err) }));
    process.exit(1);
  });
