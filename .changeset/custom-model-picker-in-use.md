---
'aicodeman': patch
---

The "Choose a model" picker now says which model is actually in use on an endpoint that cannot report it. Only llama-swap answers that question, so behind a gateway such as Bifrost (and behind a bare llama.cpp, Ollama or vLLM) nothing was marked and the list fell back to plain discovery order, apart from the one CLI that happened to have launched there before. A live session whose own injected endpoint is that host now promotes its model as **"In use by a session"**, under its own tag and behind llama-swap's own "Currently loaded" answer, reading only what Codeman injected rather than text scraped off a terminal, and never a stopped session. When genuinely nothing is known the picker says so instead of leaving an unmarked wall, and it stays quiet for an endpoint that merely failed to answer. Pinned by test/custom-model-run-menu-ui.test.ts.
