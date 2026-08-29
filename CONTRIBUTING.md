# Contributing

Keep changes focused, reproducible, and suitable for a three-day student
hackathon.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

For container-based Agent execution, follow
[docs/LOCAL_POC.md](docs/LOCAL_POC.md).

## Validate

```bash
npm run check
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

`npm run typecheck` covers tests as well as sources: `tsconfig.json` builds
`src` with `src/**/*.test.ts` excluded, and `tsconfig.test.json` type-checks
everything including the tests. Adding a required field to a shared type such
as `RunnerResult` or `ParsedEvents` therefore does surface in any fixture
still missing it — fix the fixture rather than widening the type.

## Pull requests

- Explain the behavior and reason for the change.
- Add tests for API, lifecycle, persistence, or Runtime changes.
- Update English documentation and `.env.example` when configuration changes.
- Use GitHub Flavored Markdown and relative repository links.
- Never commit credentials, local state, workspaces, build output, or Terraform
  state.
- Report security issues according to [SECURITY.md](SECURITY.md).
