#!/usr/bin/env node
/**
 * Latency benchmark: measures keystroke-to-echo round-trip time.
 * Reports p50, p95, p99 in milliseconds.
 */
'use strict';

const WebSocket = require('ws');

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.BENCH_PORT || process.env.PORT || '7682';
const URI = `ws://${HOST}:${PORT}/ws`;
const SAMPLES = 50;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const latencies = [];

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(URI, ['tty']);
    ws.binaryType = 'nodebuffer';

    let promptReceived = false;
    let waitingEcho = false;
    let tStart = null;
    let sampleIndex = 0;
    let done = false;

    const finish = () => {
      if (!done) {
        done = true;
        ws.terminate();
        resolve();
      }
    };

    const timeout = setTimeout(() => { finish(); }, 60000);

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });

    const send = (text) => {
      const payload = Buffer.concat([Buffer.from([0x30]), Buffer.from(text)]);
      ws.send(payload);
    };

    ws.on('open', () => {
      const init = JSON.stringify({ AuthToken: '', columns: 80, rows: 24 });
      ws.send(Buffer.from(init));
      setTimeout(() => send('echo __BENCH_READY__\r'), 2000);
    });

    const sendNextSample = () => {
      if (sampleIndex >= SAMPLES) {
        clearTimeout(timeout);
        send('\x03');
        setTimeout(finish, 200);
        return;
      }
      const char = 'x';
      tStart = Number(process.hrtime.bigint()) / 1e6;
      waitingEcho = true;
      send(char);
    };

    ws.on('message', (data) => {
      if (done) return;
      if (!Buffer.isBuffer(data) || data.length < 2 || data[0] !== 0x30) return;

      const text = data.slice(1).toString('utf8');

      if (!promptReceived) {
        if (text.includes('__BENCH_READY__')) {
          promptReceived = true;
          setTimeout(sendNextSample, 100);
        }
        return;
      }

      if (waitingEcho && text.includes('x')) {
        const tEnd = Number(process.hrtime.bigint()) / 1e6;
        latencies.push(tEnd - tStart);
        waitingEcho = false;
        sampleIndex++;
        setTimeout(sendNextSample, 50);
      }
    });
  });

  if (latencies.length === 0) {
    return { error: 'no samples collected' };
  }

  latencies.sort((a, b) => a - b);
  const n = latencies.length;
  const p50 = latencies[Math.floor(n * 0.50)];
  const p95 = latencies[Math.floor(n * 0.95)];
  const p99 = latencies[Math.min(Math.floor(n * 0.99), n - 1)];

  return {
    test: 'latency',
    samples: n,
    p50_ms: Math.round(p50 * 100) / 100,
    p95_ms: Math.round(p95 * 100) / 100,
    p99_ms: Math.round(p99 * 100) / 100,
    min_ms: Math.round(Math.min(...latencies) * 100) / 100,
    max_ms: Math.round(Math.max(...latencies) * 100) / 100,
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
