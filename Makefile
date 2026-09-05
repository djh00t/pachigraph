.PHONY: install check build benchmark
install:
	npm ci
check:
	npx tsc --noEmit
	npm run lint
	node --test tests/*.test.ts
	python3 -m unittest discover -s collector -q
	python3 -m unittest discover -s plugins/pachigraph/tests -q
build:
	npm run build
benchmark:
	python tests/local-benchmark.py
