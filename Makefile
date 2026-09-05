.PHONY: install check build benchmark
install:
	npm ci
check:
	npx tsc --noEmit
	npm run lint
	node --test tests/*.test.ts
build:
	npm run build
benchmark:
	python tests/local-benchmark.py
