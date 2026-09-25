# TEI failure modes

## SIGSEGV (exit code 139 / signal 11)

**Symptoms:** Binary starts (logs show "Starting HTTP server" then immediately crashes with SEGV).

**Causes:**
1. `LD_PRELOAD=/usr/local/libfakeintel.so` — this file doesn't exist in extracted layers. Remove the LD_PRELOAD entirely.
2. `MKL_ENABLE_INSTRUCTIONS=AVX512_E4` — on some hosts with AVX512f, this causes immediate crash. Switch to `AVX2`.

## libiomp5.so not found

**Symptoms:** `error while loading shared libraries: libiomp5.so: cannot open shared object file`

**Cause:** The binary links Intel OpenMP. In the ghcr.io cpu image, it ships as `libomp.so.5` under `/usr/lib/llvm-14/lib/`. Create a symlink: `libiomp5.so → libomp.so.5` in the library path.

## Backend does not support batch size > 8

**Symptoms:** TEI logs "Backend does not support a batch size > 8" and forces max_batch_requests=8.

**Cause:** The ONNX runtime backend has a hard limit. This is normal — TEI still handles concurrent requests through dynamic batching within this limit.

## Model download failure (first start)

**Symptoms:** TEI logs show download errors or stalls.

**Cause:** ~2.3 GB model download from HuggingFace Hub. Slow or flaky network. Restart the service to retry. The cache dir (`/var/lib/tei/data`) persists partial downloads.

## curl: (23) Failure writing output to destination

**Symptoms:** Layer download fails mid-way.

**Cause:** Writing to a directory owned by root while running as vellum. Use a writable directory or use sudo.
