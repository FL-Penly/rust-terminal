#!/usr/bin/env python3
"""Latency benchmark: measures keystroke-to-echo round-trip time"""

import asyncio
import json
import time
import sys

try:
    import websockets
except ImportError:
    import subprocess

    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "-q"])
    import websockets

HOST = "localhost"
PORT = 7682
SAMPLES = 50


async def run_benchmark():
    uri = f"ws://{HOST}:{PORT}/ws"
    latencies = []

    async with websockets.connect(uri, subprotocols=["tty"]) as ws:
        init = json.dumps({"AuthToken": "", "columns": 80, "rows": 24})
        await ws.send(init.encode())

        async def wait_for_prompt():
            while True:
                msg = await ws.recv()
                if isinstance(msg, bytes) and len(msg) > 1 and msg[0] == 0x30:
                    text = msg[1:].decode("utf-8", errors="replace")
                    if "$" in text or "%" in text or "#" in text:
                        break

        try:
            await asyncio.wait_for(wait_for_prompt(), timeout=10)
        except asyncio.TimeoutError:
            pass

        for i in range(SAMPLES):
            char = b"x"
            payload = bytes([0x30]) + char

            t_start = time.perf_counter()
            await ws.send(payload)

            async def wait_for_echo():
                while True:
                    msg = await ws.recv()
                    if isinstance(msg, bytes) and len(msg) > 1 and msg[0] == 0x30:
                        text = msg[1:].decode("utf-8", errors="replace")
                        if "x" in text:
                            return time.perf_counter()

            try:
                t_end = await asyncio.wait_for(wait_for_echo(), timeout=2)
                latencies.append((t_end - t_start) * 1000)
            except asyncio.TimeoutError:
                pass

            await asyncio.sleep(0.05)

        ctrl_c = bytes([0x30, 0x03])
        await ws.send(ctrl_c)

    if latencies:
        latencies.sort()
        n = len(latencies)
        p50 = latencies[int(n * 0.50)]
        p95 = latencies[int(n * 0.95)]
        p99 = latencies[min(int(n * 0.99), n - 1)]
        result = {
            "test": "latency",
            "samples": n,
            "p50_ms": round(p50, 2),
            "p95_ms": round(p95, 2),
            "p99_ms": round(p99, 2),
            "min_ms": round(min(latencies), 2),
            "max_ms": round(max(latencies), 2),
        }
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps({"error": "no samples collected"}))


if __name__ == "__main__":
    asyncio.run(run_benchmark())
