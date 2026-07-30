# Contributing

Open an issue before changing the public tool contract. Small fixes may go
directly to a pull request.

The MCP server must remain a thin adapter over `@stratabook/sdk`. Do not add
parallel quote logic, private service names, infrastructure details, routing
composition, credentials, wallet handling, or transaction submission.

Run the repository checks before requesting review:

```sh
npm ci
npm run ci
```

Every release is built and published from this public repository. Version and
tool-contract changes require a maintainer-reviewed release note.
