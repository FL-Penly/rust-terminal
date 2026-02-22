#!/usr/bin/env python3
"""Throughput benchmark: measures MB/s for large output (seq 1 500000)"""

import asyncio
import json
import time
import sys

try:
    import websockets
except ImportError:
    print("Installing websockets...")
    import subprocess

    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "-q"])
    import websockets

HOST = "localhost"
PORT = 7682


async def run_benchmark():
    uri = f"ws://{HOST}:{PORT}/ws"
    total_bytes = 0
    start_time = None
    end_time = None
    prompt_count = 0

    async with websockets.connect(
        uri, subprotocols=["tty"], max_size=10 * 1024 * 1024
    ) as ws:
        # Send init
        init = json.dumps({"AuthToken": "", "columns": 80, "rows": 24})
        await ws.send(init.encode())

        # Wait for initial prompt
        async def wait_for_prompt():
            nonlocal prompt_count
            while True:
                msg = await ws.recv()
                if isinstance(msg, bytes) and len(msg) > 1 and msg[0] == 0x30:
                    text = msg[1:].decode("utf-8", errors="replace")
                    if "$" in text or "%" in text or "#" in text:
                        prompt_count += 1
                        if prompt_count >= 1:
                            break

        try:
            await asyncio.wait_for(wait_for_prompt(), timeout=10)
        except asyncio.TimeoutError:
            pass

        # Send throughput command
        cmd = "yes | head -c 3000000\r"
        payload = bytes([0x30]) + cmd.encode()
        start_time = time.perf_counter()
        await ws.send(payload)

        # Collect all output
        async def collect_output():
            nonlocal total_bytes, end_time
            idle_count = 0
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=3)
                    idle_count = 0
                except asyncio.TimeoutError:
                    idle_count += 1
                    if idle_count >= 2 and total_bytes > 50_000:
                        # No data for 6 seconds and we have some data
                        end_time = time.perf_counter()
                        return
                    continue

                if isinstance(msg, bytes) and len(msg) > 1 and msg[0] == 0x30:
                    data = msg[1:]
                    total_bytes += len(data)
                    text = data.decode("utf-8", errors="replace")
                    # Detect prompt return (command finished)
                    lines = text.split("\n")
                    for line in lines:
                        line = line.strip()
                        if (
                            line.endswith("$")
                            or line.endswith("%")
                            or line.endswith("#")
                        ):
                            if total_bytes > 50_000:
                                end_time = time.perf_counter()
                                return

        try:
            await asyncio.wait_for(collect_output(), timeout=60)
        except asyncio.TimeoutError:
            end_time = time.perf_counter()

    if start_time and end_time and total_bytes > 50_000:
        elapsed = end_time - start_time
        kbs = (total_bytes / 1024) / elapsed
        result = {
            "test": "throughput",
            "total_bytes": total_bytes,
            "elapsed_seconds": round(elapsed, 3),
            "throughput_kbs": round(kbs, 2),
        }
        print(json.dumps(result, indent=2))
    else:
        print(
            json.dumps({"error": "timeout or incomplete", "total_bytes": total_bytes})
        )


if __name__ == "__main__":
    asyncio.run(run_benchmark())
