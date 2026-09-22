
.PHONY: comments comments-test deps deps-test hooks
comments:
	node tools/comment-gate.cjs

comments-test:
	node --test tools/comment-gate.test.cjs

deps:
	node tools/dep-gate.cjs

deps-test:
	node --test tools/dep-gate.test.cjs

hooks:
	git config core.hooksPath .githooks
