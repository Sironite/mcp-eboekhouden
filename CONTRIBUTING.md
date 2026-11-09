# Contributing

Thanks for helping out. Issues and pull requests are welcome.

## Development

```sh
npm install           # also enables the git hooks in .githooks/
npm run lint
npm test              # Vitest; the HTTP layer is mocked
npm run test:scripts  # shell tests for the helper scripts
npm run build
```

- Never run tests or experiments against a real administration with write
  calls. Tests must not call the e-Boekhouden API.
- Never commit tokens, `.env.op` files with real values or bookkeeping data.
  The `pre-commit` hook and CI run gitleaks.
- Base behaviour on the official API documentation
  (`https://api.e-boekhouden.nl/openapi/v1.json`) and note observed behaviour
  in `docs/api-notes.md`.

## Pull requests

- Keep changes small and focused, with tests.
- `main` is protected: changes go through a pull request with a green `check`.
- Maintainers merge by fast-forwarding `main` to the pull request branch, so no
  merge commits are created:

  ```sh
  git fetch origin
  git checkout main
  git merge --ff-only origin/<pr-branch>
  git push origin main
  ```

  The `pre-push` hook only allows such fast-forwards of `main` to a commit that
  already exists on another remote branch. If `main` has moved on, rebase the
  pull request branch first (for Dependabot: comment `@dependabot rebase`).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
