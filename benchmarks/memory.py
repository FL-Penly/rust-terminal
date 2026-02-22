#!/usr/bin/env python3
"""Memory benchmark: measures server RSS under sustained large output"""

import asyncio
import json
import sys
import subprocess
import time

try:
    import websockets
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "-q"])
    import websockets

HOST = "localhost"
PORT = 7682


def get_server_rss_mb():
    """Get RSS of rust-terminal process in MB"""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "rust-terminal"], capture_output=True, text=True
        )
        pids = result.stdout.strip().split("\n")
        if not pids or not pids[0]:
            return None
        pid = pids[0]
        rss_result = subprocess.run(
            ["ps", "-o", "rss=", "-p", pid], capture_output=True, text=True
        )
        rss_kb = int(rss_result.stdout.strip())
        return rss_kb / 1024
    except Exception:
        return None


async def run_benchmark():
    uri = f"ws://{HOST}:{PORT}/ws"
    rss_samples = []

    initial_rss = get_server_rss_mb()
    if initial_rss:
        rss_samples.append(initial_rss)

    async def sample_rss():
        while True:
            rss = get_server_rss_mb()
            if rss:
                rss_samples.append(rss)
            await asyncio.sleep(0.5)

    sampler_task = asyncio.create_task(sample_rss())

    try:
        async with websockets.connect(
            uri, subprotocols=["tty"], max_size=20 * 1024 * 1024
        ) as ws:
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

            cmd = "head -c 5000000 /dev/zero | xxd\r"
            payload = bytes([0x30]) + cmd.encode()
            await ws.send(payload)

            bytes_received = 0

            async def collect_output():
                nonlocal bytes_received
                while True:
                    msg = await ws.recv()
                    if isinstance(msg, bytes) and len(msg) > 1 and msg[0] == 0x30:
                        bytes_received += len(msg) - 1
                        text = msg[1:].decode("utf-8", errors="replace")
                        if bytes_received > 4_000_000:
                            break

            try:
                await asyncio.wait_for(collect_output(), timeout=15)
            except asyncio.TimeoutError:
                pass

            await asyncio.sleep(1)

    except asyncio.TimeoutError:
        pass
    finally:
        sampler_task.cancel()

    if rss_samples:
        result = {
            "test": "memory",
            "initial_rss_mb": round(rss_samples[0], 1) if rss_samples else None,
            "peak_rss_mb": round(max(rss_samples), 1),
            "final_rss_mb": round(rss_samples[-1], 1),
            "samples": len(rss_samples),
        }
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps({"error": "no RSS samples collected"}))


if __name__ == "__main__":
    asyncio.run(run_benchmark())
