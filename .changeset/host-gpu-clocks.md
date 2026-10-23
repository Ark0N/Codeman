---
"aicodeman": minor
---

Opt-in header readings after CPU and MEM. **GPU Stats** adds three items: GPU load, graphics memory and the GPU clock (each only when the host reports it). **CPU MHz** adds the live CPU clock. Both chips are in Settings, Header & Panels and off by default. `GET /api/system/stats` takes `?gpu=1` and `?cpumhz=1`; nothing is read unless the browser asks, and a host without the sensor simply shows nothing. GPU: NVIDIA through `nvidia-smi`, AMD through sysfs, and inside WSL any vendor (Intel included) through the Windows performance counters, which give load and memory in use but no GPU clock. Inside WSL the CPU clock is also read from Windows, since WSL's own figure never changes. The header also keeps polling its stats when no session is open, so CPU and MEM no longer sit at `--` until one is.
