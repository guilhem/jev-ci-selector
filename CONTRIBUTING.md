# Contributing

Use Node.js 24 and Git. From a clean checkout, install dependencies without
running package lifecycle scripts:

```sh
npm ci --ignore-scripts
```

Before opening a pull request, run:

```sh
npm run build
npm run check
npm run eval:replay
```

Any source or dependency change that affects the action must include regenerated
`dist/` files. `npm run check:dist` verifies that the committed bundles and
license notices match the sources and lockfile. Dependabot pull requests are
expected to expose a stale bundle through this check until `npm run build` is
run and the generated files are committed; there is no bot commit step.

The action archive is intentionally kept in this repository. The current
checkout measures about 937 KiB compressed and 9.1 MiB unpacked; the evaluation
corpus accounts for about 6.8 MiB unpacked. GitHub downloads action archives
through its codeload path, so `.gitattributes export-ignore` does not reduce the
download. A separate distribution repository would add release maintenance for
a sub-second download improvement and is therefore out of scope.

Keep the selector isolated from project code in examples and tests. Changes to
the action contract, report schema or release process should update the relevant
documentation and replay fixtures in the same pull request.
