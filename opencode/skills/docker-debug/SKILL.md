---
name: docker-debug
description: Systematic diagnosis of Docker container problems — crashes, restart loops, networking, volumes and image builds
---

# Docker Debug skill

Use when containers crash, loop-restart, fail to build, or misbehave at runtime.

## Triage ladder (cheapest first)
1. **State**: `docker ps -a` → note STATUS (Exited code? Restarting? OOM?) and ports
2. **Logs**: `docker logs --tail 100 <c>` then `docker logs -f` while reproducing; look for the FIRST error, not the last
3. **Inspect**: `docker inspect <c>` → `.State.ExitCode`, `.State.OOMKilled`, `.State.Error`, health log, mounts vs expectations
4. **Inside** (if running): `docker exec <c> sh` → check process list, disk (`df -h`), env sanity, file presence
5. **Resources**: `docker stats --no-stream` → CPU/memory spikes; host `dmesg | grep -i oom` for kernel kills

## Common signatures
| Symptom | Likely cause |
|---|---|
| Exit 137 / OOMKilled true | memory limit hit — leak or too-low limit |
| Restarting loop | entrypoint crash — read logs from container start: `--tail all` |
| "No space left" | volume/disk full or dangling images: `docker system df` |
| Network refused between containers | same network? service DNS name not localhost |
| Volume data missing after rebuild | anonymous volume recreated — use named volumes |
| Build fails on COPY | .dockerignore swallowing files, or case-sensitivity |

## Guardrails
- Never delete named volumes without confirming with the user — that destroys data
- Prefer `docker compose logs/config` over raw docker when a compose project exists
