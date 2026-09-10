# Original Claude-build review

This directory publishes the assessment cited by [the project scope](../docs/PROJECT_SCOPE.md). It was written on **September 7, 2026**, before the replacement application was built, and is preserved unchanged. Publication on September 9 does not turn its dated product, provider, pricing or repository-status observations into current claims.

The reviewed implementation is **X-Decibel-Reader commit `a93d72349104418ca59c9845eb9b949d7f9c77e1`**, under `caucus-pulse/`, from branch `claude/twitter-data-capture-setup-kd9wvo`. Line references in the assessment refer to that implementation, not this repository's current `src/` files.

## Assessment and evidence

- [Original assessment and build brief](caucus-pulse-assessment.md)
- [Seven reproduced failure scenarios](reproduced-findings.json)
- [Offline reproduction script](reproduce-findings.mjs)
- [Original test transcript: all 12 tests passed](existing-tests.txt)
- [Comparison with the supplied code bundle: 23 matching sections](bundle-comparison.json)
- [Publication validation and original artifact hashes](publication-validation.json)

“Failed review” in the scope document refers to implementation findings. It does **not** mean the original 12 unit tests failed. Those tests passed; additional scenarios exposed gaps they did not cover. Seven offline scenarios were rerun in an isolated temporary copy for publication and matched the saved original results. No live provider requests were made.

The collection findings include advancing the checkpoint after a page limit or a later-page failure, which skips still-uncollected posts. This was reproduced with `sinceIdSupported: false`: removing the unsupported `since_id` request parameter alone does not fix checkpoint advancement in the fallback path. The budget reproduction shows a configured one-read cap allowing a response with two posts; the assessment also identifies the lack of reservation before each request and the mismatch between reporting and billing-day accounting.

Other reproduced cases cover discarded long text, accounts counted as members, meaningful phrases excluded, and spread missed across midnight. The assessment's remaining findings are source-review observations and design recommendations; they are not all separately reproduced experiments. This evidence does not prove that every recommendation was required for every deployment, that a complete rewrite was the only solution, or that the current application has passed live acceptance.

## Reproduce against the pinned original source

The original workspace had a local source snapshot in `review/reference/`. That snapshot is **not bundled in this publication**. The assessment's closing reference to an included snapshot describes that original workspace. Retrieve the pinned original repository to reproduce it; credentials, post archives, model assets and runtime environments are not part of the review publication.

From this repository's root, using an environment authorized to read the original private repository:

```sh
git clone --no-checkout https://github.com/4p42kvv8gp-web/X-Decibel-Reader.git review/reference
git -C review/reference checkout a93d72349104418ca59c9845eb9b949d7f9c77e1 -- caucus-pulse
node review/reproduce-findings.mjs
```

Use a fresh `review/reference` directory; inspect any existing directory rather than replacing it. The reproduction uses built-in Node modules, synthetic responses, a dummy token and temporary source copies. It writes `review/reproduced-findings.json` with its results and deletes the temporary copies. It does not run the original production collector or any workflow. The reference checkout is ignored by this repository.

The original 12-test transcript is retained as historical evidence. Those original tests require the original project's dependencies; their transcript should not be confused with this application's later 216-test regression result.
