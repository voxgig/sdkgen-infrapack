
.PHONY: comments comments-test deps deps-test defs defs-check hooks
comments:
	node tools/comment-gate.cjs

comments-test:
	node --test tools/comment-gate.test.cjs

deps:
	node tools/dep-gate.cjs

deps-test:
	node --test tools/dep-gate.test.cjs

defs:
	node tools/vendor-defs.cjs

defs-check:
	node tools/vendor-defs.cjs --check

hooks:
	git config core.hooksPath .githooks
