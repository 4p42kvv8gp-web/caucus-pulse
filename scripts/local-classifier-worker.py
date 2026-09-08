"""Private, bounded JSON-lines inference worker. No HTTP listener or remote loading."""
import contextlib
import fcntl
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HOME"] = str(ROOT / "data/hf-local")
os.environ["TOKENIZERS_PARALLELISM"] = "false"
MAX_LINE_BYTES = 512000
MAX_PROMPT_TOKENS = 8192
MAX_OUTPUT_TOKENS = 2400


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    # Keep separate CLI/preview launches from loading two large models for this project.
    lock_path=ROOT/"data/classifier-runtime/worker.lock"
    lock_fd=os.open(lock_path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        emit({"ready":False,"code":"runtime-busy"})
        return
    spec = json.loads((ROOT / "config/local-classifier.json").read_text())
    if spec.get('engine')!='mlx-generative' or spec["generation"] != {"enableThinking": False, "maxPromptTokens": MAX_PROMPT_TOKENS, "maxOutputTokens": MAX_OUTPUT_TOKENS, "temperature": 0, "topP": 1.0, "topK": 0, "seed": 42, "deadlineSeconds": 170}:
        raise ValueError("Unsupported generation settings")
    for package, version in spec["runtime"].items():
        if importlib.metadata.version(package) != version:
            raise ValueError("Runtime version mismatch")
    # Importing the downloader exposes only local verification; its main never runs here.
    loader = importlib.util.spec_from_file_location("model_verifier", ROOT / "scripts/download-classifier-model.py")
    verifier = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(verifier)
    verifier.verify(verifier.DEST)
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        import mlx.core as mx
        from mlx_lm import load, stream_generate
        from mlx_lm.sample_utils import make_sampler
        mx.set_memory_limit(8 * 1024**3)
        mx.set_cache_limit(256 * 1024**2)
        model, tokenizer = load(str(verifier.DEST), tokenizer_config={"trust_remote_code": False, "local_files_only": True})
    emit({"ready": True, "maxPromptTokens": MAX_PROMPT_TOKENS, "maxOutputTokens": MAX_OUTPUT_TOKENS})
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
            return
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            if not isinstance(request_id, int) or not isinstance(request.get("messages"), list) or len(request["messages"]) != 2:
                raise ValueError("Invalid request")
            prompt = tokenizer.apply_chat_template(request["messages"], tokenize=False, add_generation_prompt=True, enable_thinking=spec["generation"]["enableThinking"])
            tokens = tokenizer.encode(prompt)
            if len(tokens) > MAX_PROMPT_TOKENS:
                emit({"id": request_id, "error": "input-limit"})
                continue
            started = time.monotonic()
            mx.random.seed(spec["generation"]["seed"])
            output = ""
            final = None
            mx.reset_peak_memory()
            with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                for item in stream_generate(model, tokenizer, tokens, max_tokens=MAX_OUTPUT_TOKENS, sampler=make_sampler(temp=spec["generation"]["temperature"],top_p=spec["generation"]["topP"],top_k=spec["generation"]["topK"])):
                    output += item.text
                    final = item
                    if len(output) > 100000 or time.monotonic() - started > 170:
                        break
            if final is None or final.finish_reason != "stop":
                emit({"id": request_id, "error": "output-limit"})
            else:
                emit({"id": request_id, "output": output, "metrics": {"promptTokens": len(tokens), "outputTokens": final.generation_tokens,
                    "elapsedMs": round((time.monotonic() - started) * 1000), "peakMemoryBytes": mx.get_peak_memory(), "finishReason": final.finish_reason}})
            mx.clear_cache()
        except Exception:
            emit({"id": request_id, "error": "inference-failed"})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"ready": False})
        sys.exit(1)
