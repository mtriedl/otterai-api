.PHONY: init-dev format test test-no-integration test-integration

init-dev:
	uv sync --dev

format:
	uv run black .

test:
	rm -f cov.xml ||:
	uv run pytest -s --cov=otterai \
		--cov-report=lcov:lcov.info \
		--cov-report=xml:cov.xml \
		tests/
	rm -f lcov.info .coverage ||:

test-no-integration:
	rm -f cov.xml ||:
	uv run pytest -s -m "not integration" --cov=otterai \
		--cov-report=lcov:lcov.info \
		--cov-report=xml:cov.xml \
		tests/
	rm -f lcov.info .coverage ||:

test-integration:
	rm -f cov.xml ||:
	uv run pytest -s -m "integration" --cov=otterai \
		--cov-report=lcov:lcov.info \
		--cov-report=xml:cov.xml \
		tests/
	rm -f lcov.info .coverage ||:
