
.PHONY: comments comments-test hooks
comments:
	node tools/comment-gate.cjs

comments-test:
	node --test tools/comment-gate.test.cjs

hooks:
	git config core.hooksPath .githooks
