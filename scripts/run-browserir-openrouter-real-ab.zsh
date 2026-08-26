#!/bin/zsh
set -euo pipefail

task_script_dir=${0:A:h}
task_workspace_root=${task_script_dir:h}
task_run_stamp=$(date -u '+%Y%m%dT%H%M%SZ')
task_receipt_path="$task_workspace_root/packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-$task_run_stamp.json"
task_journal_path="$task_workspace_root/packages/benchmark/output/benchmarks/browserir-openrouter-real-ab-$task_run_stamp.ndjson"

task_openrouter_key=$(security find-generic-password \
  -a BrowserIR \
  -s OPENROUTER_API_KEY \
  -w)
if [[ -z "$task_openrouter_key" ]]; then
  print -u2 -- 'OPENROUTER_API_KEY is empty in macOS Keychain.'
  exit 1
fi
trap 'unset task_openrouter_key' EXIT

typeset -a task_environment
task_environment=(
  "OPENROUTER_API_KEY=$task_openrouter_key"
  "BROWSERIR_REAL_AB_SUMMARY_PATH=$task_receipt_path"
  "BROWSERIR_REAL_AB_JOURNAL_PATH=$task_journal_path"
)
if [[ -n "${BROWSERIR_REAL_AB_PAIR_START:-}" ]]; then
  task_environment+=("BROWSERIR_REAL_AB_PAIR_START=$BROWSERIR_REAL_AB_PAIR_START")
fi
if [[ -n "${BROWSERIR_REAL_AB_PAIR_LIMIT:-}" ]]; then
  task_environment+=("BROWSERIR_REAL_AB_PAIR_LIMIT=$BROWSERIR_REAL_AB_PAIR_LIMIT")
fi
if [[ -n "${BROWSERIR_REAL_AB_MAX_RETRIES:-}" ]]; then
  task_environment+=("BROWSERIR_REAL_AB_MAX_RETRIES=$BROWSERIR_REAL_AB_MAX_RETRIES")
fi
if [[ -n "${BROWSERIR_REAL_AB_COST_STOP_USD:-}" ]]; then
  task_environment+=("BROWSERIR_REAL_AB_COST_STOP_USD=$BROWSERIR_REAL_AB_COST_STOP_USD")
fi

cd "$task_workspace_root"
env "${task_environment[@]}" \
  pnpm --filter @browserir/benchmark exec vite-node \
  src/browserir-openrouter-real-ab-smoke.ts

print -r -- "Receipt: $task_receipt_path"
print -r -- "Arm journal: $task_journal_path"
