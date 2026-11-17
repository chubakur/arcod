# Local model report

Not measured in this checkout yet. Run:

    node scripts/model-harness.mjs

It generates every body of the reference specs with the configured local model
(`ARC_MODEL`, default `qwen2.5-coder:7b`), runs each spec's own examples and
overwrites this file with the table: body coverage per example, examples
green/red, wall time. Without a reachable Ollama it prints one SKIP line and
leaves this file alone — an unmeasured model is written as unmeasured, never as
green.

What the numbers answer: whether a local model can carry the whole project, or
only the small examples. Body coverage shows where generation stopped; a red
example after full coverage means the body compiled but broke the contract,
which is the interesting failure.
