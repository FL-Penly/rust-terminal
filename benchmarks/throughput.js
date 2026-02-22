#!/usr/bin/env node
/**
 * Throughput benchmark: measures MB/s for large output (seq 1 500000)
 * Uses the globally available 'ws' npm package.
 */
'use strict';

const WebSocket = require('ws');

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.BENCH_PORT || process.env.PORT || '7682';
const URI = `ws://${HOST}:${PORT}/ws`;

function run() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URI, ['tty']);
    ws.binaryType = 'nodebuffer';

    let totalBytes = 0;
    let startTime = null;
    let endTime = null;
    let promptReceived = false;
    let done = false;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        ws.terminate();
        resolve({ error: 'timeout' });
      }
    }, 90000);

    ws.on('error', (err) => {
      if (!done) { done = true; clearTimeout(timeout); ws.terminate(); reject(err); }
    });

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
          startTime = process.hrtime.bigint();
          send('seq 1 500000\r');
        }
        return;
      }

      totalBytes += data.length - 1;

      if (text.includes('500000') && totalBytes > 2_000_000) {
        endTime = process.hrtime.bigint();
        if (!done) {
          done = true;
          clearTimeout(timeout);
          ws.terminate();

          const elapsedSec = Number(endTime - startTime) / 1e9;
          const mbs = (totalBytes / 1024 / 1024) / elapsedSec;
          resolve({
            test: 'throughput',
            total_bytes: totalBytes,
            elapsed_seconds: Math.round(elapsedSec * 1000) / 1000,
            throughput_mbs: Math.round(mbs * 100) / 100,
          });
        }
      }
    });
  });
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
