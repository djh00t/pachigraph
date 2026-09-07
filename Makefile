.PHONY: install check build
install:
	npm ci
check:
	npx tsc --noEmit
	npm run lint
	node --test --test-concurrency=1 tests/*.test.ts
	python3 -m unittest discover -s collector -q
	python3 -m unittest discover -s plugins/pachigraph/tests -q
build:
	npm run build
