# ── 05-ollama.sh — optional free local models ──────────────────

function step_ollama() {
  echo "── [5/5] Ollama (local free models)"

  if ! command -v ollama >/dev/null 2>&1; then
    echo "Installing Ollama…"
    curl -fsSL https://ollama.com/install.sh | sh
  fi

  systemctl enable --now ollama >/dev/null 2>&1 || true

  # Wait for the server
  for _ in $(seq 1 30); do
    if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then break; fi
    sleep 2
  done

  if ! curl -s http://127.0.0.1:11434/api/tags | grep -q qwen2.5-coder:3b; then
    echo "Pulling qwen2.5-coder:3b (first run may take a while)…"
    ollama pull qwen2.5-coder:3b || echo "⚠️  pull failed — run manually: ollama pull qwen2.5-coder:3b"
  fi

  echo "✅ Ollama ready on :11434 (qwen2.5-coder:3b)"
}